/**
 * Async face-search jobs: accept → queue → worker → poll.
 *
 * - Selfie bytes are ephemeral (R2/tmp or local tmp); deleted after process.
 * - Job records store status + ranked photo results only (no embeddings, no selfie).
 * - Inference concurrency stays on the face service (MAX_SEARCH_CONCURRENCY).
 * - Gateway acceptance queue is bounded (MAX_SEARCH_QUEUE).
 *
 * Production durability: job metadata in D1 is durable; processing via waitUntil is
 * best-effort. Prefer Cloudflare Queues for multi-instance workers (see docs).
 */

import { faceServiceDetectEmbed } from "./face-client.js";
import {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MIN_QUALITY_SCORE,
  FACE_MODEL,
} from "./face-config.js";
import { isValidArcFaceEmbedding } from "./face-validate.js";

export const JOB_QUEUED = "queued";
export const JOB_PROCESSING = "processing";
export const JOB_COMPLETED = "completed";
export const JOB_FAILED = "failed";

const TEMP_PREFIX = "tmp/face-search/";

/** In-process busy retries (not durable — worker will re-pick via queue in production). */
const busyRetries = new Map();

/** Bounded local processor pool (waitUntil / setImmediate fan-in). */
const gatewayPending = [];
let gatewayActive = 0;

function gatewayConcurrency(env = {}) {
  const n = Number(env.GATEWAY_PROCESS_CONCURRENCY);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  // Keep local drain close to face-service search concurrency (default 2)
  const search = Number(env.MAX_SEARCH_CONCURRENCY);
  return Number.isFinite(search) && search > 0 ? Math.floor(search) : 2;
}

function pumpGateway(env = {}) {
  const limit = gatewayConcurrency(env);
  while (gatewayActive < limit && gatewayPending.length) {
    const task = gatewayPending.shift();
    gatewayActive += 1;
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        gatewayActive -= 1;
        pumpGateway(env);
      });
  }
}

/** Schedule job processing without spawning unbounded parallel workers. */
export function enqueueGatewayProcess(env, fn) {
  gatewayPending.push(fn);
  pumpGateway(env);
}

export function gatewayQueueSnapshot() {
  return { pending: gatewayPending.length, active: gatewayActive };
}

export function maxSearchQueue(env = {}) {
  const n = Number(env.MAX_SEARCH_QUEUE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3000;
}

export function jobTtlMs(env = {}) {
  const n = Number(env.FACE_SEARCH_JOB_TTL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10 * 60 * 1000;
}

export function duplicateCacheMs(env = {}) {
  const n = Number(env.FACE_SEARCH_DUP_TTL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000;
}

export function defaultPollAfterMs(env = {}) {
  const n = Number(env.FACE_SEARCH_POLL_AFTER_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 800;
}

export function maxJobWaitMs(env = {}) {
  const n = Number(env.FACE_SEARCH_MAX_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 60 * 1000;
}

function randomJobId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Safe JSON for browser — never includes embeddings or selfie data. */
export function publicJobView(job, env = {}) {
  if (!job) return null;
  const base = {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    pollAfterMs: defaultPollAfterMs(env),
    model: FACE_MODEL,
    version: FACE_EMBEDDING_VERSION,
    dim: FACE_DIM,
  };
  if (job.status === JOB_COMPLETED && job.result) {
    return {
      ...base,
      ...job.result,
      busy: false,
    };
  }
  if (job.status === JOB_FAILED) {
    return {
      ...base,
      error: job.error || "Face search failed.",
      busy: false,
    };
  }
  if (job.status === JOB_QUEUED || job.status === JOB_PROCESSING) {
    return {
      ...base,
      message:
        job.status === JOB_QUEUED
          ? "Finding your photos… You’re in the queue."
          : "Finding your photos…",
      busy: false,
    };
  }
  return base;
}

/**
 * Accept a selfie search: create durable job metadata, stash ephemeral bytes, schedule work.
 * Returns immediately with 202 payload fields (caller sets HTTP status).
 */
export async function acceptFaceSearchJob({
  store,
  env,
  imageBytes,
  contentType = "image/jpeg",
  filename = "selfie.jpg",
  clientKey = "",
  schedule,
}) {
  const maxBytes = Number(env.MAX_IMAGE_BYTES) || 8 * 1024 * 1024;
  const bytes =
    imageBytes instanceof ArrayBuffer
      ? new Uint8Array(imageBytes)
      : imageBytes instanceof Uint8Array
        ? imageBytes
        : new Uint8Array(await new Blob([imageBytes]).arrayBuffer());

  if (!bytes.byteLength) {
    throw Object.assign(new Error("Upload a selfie image."), { status: 400 });
  }
  if (bytes.byteLength > maxBytes) {
    throw Object.assign(new Error("Image is too large. Use a normal phone selfie."), {
      status: 413,
    });
  }

  const imageSha256 = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const dupMs = duplicateCacheMs(env);
  const recent = await store.findRecentFaceSearchJobBySha(imageSha256, dupMs);
  if (recent && (recent.status === JOB_COMPLETED || recent.status === JOB_QUEUED || recent.status === JOB_PROCESSING)) {
    return {
      accepted: true,
      duplicate: true,
      httpStatus: recent.status === JOB_COMPLETED ? 200 : 202,
      body: publicJobView(recent, env),
    };
  }

  const active = await store.countActiveFaceSearchJobs();
  const queueCap = maxSearchQueue(env);
  if (active >= queueCap) {
    throw Object.assign(
      new Error(
        "We're processing many requests right now. Please try again in a few seconds."
      ),
      { status: 503, retryAfter: 5 }
    );
  }

  const now = Date.now();
  const id = randomJobId();
  const job = {
    id,
    status: JOB_QUEUED,
    imageSha256,
    clientKey: String(clientKey || "").slice(0, 64),
    error: null,
    result: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + jobTtlMs(env)).toISOString(),
  };

  await store.createFaceSearchJob(job);
  const skipProcess =
    env.FACE_SEARCH_SKIP_PROCESS === "1" || env.FACE_SEARCH_SKIP_PROCESS === "true";
  const synthetic =
    env.FACE_SEARCH_SYNTHETIC === "1" || env.FACE_SEARCH_SYNTHETIC === "true";

  if (!skipProcess && !synthetic) {
    await store.putFaceSearchTempImage(id, bytes, contentType || "image/jpeg");
  }

  const run = () =>
    synthetic
      ? processFaceSearchJobSynthetic(store, env, id)
      : processFaceSearchJob(store, env, id, filename);

  if (skipProcess) {
    // Accept-only / load-test mode: enqueue metadata but do not call buffalo_l
  } else if (typeof schedule === "function") {
    schedule(() => enqueueGatewayProcess(env, run));
  } else {
    enqueueGatewayProcess(env, run);
  }

  return {
    accepted: true,
    duplicate: false,
    httpStatus: 202,
    body: publicJobView(job, env),
  };
}

/**
 * Synthetic drain worker — no buffalo_l. Used to prove 3000-job queue/poll behavior.
 */
export async function processFaceSearchJobSynthetic(store, env, jobId) {
  const job = await store.getFaceSearchJob(jobId);
  if (!job) return;
  if (job.status === JOB_COMPLETED || job.status === JOB_FAILED) return;
  if (job.expiresAt && Date.parse(job.expiresAt) < Date.now()) {
    await store.updateFaceSearchJob(jobId, {
      status: JOB_FAILED,
      error: "Search expired. Please try again.",
    });
    return;
  }

  await store.updateFaceSearchJob(jobId, { status: JOB_PROCESSING });
  const delayMs = Number(env.FACE_SEARCH_SYNTHETIC_MS) || 50;
  await new Promise((r) => setTimeout(r, Math.max(1, delayMs)));
  await store.updateFaceSearchJob(jobId, {
    status: JOB_COMPLETED,
    error: null,
    result: {
      matches: [],
      uncertain: [],
      indexedCount: 0,
      photoCount: 0,
      synthetic: true,
      model: FACE_MODEL,
      version: FACE_EMBEDDING_VERSION,
      dim: FACE_DIM,
    },
  });
  await store.deleteFaceSearchTempImage(jobId).catch(() => {});
}

/**
 * Worker: load ephemeral selfie → buffalo_l → D1 match → persist result → delete selfie.
 */
export async function processFaceSearchJob(store, env, jobId, filename = "selfie.jpg") {
  const job = await store.getFaceSearchJob(jobId);
  if (!job) return;
  if (job.status === JOB_COMPLETED || job.status === JOB_FAILED) return;
  if (job.expiresAt && Date.parse(job.expiresAt) < Date.now()) {
    await store.updateFaceSearchJob(jobId, {
      status: JOB_FAILED,
      error: "Search expired. Please try again.",
    });
    await store.deleteFaceSearchTempImage(jobId).catch(() => {});
    return;
  }

  await store.updateFaceSearchJob(jobId, { status: JOB_PROCESSING });

  let temp = null;
  try {
    temp = await store.getFaceSearchTempImage(jobId);
    if (!temp?.body) {
      throw Object.assign(new Error("Search image expired. Please try again."), { status: 410 });
    }

    const blob = new Blob([temp.body], { type: temp.contentType || "image/jpeg" });
    let detect;
    try {
      detect = await faceServiceDetectEmbed(env, blob, filename, { lane: "search" });
    } catch (error) {
      if (error.status === 429 || error.status === 503) {
        const retries = busyRetries.get(jobId) || 0;
        if (retries < 8) {
          busyRetries.set(jobId, retries + 1);
          await store.updateFaceSearchJob(jobId, {
            status: JOB_QUEUED,
            error: null,
          });
          const delay = Math.min(8000, (Number(error.retryAfter) || 3) * 1000);
          await new Promise((r) => setTimeout(r, delay));
          return processFaceSearchJob(store, env, jobId, filename);
        }
        busyRetries.delete(jobId);
        throw Object.assign(
          new Error(
            "We're processing many requests right now. Please try again in a few seconds."
          ),
          { status: 503 }
        );
      }
      throw error;
    }

    const faces = detect.faces || [];
    if (!faces.length) {
      throw Object.assign(
        new Error("No clear face found. Use a front-facing selfie with good lighting."),
        { status: 400 }
      );
    }
    const best = faces[0];
    if ((best.quality_score ?? 1) < FACE_MIN_QUALITY_SCORE) {
      throw Object.assign(new Error("Selfie quality is too low. Try again."), { status: 400 });
    }

    const descriptors = faces
      .slice(0, 3)
      .map((f) => f.embedding)
      .filter((e) => isValidArcFaceEmbedding(e));
    if (!descriptors.length) {
      throw Object.assign(new Error("Face service returned invalid embeddings."), { status: 502 });
    }

    const searchResult = await store.searchFaces(descriptors, "");
    // Drop any accidental embedding fields from match payloads
    const scrub = (rows) =>
      (rows || []).map((row) => {
        const { embedding, embeddings, descriptor, descriptors, faces: _f, ...rest } = row;
        return rest;
      });

    await store.updateFaceSearchJob(jobId, {
      status: JOB_COMPLETED,
      error: null,
      result: {
        matches: scrub(searchResult.matches),
        uncertain: scrub(searchResult.uncertain),
        indexedCount: searchResult.indexedCount,
        photoCount: searchResult.photoCount,
        thresholds: searchResult.thresholds,
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
        dim: FACE_DIM,
      },
    });
    busyRetries.delete(jobId);
  } catch (error) {
    busyRetries.delete(jobId);
    await store.updateFaceSearchJob(jobId, {
      status: JOB_FAILED,
      error: error?.message || "Face search failed.",
    });
  } finally {
    await store.deleteFaceSearchTempImage(jobId).catch(() => {});
  }
}
