/**
 * Durable Cloudflare Queue consumer for face search + face index.
 *
 * Deploy as a separate Worker (Pages cannot consume Queues):
 *   npx wrangler deploy -c wrangler.face-consumer.toml
 *
 * Idempotent: D1 atomic claim; completed/failed jobs are acked without re-inference.
 * Transient errors → message.retry(); permanent → mark failed, delete selfie, ack.
 */

import { createStore } from "../lib/store.js";
import {
  JOB_COMPLETED,
  JOB_EXPIRED,
  JOB_FAILED,
  JOB_PROCESSING,
  JOB_QUEUED,
  processFaceSearchJob,
} from "../lib/face-search-job.js";
import {
  isPermanentFaceError,
  isTransientFaceError,
  SEARCH_QUEUE_NAME,
  INDEX_QUEUE_NAME,
} from "../lib/face-queue.js";

function originFromEnv(env) {
  return (env.PUBLIC_ORIGIN || "https://gallery-752.pages.dev").replace(/\/$/, "");
}

async function handleSearchMessage(body, env) {
  const jobId = body?.jobId;
  if (!jobId) {
    throw Object.assign(new Error("Malformed queue message: missing jobId."), {
      status: 400,
      permanent: true,
    });
  }

  const store = createStore(env, originFromEnv(env));
  const existing = await store.getFaceSearchJob(jobId);
  if (!existing) {
    // Nothing to do — drop
    return { outcome: "missing" };
  }
  if (
    existing.status === JOB_COMPLETED ||
    existing.status === JOB_FAILED ||
    existing.status === JOB_EXPIRED
  ) {
    return { outcome: "already-done", status: existing.status };
  }
  if (existing.expiresAt && Date.parse(existing.expiresAt) < Date.now()) {
    await store.updateFaceSearchJob(jobId, {
      status: JOB_EXPIRED,
      error: "Search expired. Please try again.",
    });
    await store.deleteFaceSearchTempImage(jobId).catch(() => {});
    return { outcome: "expired" };
  }

  const claim = await store.claimFaceSearchJob(jobId);
  if (!claim.claimed) {
    const again = await store.getFaceSearchJob(jobId);
    if (
      again &&
      (again.status === JOB_COMPLETED ||
        again.status === JOB_FAILED ||
        again.status === JOB_EXPIRED)
    ) {
      return { outcome: "already-done", status: again.status };
    }
    // Another consumer holds a fresh claim — retry later
    throw Object.assign(new Error("Job claim contended; retry."), {
      status: 503,
      transient: true,
    });
  }

  try {
    await processFaceSearchJob(store, env, jobId, "selfie.jpg", {
      alreadyClaimed: true,
      preferQueueErrors: true,
    });
    const finalJob = await store.getFaceSearchJob(jobId);
    if (finalJob?.status === JOB_QUEUED) {
      // processFaceSearchJob re-queued for capacity — ask CF to retry delivery
      throw Object.assign(new Error("Face service busy; retry."), {
        status: 503,
        transient: true,
      });
    }
    return { outcome: "processed", status: finalJob?.status };
  } catch (error) {
    if (isPermanentFaceError(error) || error.permanent) {
      await store.updateFaceSearchJob(jobId, {
        status: JOB_FAILED,
        error: error.message || "Face search failed.",
      });
      await store.deleteFaceSearchTempImage(jobId).catch(() => {});
      return { outcome: "failed-permanent" };
    }
    throw error;
  }
}

async function handleIndexMessage(body, env) {
  const photoId = body?.photoId;
  if (!photoId) {
    throw Object.assign(new Error("Malformed queue message: missing photoId."), {
      status: 400,
      permanent: true,
    });
  }
  const store = createStore(env, originFromEnv(env));
  try {
    await store.indexPhotoWithFaceService(photoId, env, { lane: "index" });
    return { outcome: "indexed" };
  } catch (error) {
    if (isPermanentFaceError(error) || error.permanent) {
      return { outcome: "index-failed-permanent", error: error.message };
    }
    throw error;
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = typeof message.body === "string" ? JSON.parse(message.body) : message.body;
      try {
        const type = body?.type || (body?.jobId ? "face-search" : body?.photoId ? "face-index" : "");
        if (type === "face-search" || batch.queue === SEARCH_QUEUE_NAME) {
          await handleSearchMessage(body, env);
          message.ack();
          continue;
        }
        if (type === "face-index" || batch.queue === INDEX_QUEUE_NAME) {
          await handleIndexMessage(body, env);
          message.ack();
          continue;
        }
        // Unknown — do not retry forever
        message.ack();
      } catch (error) {
        if (isPermanentFaceError(error) || error.permanent) {
          message.ack();
          continue;
        }
        if (isTransientFaceError(error) || error.transient) {
          message.retry();
          continue;
        }
        // Default: retry transient-looking unknowns a few times via CF max_retries → DLQ
        message.retry();
      }
    }
  },
};
