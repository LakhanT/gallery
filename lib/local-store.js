import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, pbkdf2Sync } from "node:crypto";
import {
  createSalt,
  createSessionToken,
  getAdminPassword,
  getSessionToken,
  getUserSessionToken,
  hashPassword,
  hashValue,
  publicUser,
  sessionExpiryIso,
} from "./auth.js";
import { rankFaceMatches, splitMatches, getFaceThresholds } from "./face-match.js";
import { FACE_DIM, FACE_EMBEDDING_VERSION, FACE_MODEL } from "./face-config.js";
import { faceServiceDetectEmbed } from "./face-client.js";
import {
  assertSearchableFaceWrite,
  sanitizeFacesForStorage,
  validateApprovalEmbeddings,
} from "./face-validate.js";

const DATA_DIR = path.join(process.cwd(), ".data");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const DB_PATH = path.join(DATA_DIR, "db.json");
const FACE_SEARCH_JOBS_PATH = path.join(DATA_DIR, "face-search-jobs.json");
const GALLERY_PREFIX = "gallery/";

function safeName(name) {
  const base = (name || "photo.jpg").split(/[/\\]/).pop();
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 80) || "photo.jpg";
}

function cleanDisplayName(name) {
  const trimmed = String(name || "").trim().replace(/[/\\]/g, "");
  if (!trimmed) {
    throw new Error("Enter a name.");
  }
  return trimmed.slice(0, 80);
}

async function ensureDataDir() {
  await mkdir(PHOTOS_DIR, { recursive: true });
}

async function readDb() {
  await ensureDataDir();
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return {
      photos: Array.isArray(data.photos) ? data.photos : [],
      names: data.names && typeof data.names === "object" ? data.names : {},
      faceRecords: data.faceRecords && typeof data.faceRecords === "object" ? data.faceRecords : {},
      faceIndexStatus:
        data.faceIndexStatus && typeof data.faceIndexStatus === "object" ? data.faceIndexStatus : {},
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      approvals: Array.isArray(data.approvals) ? data.approvals : [],
      users: Array.isArray(data.users) ? data.users : [],
      userSessions: Array.isArray(data.userSessions) ? data.userSessions : [],
      consents: Array.isArray(data.consents) ? data.consents : [],
    };
  } catch {
    return {
      photos: [],
      names: {},
      faceRecords: {},
      faceIndexStatus: {},
      sessions: [],
      approvals: [],
      users: [],
      userSessions: [],
      consents: [],
    };
  }
}

async function readFaceSearchJobs() {
  await ensureDataDir();
  try {
    const raw = await readFile(FACE_SEARCH_JOBS_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

async function writeFaceSearchJobs(jobs) {
  await ensureDataDir();
  await writeFile(FACE_SEARCH_JOBS_PATH, JSON.stringify({ jobs }), "utf8");
}

/** Simple mutex so concurrent accepts do not clobber the jobs file. */
let jobsLock = Promise.resolve();
function withJobsLock(fn) {
  const run = jobsLock.then(fn, fn);
  jobsLock = run.catch(() => {});
  return run;
}

async function writeDb(data) {
  await ensureDataDir();
  await writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

function decodeDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("Choose a photo to upload.");
  }
  const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("That file is not a photo.");
  }
  const type = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("That photo is empty.");
  }
  return { type, buffer };
}

function randomId() {
  return randomBytes(16).toString("hex");
}

async function localHash(value) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    return hashValue(value);
  }
  return createHash("sha256").update(String(value)).digest("hex");
}

export function createLocalStore(origin, env = {}) {
  return {
    async getGallery() {
      const db = await readDb();
      const photos = [...db.photos]
        .filter((item) => !item.deletedAt)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((item) => ({
          id: item.id,
          url: item.url,
          name: db.names[item.id] || item.name,
          createdAt: item.createdAt,
          ownerId: item.ownerId || null,
        }));
      return { photos, names: db.names };
    },

    async listAdminPhotos({ includeHidden = true } = {}) {
      const db = await readDb();
      return [...db.photos]
        .filter((item) => (includeHidden ? true : !item.deletedAt))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((item) => ({
          id: item.id,
          url: item.url,
          name: db.names[item.id] || item.name,
          createdAt: item.createdAt,
          ownerId: item.ownerId || null,
          hidden: Boolean(item.deletedAt),
          deletedAt: item.deletedAt || null,
        }));
    },

    async hidePhoto(target) {
      if (!target) throw new Error("Missing photo.");
      const db = await readDb();
      const photo = db.photos.find((item) => item.id === target || item.url === target);
      if (!photo) throw Object.assign(new Error("Photo not found."), { status: 404 });
      if (!photo.deletedAt) {
        photo.deletedAt = new Date().toISOString();
        await writeDb(db);
      }
      return { id: photo.id, url: photo.url, hidden: true, deletedAt: photo.deletedAt };
    },

    async restorePhoto(target) {
      if (!target) throw new Error("Missing photo.");
      const db = await readDb();
      const photo = db.photos.find((item) => item.id === target || item.url === target);
      if (!photo) throw Object.assign(new Error("Photo not found."), { status: 404 });
      photo.deletedAt = null;
      await writeDb(db);
      return { id: photo.id, url: photo.url, hidden: false, deletedAt: null };
    },

    async addPhoto({ name, dataUrl }, ownerId = null) {
      const { type, buffer } = decodeDataUrl(dataUrl);
      const r2Key = `${GALLERY_PREFIX}${Date.now()}-${safeName(name)}`;
      const filePath = path.join(PHOTOS_DIR, r2Key.replace(/\//g, "__"));
      await writeFile(filePath, buffer);

      const url = `${origin}/media/${r2Key}`;
      const photo = {
        id: url,
        url,
        name: name || "photo.jpg",
        createdAt: new Date().toISOString(),
        r2Key,
        contentType: type,
        filePath,
        ownerId,
        deletedAt: null,
      };

      const db = await readDb();
      db.photos.push(photo);
      await writeDb(db);
      return {
        id: photo.id,
        url: photo.url,
        name: photo.name,
        createdAt: photo.createdAt,
        ownerId,
        _faceIndexBytes: buffer,
        _faceIndexContentType: type,
      };
    },

    async renamePhoto(id, name, _actor = null) {
      if (!id) {
        throw new Error("Missing photo.");
      }
      const next = cleanDisplayName(name);
      const db = await readDb();
      const photo = db.photos.find((item) => item.id === id);
      if (photo) {
        photo.name = next;
      }
      db.names[id] = next;
      await writeDb(db);
      return next;
    },

    async removePhoto(target, _actor = null) {
      if (!target) {
        throw new Error("Missing photo.");
      }
      const db = await readDb();
      const photo = db.photos.find((item) => item.id === target || item.url === target);
      if (photo?.filePath) {
        await rm(photo.filePath, { force: true });
      }
      db.photos = db.photos.filter((item) => item.id !== target && item.url !== target);
      delete db.names[target];
      delete db.faceRecords[target];
      db.approvals = db.approvals.filter((item) => item.candidatePhotoId !== target);
      await writeDb(db);
    },

    async getFaceIndex() {
      const db = await readDb();
      const index = {};
      for (const [photoId, record] of Object.entries(db.faceRecords)) {
        const ver = Number(record.embeddingVersion ?? record.version) || 0;
        if (ver !== FACE_EMBEDDING_VERSION) continue;
        const cleaned = (record.faces || [])
          .map((face) => {
            const embedding =
              (Array.isArray(face.embedding) && face.embedding.length === FACE_DIM && face.embedding) ||
              (Array.isArray(face.descriptor) && face.descriptor.length === FACE_DIM && face.descriptor) ||
              null;
            if (!embedding) return null;
            return { ...face, embedding, descriptor: embedding, descriptors: [embedding] };
          })
          .filter(Boolean);
        index[photoId] = { id: photoId, faces: cleaned, version: ver, model: record.model };
      }
      return index;
    },

    async getFaceVersions() {
      const db = await readDb();
      const versions = {};
      for (const [photoId, record] of Object.entries(db.faceRecords)) {
        versions[photoId] = Number(record.embeddingVersion ?? record.version) || 0;
      }
      return versions;
    },

    async searchFaces(queryDescriptors, queryPreview = "") {
      const queries = (queryDescriptors || []).filter(
        (item) => Array.isArray(item) && item.length === FACE_DIM
      );
      if (!queries.length) {
        throw new Error("No ArcFace embeddings to search (expected 512-d).");
      }
      const gallery = await this.getGallery();
      const index = await this.getFaceIndex();
      const entries = gallery.photos.map((photo) => ({
        id: photo.id,
        url: photo.url,
        name: photo.name,
        faces: index[photo.id]?.faces || [],
      }));
      const ranked = rankFaceMatches(queries, entries);
      const { matches, uncertain } = splitMatches(ranked.slice(0, 80));
      if (uncertain.length) {
        await this.createApprovals(
          uncertain.slice(0, 12).map((row) => ({
            queryPreview: queryPreview || "",
            queryDescriptors: queries,
            candidatePhotoId: row.id,
            candidateUrl: row.url,
            candidateName: row.name,
            candidatePreview: row.url,
            distance: row.distance,
          }))
        );
      }
      return {
        matches: matches.map((row) => ({
          id: row.id,
          similarity: row.similarity,
          distance: row.distance,
          name: row.name,
          url: row.url,
          matchedFaceBbox: row.matchedFaceBbox,
          category: row.category,
        })),
        uncertain: uncertain.map((row) => ({
          id: row.id,
          similarity: row.similarity,
          distance: row.distance,
          name: row.name,
          url: row.url,
          matchedFaceBbox: row.matchedFaceBbox,
          category: row.category,
        })),
        indexedCount: Object.keys(index).filter((id) => index[id].faces.length).length,
        photoCount: gallery.photos.length,
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
      };
    },

    async countActiveFaceSearchJobs() {
      return withJobsLock(async () => {
        const jobs = await readFaceSearchJobs();
        const now = Date.now();
        return jobs.filter(
          (j) =>
            (j.status === "queued" || j.status === "processing") &&
            (!j.expiresAt || Date.parse(j.expiresAt) > now)
        ).length;
      });
    },

    async createFaceSearchJob(job) {
      return withJobsLock(async () => {
        const jobs = await readFaceSearchJobs();
        jobs.push({ ...job });
        const now = Date.now();
        const pruned = jobs
          .filter((j) => !j.expiresAt || Date.parse(j.expiresAt) > now - 60_000)
          .slice(-5000);
        await writeFaceSearchJobs(pruned);
        return job;
      });
    },

    async getFaceSearchJob(id) {
      return withJobsLock(async () => {
        const jobs = await readFaceSearchJobs();
        return jobs.find((j) => j.id === id) || null;
      });
    },

    async updateFaceSearchJob(id, patch) {
      return withJobsLock(async () => {
        const jobs = await readFaceSearchJobs();
        const idx = jobs.findIndex((j) => j.id === id);
        if (idx < 0) return null;
        jobs[idx] = {
          ...jobs[idx],
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        await writeFaceSearchJobs(jobs);
        return jobs[idx];
      });
    },

    async setFaceSearchJobR2Key(id, objectKey) {
      return this.updateFaceSearchJob(id, { r2ObjectKey: objectKey });
    },

    async claimFaceSearchJob(id, { staleMs = 120_000 } = {}) {
      return withJobsLock(async () => {
        const jobs = await readFaceSearchJobs();
        const idx = jobs.findIndex((j) => j.id === id);
        if (idx < 0) return { claimed: false };
        const job = jobs[idx];
        const now = Date.now();
        const staleBefore = now - staleMs;
        const claimedAtMs = job.claimedAt ? Date.parse(job.claimedAt) : 0;
        const canClaim =
          job.status === "queued" ||
          (job.status === "processing" && (!claimedAtMs || claimedAtMs < staleBefore));
        if (!canClaim) return { claimed: false };
        const at = new Date(now).toISOString();
        jobs[idx] = {
          ...job,
          status: "processing",
          attemptCount: (Number(job.attemptCount) || 0) + 1,
          claimedAt: at,
          updatedAt: at,
          error: null,
        };
        await writeFaceSearchJobs(jobs);
        return { claimed: true, at };
      });
    },

    async findRecentFaceSearchJobBySha(imageSha256, withinMs) {
      if (!imageSha256) return null;
      return withJobsLock(async () => {
        const jobs = await readFaceSearchJobs();
        const since = Date.now() - withinMs;
        const matches = jobs
          .filter(
            (j) =>
              j.imageSha256 === imageSha256 &&
              Date.parse(j.createdAt) >= since &&
              ["queued", "processing", "completed"].includes(j.status)
          )
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return matches[0] || null;
      });
    },

    async putFaceSearchTempImage(jobId, bytes, contentType = "image/jpeg") {
      const dir = path.join(DATA_DIR, "tmp", "face-search");
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${jobId}.bin`);
      const body = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      await writeFile(filePath, body);
      await writeFile(`${filePath}.meta.json`, JSON.stringify({ contentType }), "utf8");
      return filePath;
    },

    async getFaceSearchTempImage(jobId) {
      const filePath = path.join(DATA_DIR, "tmp", "face-search", `${jobId}.bin`);
      try {
        const body = await readFile(filePath);
        let contentType = "image/jpeg";
        try {
          const meta = JSON.parse(await readFile(`${filePath}.meta.json`, "utf8"));
          contentType = meta.contentType || contentType;
        } catch {
          /* ignore */
        }
        return { body, contentType };
      } catch {
        return null;
      }
    },

    async deleteFaceSearchTempImage(jobId) {
      const filePath = path.join(DATA_DIR, "tmp", "face-search", `${jobId}.bin`);
      await rm(filePath, { force: true });
      await rm(`${filePath}.meta.json`, { force: true });
    },

    async getReindexProgress() {
      const gallery = await this.getGallery();
      const versions = await this.getFaceVersions();
      const db = await readDb();
      let indexed = 0;
      let withFaces = 0;
      let noFaces = 0;
      let failed = 0;
      const failedItems = [];
      for (const photo of gallery.photos) {
        const st = db.faceIndexStatus?.[photo.id];
        const ver = versions[photo.id] || 0;
        if (st?.status === "failed") {
          failed += 1;
          failedItems.push({
            id: photo.id,
            lastError: st.lastError,
            retryCount: st.retryCount || 0,
          });
          continue;
        }
        if (st?.status === "completed" || ver === FACE_EMBEDDING_VERSION) {
          indexed += 1;
          const faces = db.faceRecords[photo.id]?.faces || [];
          if (faces.length) withFaces += 1;
          else noFaces += 1;
        }
      }
      return {
        total: gallery.photos.length,
        indexed,
        withFaces,
        noFaces,
        failed,
        pending: Math.max(0, gallery.photos.length - indexed - failed),
        failedItems: failedItems.slice(0, 20),
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
        thresholds: getFaceThresholds(),
      };
    },

    async listPhotosNeedingReindex(limit = 10, { includeFailed = false } = {}) {
      const gallery = await this.getGallery();
      const versions = await this.getFaceVersions();
      const db = await readDb();
      return gallery.photos
        .filter((photo) => {
          const st = db.faceIndexStatus?.[photo.id];
          if (st?.status === "completed") return false;
          if ((versions[photo.id] || 0) === FACE_EMBEDDING_VERSION && st?.status !== "failed") {
            return false;
          }
          if (st?.status === "failed") return includeFailed;
          return true;
        })
        .slice(0, Math.min(50, Math.max(1, limit)));
    },

    async retryFailedFaceIndexes() {
      const db = await readDb();
      let reset = 0;
      for (const [id, st] of Object.entries(db.faceIndexStatus || {})) {
        if (st.status === "failed") {
          st.status = "pending";
          st.lastError = null;
          st.updatedAt = new Date().toISOString();
          reset += 1;
        }
      }
      await writeDb(db);
      return { reset };
    },

    async indexPhotoWithFaceService(photoId, envRef = {}, options = {}) {
      const db = await readDb();
      const photo = db.photos.find((item) => item.id === photoId || item.url === photoId);
      if (!photo) throw Object.assign(new Error("Photo not found."), { status: 404 });
      const prev = db.faceIndexStatus?.[photo.id] || { retryCount: 0 };
      db.faceIndexStatus = db.faceIndexStatus || {};
      db.faceIndexStatus[photo.id] = {
        status: "processing",
        retryCount: prev.retryCount || 0,
        lastError: null,
        faceCount: prev.faceCount || 0,
        updatedAt: new Date().toISOString(),
      };
      await writeDb(db);

      try {
        const bytes =
          options.bytes ||
          (await readFile(photo.filePath));
        const contentType = options.contentType || photo.contentType || "image/jpeg";
        const result = await faceServiceDetectEmbed(
          envRef,
          bytes instanceof Blob ? bytes : new Blob([bytes], { type: contentType }),
          photo.name || "photo.jpg",
          { lane: options.lane === "search" ? "search" : "index" }
        );
        const faces = sanitizeFacesForStorage(
          (result.faces || []).map((face) => ({
            embedding: face.embedding,
            bbox: face.bbox,
            detection_score: face.detection_score,
            quality_score: face.quality_score,
          }))
        );
        await this.upsertFaceRecord(photo.id, faces, FACE_EMBEDDING_VERSION, null, {
          model: FACE_MODEL,
          embeddingVersion: FACE_EMBEDDING_VERSION,
        });
        const db2 = await readDb();
        db2.faceIndexStatus = db2.faceIndexStatus || {};
        db2.faceIndexStatus[photo.id] = {
          status: "completed",
          retryCount: 0,
          lastError: null,
          faceCount: faces.length,
          updatedAt: new Date().toISOString(),
        };
        await writeDb(db2);
        return {
          id: photo.id,
          status: "completed",
          faceCount: faces.length,
          rejected: result.rejected || 0,
          model: FACE_MODEL,
          version: FACE_EMBEDDING_VERSION,
        };
      } catch (error) {
        const db3 = await readDb();
        db3.faceIndexStatus = db3.faceIndexStatus || {};
        db3.faceIndexStatus[photo.id] = {
          status: "failed",
          retryCount: (prev.retryCount || 0) + 1,
          lastError: String(error.message || error).slice(0, 500),
          faceCount: 0,
          updatedAt: new Date().toISOString(),
        };
        await writeDb(db3);
        return {
          id: photo.id,
          status: "failed",
          ok: false,
          error: error.message,
          retryCount: (prev.retryCount || 0) + 1,
        };
      }
    },

    async upsertFaceRecord(id, faces, version = FACE_EMBEDDING_VERSION, _actor = null, meta = {}) {
      if (!id) {
        throw new Error("Missing photo.");
      }
      const model = meta.model || FACE_MODEL;
      const embeddingVersion = Number(meta.embeddingVersion ?? version) || FACE_EMBEDDING_VERSION;
      const sanitized = sanitizeFacesForStorage(faces);
      assertSearchableFaceWrite(sanitized, { model, embeddingVersion });
      if (Array.isArray(faces) && faces.length > 0 && sanitized.length === 0) {
        throw Object.assign(
          new Error(
            `No valid ${FACE_DIM}-d ArcFace embeddings to store. FaceNet/other dims are rejected.`
          ),
          { status: 400 }
        );
      }
      const record = {
        id,
        faces: sanitized,
        version: embeddingVersion,
        model,
        embeddingVersion,
        updatedAt: new Date().toISOString(),
      };
      const db = await readDb();
      db.faceRecords[id] = record;
      await writeDb(db);
      return {
        id: record.id,
        version: record.version,
        model: record.model,
        embeddingVersion: record.embeddingVersion,
        updatedAt: record.updatedAt,
        faceCount: record.faces.length,
      };
    },

    async removeFaceRecord(id) {
      if (!id) return;
      const db = await readDb();
      delete db.faceRecords[id];
      if (db.faceIndexStatus) delete db.faceIndexStatus[id];
      await writeDb(db);
    },

    async loginAdmin(password) {
      if (!password || password !== getAdminPassword(env)) {
        throw new Error("Wrong password.");
      }
      const token = createSessionToken();
      const tokenHash = await localHash(token);
      const createdAt = new Date().toISOString();
      const expiresAt = sessionExpiryIso();
      const db = await readDb();
      db.sessions.push({ tokenHash, createdAt, expiresAt });
      await writeDb(db);
      return { token, expiresAt };
    },

    async logoutAdmin(request) {
      const token = getSessionToken(request);
      if (!token) return;
      const tokenHash = await localHash(token);
      const db = await readDb();
      db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash);
      await writeDb(db);
    },

    async requireAdmin(request) {
      const token = getSessionToken(request);
      if (!token) {
        throw Object.assign(new Error("Admin login required."), { status: 401 });
      }
      const tokenHash = await localHash(token);
      const db = await readDb();
      const row = db.sessions.find((item) => item.tokenHash === tokenHash);
      if (!row) {
        throw Object.assign(new Error("Admin login required."), { status: 401 });
      }
      if (new Date(row.expiresAt).getTime() < Date.now()) {
        db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash);
        await writeDb(db);
        throw Object.assign(new Error("Session expired. Log in again."), { status: 401 });
      }
      return true;
    },

    async createApprovals(items = []) {
      const db = await readDb();
      let created = 0;
      for (const item of items) {
        if (!item?.candidatePhotoId || !item?.queryDescriptors?.length) continue;
        db.approvals.push({
          id: randomId(),
          queryPreview: item.queryPreview || "",
          queryDescriptors: item.queryDescriptors,
          candidatePhotoId: item.candidatePhotoId,
          candidateUrl: item.candidateUrl || "",
          candidateName: item.candidateName || "photo",
          candidatePreview: item.candidatePreview || "",
          distance: Number(item.distance) || 1,
          status: "pending",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
        created += 1;
      }
      await writeDb(db);
      return { created };
    },

    async listApprovals(status = "pending") {
      const db = await readDb();
      return db.approvals
        .filter((item) => item.status === status)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 100)
        .map((item) => ({
          id: item.id,
          queryPreview: item.queryPreview,
          candidatePhotoId: item.candidatePhotoId,
          candidateUrl: item.candidateUrl,
          candidateName: item.candidateName,
          candidatePreview: item.candidatePreview,
          distance: item.distance,
          status: item.status,
          createdAt: item.createdAt,
          resolvedAt: item.resolvedAt,
        }));
    },

    async resolveApproval(id, decision) {
      if (!id) throw new Error("Missing approval.");
      const allowed = new Set(["same", "different", "unsure"]);
      if (!allowed.has(decision)) {
        throw new Error("Choose Same, Different, or Not sure.");
      }
      const db = await readDb();
      const row = db.approvals.find((item) => item.id === id);
      if (!row) throw new Error("Approval not found.");
      if (row.status !== "pending") {
        throw new Error("This item was already reviewed.");
      }

      let validDescriptors = [];
      if (decision === "same") {
        const descriptors = Array.isArray(row.queryDescriptors) ? row.queryDescriptors : [];
        validDescriptors = validateApprovalEmbeddings(descriptors);
        if (!validDescriptors.length) {
          throw Object.assign(
            new Error(
              "Cannot merge: no valid ArcFace embeddings on this approval (need insightface-buffalo-l v8, 512-d)."
            ),
            { status: 400 }
          );
        }
      }

      row.status = decision;
      row.resolvedAt = new Date().toISOString();
      await writeDb(db);

      if (decision === "same") {
        const existing = db.faceRecords[row.candidatePhotoId] || {
          id: row.candidatePhotoId,
          faces: [],
        };
        let faces = sanitizeFacesForStorage(existing.faces || []);
        for (const embedding of validDescriptors) {
          faces.push({ embedding, descriptors: [embedding], descriptor: embedding });
        }
        const unique = [];
        for (const face of faces) {
          const item = face.embedding;
          if (
            unique.some((other) => {
              let dot = 0;
              for (let i = 0; i < FACE_DIM; i += 1) dot += item[i] * other[i];
              return 1 - dot < 0.08;
            })
          ) {
            continue;
          }
          unique.push(item);
          if (unique.length >= 8) break;
        }
        await this.upsertFaceRecord(
          row.candidatePhotoId,
          unique.map((embedding) => ({ embedding, descriptors: [embedding], descriptor: embedding })),
          FACE_EMBEDDING_VERSION,
          null,
          { model: FACE_MODEL, embeddingVersion: FACE_EMBEDDING_VERSION }
        );
      }

      return { id, status: decision, resolvedAt: row.resolvedAt };
    },

    async approvalCounts() {
      const db = await readDb();
      const counts = { pending: 0, same: 0, different: 0, unsure: 0 };
      for (const item of db.approvals) {
        counts[item.status] = (counts[item.status] || 0) + 1;
      }
      return counts;
    },

    async registerUser({ name, email, password }) {
      const cleanName = String(name || "").trim().slice(0, 80);
      const cleanEmail = String(email || "").trim().toLowerCase();
      if (!cleanName) throw new Error("Enter your name.");
      if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("Enter a valid email.");
      if (!password || String(password).length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }
      const db = await readDb();
      if (db.users.some((user) => user.email === cleanEmail)) {
        throw new Error("An account with that email already exists.");
      }
      const id = randomId();
      const salt = createSalt();
      const passwordHash = await localHashPassword(password, salt);
      const now = new Date().toISOString();
      const user = {
        id,
        name: cleanName,
        email: cleanEmail,
        password_hash: passwordHash,
        password_salt: salt,
        photo_url: null,
        photo_key: null,
        face_json: null,
        created_at: now,
        updated_at: now,
      };
      db.users.push(user);
      const token = createSessionToken();
      db.userSessions.push({
        tokenHash: await localHash(token),
        userId: id,
        createdAt: now,
        expiresAt: sessionExpiryIso(),
      });
      await writeDb(db);
      return { token, user: publicUser(user) };
    },

    async loginUser({ email, password }) {
      const cleanEmail = String(email || "").trim().toLowerCase();
      const db = await readDb();
      const row = db.users.find((user) => user.email === cleanEmail);
      if (!row) throw Object.assign(new Error("Wrong email or password."), { status: 401 });
      const passwordHash = await localHashPassword(password || "", row.password_salt);
      if (passwordHash !== row.password_hash) {
        throw Object.assign(new Error("Wrong email or password."), { status: 401 });
      }
      const token = createSessionToken();
      const now = new Date().toISOString();
      db.userSessions.push({
        tokenHash: await localHash(token),
        userId: row.id,
        createdAt: now,
        expiresAt: sessionExpiryIso(),
      });
      await writeDb(db);
      return { token, user: publicUser(row) };
    },

    async logoutUser(request) {
      const token = getUserSessionToken(request);
      if (!token) return;
      const tokenHash = await localHash(token);
      const db = await readDb();
      db.userSessions = db.userSessions.filter((item) => item.tokenHash !== tokenHash);
      await writeDb(db);
    },

    async requireUser(request) {
      const token = getUserSessionToken(request);
      if (!token) throw Object.assign(new Error("Please log in first."), { status: 401 });
      const tokenHash = await localHash(token);
      const db = await readDb();
      const session = db.userSessions.find((item) => item.tokenHash === tokenHash);
      if (!session) throw Object.assign(new Error("Please log in first."), { status: 401 });
      if (new Date(session.expiresAt).getTime() < Date.now()) {
        db.userSessions = db.userSessions.filter((item) => item.tokenHash !== tokenHash);
        await writeDb(db);
        throw Object.assign(new Error("Session expired. Log in again."), { status: 401 });
      }
      const user = db.users.find((item) => item.id === session.userId);
      if (!user) throw Object.assign(new Error("Please log in first."), { status: 401 });
      return user;
    },

    async getCurrentUser(request) {
      const user = await this.requireUser(request);
      let face = null;
      if (user.face_json) {
        try {
          face = JSON.parse(user.face_json);
        } catch {
          face = null;
        }
      }
      return { ...publicUser(user), face };
    },

    async saveMyPhoto(request, { name, dataUrl, face }) {
      const user = await this.requireUser(request);
      const { type, buffer } = decodeDataUrl(dataUrl);
      const r2Key = `profiles/${user.id}-${Date.now()}-${safeName(name || "my-photo.jpg")}`;
      const filePath = path.join(PHOTOS_DIR, r2Key.replace(/\//g, "__"));
      await writeFile(filePath, buffer);
      const url = `${origin}/media/${r2Key}`;
      const db = await readDb();
      const row = db.users.find((item) => item.id === user.id);
      if (row?.photo_key) {
        const oldPath = path.join(PHOTOS_DIR, row.photo_key.replace(/\//g, "__"));
        await rm(oldPath, { force: true });
      }
      row.photo_url = url;
      row.photo_key = r2Key;
      row.face_json = face ? JSON.stringify(face) : null;
      row.updated_at = new Date().toISOString();
      row.filePath = filePath;
      row.contentType = type;
      await writeDb(db);
      return { user: publicUser(row), photoUrl: url };
    },

    async createConsent({ fullName, agreed, userAgent = "" }) {
      const name = String(fullName || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
      if (!name || name.length < 2) {
        throw new Error("Enter your full name.");
      }
      if (!agreed) {
        throw new Error("Please acknowledge the consent statement to continue.");
      }
      const statement =
        "I acknowledge that photographs in which I appear may be taken, used, downloaded and displayed.";
      const record = {
        id: randomId(),
        fullName: name,
        statement,
        agreed: true,
        userAgent: String(userAgent || "").slice(0, 400),
        createdAt: new Date().toISOString(),
      };
      const db = await readDb();
      db.consents.push(record);
      await writeDb(db);
      return {
        id: record.id,
        fullName: record.fullName,
        statement: record.statement,
        createdAt: record.createdAt,
      };
    },

    async listConsents(limit = 100) {
      const db = await readDb();
      return [...db.consents]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, Math.min(Number(limit) || 100, 500));
    },

    async listDbTables() {
      return ["photos", "display_names", "face_records", "approvals", "consents", "users"];
    },

    async exportTableCsv(table) {
      const name = String(table || "").trim();
      const tables = await this.listDbTables();
      if (!tables.includes(name)) throw new Error("Unknown table.");
      const db = await readDb();
      let rows = [];
      if (name === "photos") {
        rows = db.photos.map((item) => ({
          id: item.id,
          url: item.url,
          name: item.name,
          created_at: item.createdAt,
          owner_id: item.ownerId || "",
          deleted_at: item.deletedAt || "",
          r2_key: item.r2Key || "",
        }));
      } else if (name === "display_names") {
        rows = Object.entries(db.names).map(([photo_id, displayName]) => ({
          photo_id,
          name: displayName,
        }));
      } else if (name === "face_records") {
        rows = Object.values(db.faceRecords).map((item) => ({
          photo_id: item.id,
          version: item.version,
          updated_at: item.updatedAt || "",
          faces_json: JSON.stringify(item.faces || []),
        }));
      } else if (name === "approvals") {
        rows = db.approvals.map((item) => ({
          id: item.id,
          candidate_photo_id: item.candidatePhotoId,
          candidate_name: item.candidateName,
          distance: item.distance,
          status: item.status,
          created_at: item.createdAt,
          resolved_at: item.resolvedAt || "",
        }));
      } else if (name === "consents") {
        rows = db.consents.map((item) => ({
          id: item.id,
          full_name: item.fullName,
          statement: item.statement,
          agreed: item.agreed ? 1 : 0,
          created_at: item.createdAt,
        }));
      } else if (name === "users") {
        rows = db.users.map((item) => ({
          id: item.id,
          name: item.name,
          email: item.email,
          created_at: item.created_at,
          updated_at: item.updated_at,
        }));
      }
      if (!rows.length) return { table: name, csv: "", rowCount: 0 };
      const columns = Object.keys(rows[0]);
      const escape = (value) => {
        if (value === null || value === undefined) return "";
        const text = String(value);
        if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
        return text;
      };
      const lines = [columns.join(",")];
      for (const row of rows) {
        lines.push(columns.map((col) => escape(row[col])).join(","));
      }
      return { table: name, csv: `${lines.join("\n")}\n`, rowCount: rows.length, columns };
    },

    async runAdminSql(sql) {
      throw new Error(
        "SQL console runs on Cloudflare D1 in production. Locally, use Download CSV for table exports."
      );
    },

    async readMedia(r2Key) {
      const db = await readDb();
      const photo = db.photos.find((item) => item.r2Key === r2Key);
      if (photo?.filePath) {
        const body = await readFile(photo.filePath);
        return { body, contentType: photo.contentType || "application/octet-stream" };
      }
      const profile = db.users.find((item) => item.photo_key === r2Key);
      if (profile?.filePath) {
        const body = await readFile(profile.filePath);
        return { body, contentType: profile.contentType || "image/jpeg" };
      }

      const fileName = r2Key.replace(/\//g, "__");
      const filePath = path.join(PHOTOS_DIR, fileName);
      try {
        const body = await readFile(filePath);
        return { body, contentType: "application/octet-stream" };
      } catch {
        return null;
      }
    },
  };
}

async function localHashPassword(password, salt) {
  try {
    return await hashPassword(password, salt);
  } catch {
    return pbkdf2Sync(String(password), String(salt), 100000, 32, "sha256").toString("hex");
  }
}

export async function listLocalMediaKeys() {
  await ensureDataDir();
  try {
    const files = await readdir(PHOTOS_DIR);
    return files;
  } catch {
    return [];
  }
}
