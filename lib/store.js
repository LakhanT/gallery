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
import {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MODEL,
  getFaceThresholds,
  rankFaceMatches,
  secureHeaders,
  splitMatches,
} from "./face-match.js";
import { FACE_REINDEX_MAX_AUTO_RETRIES } from "./face-config.js";
import { faceServiceDetectEmbed } from "./face-client.js";
import {
  assertSearchableFaceWrite,
  sanitizeFacesForStorage,
  validateApprovalEmbeddings,
} from "./face-validate.js";

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

function mediaUrl(origin, r2Key) {
  return `${origin}/media/${r2Key}`;
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
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (!bytes.length) {
    throw new Error("That photo is empty.");
  }
  return { type, bytes };
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readNames(db) {
  const { results } = await db.prepare("SELECT photo_id, name FROM display_names").all();
  const names = {};
  for (const row of results || []) {
    names[row.photo_id] = row.name;
  }
  return names;
}

export function createStore(env, origin) {
  const db = env.DB;
  const bucket = env.PHOTOS;

  return {
    async getActor(request) {
      try {
        await this.requireAdmin(request);
        return { kind: "admin" };
      } catch {
        /* try user */
      }
      try {
        const user = await this.requireUser(request);
        return { kind: "user", user };
      } catch {
        return null;
      }
    },

    async requireMember(request) {
      const actor = await this.getActor(request);
      if (!actor) {
        throw Object.assign(new Error("Please log in to continue."), { status: 401 });
      }
      return actor;
    },

    async getPhotoRow(id) {
      return db
        .prepare(
          "SELECT id, r2_key, url, name, created_at, owner_id, deleted_at FROM photos WHERE id = ? OR url = ?"
        )
        .bind(id, id)
        .first();
    },

    assertCanModify(actor, photoRow) {
      if (!photoRow) throw new Error("Photo not found.");
      if (actor.kind === "admin") return;
      if (actor.kind === "user" && photoRow.owner_id && photoRow.owner_id === actor.user.id) {
        return;
      }
      throw Object.assign(new Error("You can only change your own photos."), { status: 403 });
    },

    async getGallery() {
      const { results } = await db
        .prepare(
          `SELECT id, url, name, created_at, owner_id
           FROM photos
           WHERE deleted_at IS NULL
           ORDER BY created_at DESC`
        )
        .all();
      const names = await readNames(db);
      return {
        photos: (results || []).map((row) => ({
          id: row.id,
          url: row.url,
          name: names[row.id] || row.name,
          createdAt: row.created_at,
          ownerId: row.owner_id || null,
        })),
        names,
      };
    },

    async listAdminPhotos({ includeHidden = true } = {}) {
      const sql = includeHidden
        ? `SELECT id, url, name, created_at, owner_id, deleted_at
           FROM photos
           ORDER BY created_at DESC`
        : `SELECT id, url, name, created_at, owner_id, deleted_at
           FROM photos
           WHERE deleted_at IS NULL
           ORDER BY created_at DESC`;
      const { results } = await db.prepare(sql).all();
      const names = await readNames(db);
      return (results || []).map((row) => ({
        id: row.id,
        url: row.url,
        name: names[row.id] || row.name,
        createdAt: row.created_at,
        ownerId: row.owner_id || null,
        hidden: Boolean(row.deleted_at),
        deletedAt: row.deleted_at || null,
      }));
    },

    async hidePhoto(target) {
      if (!target) throw new Error("Missing photo.");
      const row = await this.getPhotoRow(target);
      if (!row) throw Object.assign(new Error("Photo not found."), { status: 404 });
      if (row.deleted_at) {
        return { id: row.id, url: row.url, hidden: true, deletedAt: row.deleted_at };
      }
      const deletedAt = new Date().toISOString();
      await db.prepare("UPDATE photos SET deleted_at = ? WHERE id = ?").bind(deletedAt, row.id).run();
      return { id: row.id, url: row.url, hidden: true, deletedAt };
    },

    async restorePhoto(target) {
      if (!target) throw new Error("Missing photo.");
      const row = await this.getPhotoRow(target);
      if (!row) throw Object.assign(new Error("Photo not found."), { status: 404 });
      await db.prepare("UPDATE photos SET deleted_at = NULL WHERE id = ?").bind(row.id).run();
      return { id: row.id, url: row.url, hidden: false, deletedAt: null };
    },

    async addPhoto({ name, dataUrl }, ownerId = null) {
      const { type, bytes } = decodeDataUrl(dataUrl);
      if (bytes.byteLength > 8 * 1024 * 1024) {
        throw new Error("Photo is too large (max 8MB).");
      }
      const r2Key = `${GALLERY_PREFIX}${Date.now()}-${safeName(name)}`;
      await bucket.put(r2Key, bytes, {
        httpMetadata: { contentType: type },
      });

      const url = mediaUrl(origin, r2Key);
      const id = url;
      const displayName = name || "photo.jpg";
      const createdAt = new Date().toISOString();

      await db
        .prepare(
          "INSERT INTO photos (id, r2_key, url, name, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(id, r2Key, url, displayName, createdAt, ownerId)
        .run();

      return {
        id,
        url,
        name: displayName,
        createdAt,
        ownerId,
        // Internal: let auto-index skip a second R2 download (stripped before JSON)
        _faceIndexBytes: bytes,
        _faceIndexContentType: type,
      };
    },

    async renamePhoto(id, name, actor = null) {
      if (!id) {
        throw new Error("Missing photo.");
      }
      const next = cleanDisplayName(name);
      const uploaded = await this.getPhotoRow(id);
      if (uploaded) {
        if (actor) this.assertCanModify(actor, uploaded);
        await db.prepare("UPDATE photos SET name = ? WHERE id = ?").bind(next, uploaded.id).run();
      } else if (actor && actor.kind !== "admin") {
        throw Object.assign(new Error("Photo not found."), { status: 404 });
      }

      await db
        .prepare(
          "INSERT INTO display_names (photo_id, name) VALUES (?, ?) ON CONFLICT(photo_id) DO UPDATE SET name = excluded.name"
        )
        .bind(id, next)
        .run();

      return next;
    },

    async removePhoto(target, actor = null) {
      if (!target) {
        throw new Error("Missing photo.");
      }
      const row = await this.getPhotoRow(target);
      if (!row) {
        throw Object.assign(new Error("Photo not found."), { status: 404 });
      }
      if (actor) this.assertCanModify(actor, row);

      if (row.r2_key) {
        await bucket.delete(row.r2_key);
      }
      await db.prepare("DELETE FROM photos WHERE id = ?").bind(row.id).run();
      await db.prepare("DELETE FROM display_names WHERE photo_id = ?").bind(row.id).run();
      await db.prepare("DELETE FROM face_records WHERE photo_id = ?").bind(row.id).run();
      await db
        .prepare("DELETE FROM approval_queue WHERE candidate_photo_id = ?")
        .bind(row.id)
        .run();
    },

    async getFaceIndex({ onlyCurrent = true } = {}) {
      const sql = onlyCurrent
        ? `SELECT photo_id, faces_json, version, model, embedding_version
           FROM face_records
           WHERE embedding_version = ? OR (embedding_version IS NULL AND version = ?)`
        : `SELECT photo_id, faces_json, version, model, embedding_version FROM face_records`;
      const stmt = onlyCurrent
        ? db.prepare(sql).bind(FACE_EMBEDDING_VERSION, FACE_EMBEDDING_VERSION)
        : db.prepare(sql);
      const { results } = await stmt.all();
      const index = {};
      for (const row of results || []) {
        let faces = [];
        try {
          faces = JSON.parse(row.faces_json);
        } catch {
          faces = [];
        }
        // Drop legacy FaceNet vectors — never mix with ArcFace 512-d
        const cleaned = (faces || [])
          .map((face) => {
            const embedding =
              (Array.isArray(face.embedding) && face.embedding.length === FACE_DIM && face.embedding) ||
              (Array.isArray(face.descriptor) && face.descriptor.length === FACE_DIM && face.descriptor) ||
              (Array.isArray(face.descriptors?.[0]) &&
                face.descriptors[0].length === FACE_DIM &&
                face.descriptors[0]) ||
              null;
            if (!embedding) return null;
            // Skip searchable if row model is known and not buffalo_l
            if (row.model && row.model !== FACE_MODEL) return null;
            return {
              embedding,
              descriptors: [embedding],
              descriptor: embedding,
              bbox: face.bbox || null,
              detection_score: face.detection_score ?? face.detectionScore ?? null,
              quality_score: face.quality_score ?? face.qualityScore ?? null,
            };
          })
          .filter(Boolean);
        // Only expose searchable rows that are buffalo_l v8 (or legacy null model with v8)
        const modelOk = !row.model || row.model === FACE_MODEL;
        if (!modelOk) continue;
        index[row.photo_id] = {
          id: row.photo_id,
          faces: cleaned,
          version: Number(row.embedding_version ?? row.version) || 0,
          model: row.model || FACE_MODEL,
        };
      }
      return index;
    },

    /** Versions only — never expose embeddings to clients. */
    async getFaceVersions() {
      const { results } = await db
        .prepare(
          `SELECT photo_id,
                  COALESCE(embedding_version, version) AS ver
           FROM face_records`
        )
        .all();
      const versions = {};
      for (const row of results || []) {
        versions[row.photo_id] = Number(row.ver) || 0;
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
      if (queries.length > 8) {
        throw new Error("Too many face vectors.");
      }

      const gallery = await this.getGallery();
      const index = await this.getFaceIndex({ onlyCurrent: true });
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
            similarity: row.similarity,
          }))
        );
      }

      const mapRow = (row) => ({
        id: row.id,
        similarity: row.similarity,
        rankingScore: row.rankingScore,
        distance: row.distance,
        name: row.name,
        url: row.url,
        matchedFaceBbox: row.matchedFaceBbox,
        detectionScore: row.detectionScore,
        qualityScore: row.qualityScore,
        category: row.category,
      });

      return {
        matches: matches.map(mapRow),
        uncertain: uncertain.map(mapRow),
        indexedCount: Object.keys(index).filter((id) => index[id].faces.length).length,
        photoCount: gallery.photos.length,
        thresholds: getFaceThresholds(),
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
      };
    },

    async getFaceIndexStatusMap() {
      try {
        const { results } = await db
          .prepare(
            `SELECT photo_id, status, retry_count, last_error, face_count, updated_at
             FROM face_index_status`
          )
          .all();
        const map = {};
        for (const row of results || []) {
          map[row.photo_id] = {
            photoId: row.photo_id,
            status: row.status,
            retryCount: Number(row.retry_count) || 0,
            lastError: row.last_error || null,
            faceCount: Number(row.face_count) || 0,
            updatedAt: row.updated_at,
          };
        }
        return map;
      } catch {
        // Migration 0008 not applied yet — treat as empty map
        return {};
      }
    },

    async setFaceIndexStatus(photoId, { status, retryCount = 0, lastError = null, faceCount = 0 }) {
      const updatedAt = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO face_index_status (photo_id, status, retry_count, last_error, face_count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(photo_id) DO UPDATE SET
             status = excluded.status,
             retry_count = excluded.retry_count,
             last_error = excluded.last_error,
             face_count = excluded.face_count,
             updated_at = excluded.updated_at`
        )
        .bind(photoId, status, retryCount, lastError, faceCount, updatedAt)
        .run();
      return { photoId, status, retryCount, lastError, faceCount, updatedAt };
    },

    async retryFailedFaceIndexes() {
      const updatedAt = new Date().toISOString();
      const result = await db
        .prepare(
          `UPDATE face_index_status
           SET status = 'pending', last_error = NULL, updated_at = ?
           WHERE status = 'failed'`
        )
        .bind(updatedAt)
        .run();
      return { reset: result?.meta?.changes ?? 0 };
    },

    /** Active = queued + processing (bounded gateway queue). */
    async countActiveFaceSearchJobs() {
      try {
        const row = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM face_search_jobs
             WHERE status IN ('queued', 'processing')
               AND expires_at > ?`
          )
          .bind(new Date().toISOString())
          .first();
        return Number(row?.n) || 0;
      } catch {
        return 0;
      }
    },

    async createFaceSearchJob(job) {
      await db
        .prepare(
          `INSERT INTO face_search_jobs
             (id, status, image_sha256, client_key, error, result_json, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          job.id,
          job.status,
          job.imageSha256 || null,
          job.clientKey || null,
          job.error || null,
          job.result ? JSON.stringify(job.result) : null,
          job.createdAt,
          job.updatedAt,
          job.expiresAt
        )
        .run();
      return job;
    },

    async getFaceSearchJob(id) {
      try {
        const row = await db
          .prepare(`SELECT * FROM face_search_jobs WHERE id = ?`)
          .bind(id)
          .first();
        if (!row) return null;
        let result = null;
        if (row.result_json) {
          try {
            result = JSON.parse(row.result_json);
          } catch {
            result = null;
          }
        }
        return {
          id: row.id,
          status: row.status,
          imageSha256: row.image_sha256,
          clientKey: row.client_key,
          error: row.error,
          result,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at,
          attemptCount: Number(row.attempt_count) || 0,
          r2ObjectKey: row.r2_object_key || null,
          claimedAt: row.claimed_at || null,
        };
      } catch {
        return null;
      }
    },

    async updateFaceSearchJob(id, patch) {
      const current = await this.getFaceSearchJob(id);
      if (!current) return null;
      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await db
        .prepare(
          `UPDATE face_search_jobs
           SET status = ?, error = ?, result_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(
          next.status,
          next.error || null,
          next.result ? JSON.stringify(next.result) : null,
          next.updatedAt,
          id
        )
        .run();
      return next;
    },

    async setFaceSearchJobR2Key(id, objectKey) {
      try {
        await db
          .prepare(`UPDATE face_search_jobs SET r2_object_key = ?, updated_at = ? WHERE id = ?`)
          .bind(objectKey, new Date().toISOString(), id)
          .run();
      } catch {
        // Column may not exist until migration 0011
      }
    },

    /**
     * Atomic claim for queue consumers (idempotent under redelivery).
     * Claims queued jobs, or stale processing claims older than staleMs.
     */
    async claimFaceSearchJob(id, { staleMs = 120_000 } = {}) {
      const now = new Date().toISOString();
      const staleBefore = new Date(Date.now() - staleMs).toISOString();
      try {
        const result = await db
          .prepare(
            `UPDATE face_search_jobs
             SET status = 'processing',
                 attempt_count = COALESCE(attempt_count, 0) + 1,
                 claimed_at = ?,
                 updated_at = ?,
                 error = NULL
             WHERE id = ?
               AND (
                 status = 'queued'
                 OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at < ?))
               )`
          )
          .bind(now, now, id, staleBefore)
          .run();
        const changes = result?.meta?.changes ?? result?.changes ?? 0;
        return { claimed: changes > 0, at: now };
      } catch {
        // Fallback without attempt_count/claimed_at columns
        const current = await this.getFaceSearchJob(id);
        if (!current) return { claimed: false };
        if (current.status !== "queued" && current.status !== "processing") {
          return { claimed: false };
        }
        await this.updateFaceSearchJob(id, { status: "processing" });
        return { claimed: true, at: now, legacy: true };
      }
    },

    async findRecentFaceSearchJobBySha(imageSha256, withinMs) {
      if (!imageSha256) return null;
      const since = new Date(Date.now() - withinMs).toISOString();
      try {
        const row = await db
          .prepare(
            `SELECT * FROM face_search_jobs
             WHERE image_sha256 = ?
               AND created_at >= ?
               AND status IN ('queued', 'processing', 'completed')
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .bind(imageSha256, since)
          .first();
        if (!row) return null;
        return this.getFaceSearchJob(row.id);
      } catch {
        return null;
      }
    },

    async putFaceSearchTempImage(jobId, bytes, contentType = "image/jpeg") {
      const key = `tmp/face-search/${jobId}`;
      const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await bucket.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: { purpose: "face-search-ephemeral", jobId: String(jobId) },
      });
      return key;
    },

    async getFaceSearchTempImage(jobId) {
      const key = `tmp/face-search/${jobId}`;
      const obj = await bucket.get(key);
      if (!obj) return null;
      const body = new Uint8Array(await obj.arrayBuffer());
      return {
        body,
        contentType: obj.httpMetadata?.contentType || "image/jpeg",
      };
    },

    async deleteFaceSearchTempImage(jobId) {
      const key = `tmp/face-search/${jobId}`;
      await bucket.delete(key);
    },

    /**
     * Index one photo via the Python face service (admin reindex / auto-index on upload).
     * @param {string} photoId
     * @param {object} envRef
     * @param {{ bytes?: ArrayBuffer|Uint8Array|Blob, contentType?: string }} [options]
     *        Pass bytes from addPhoto to avoid a second R2 fetch (faster auto-index).
     */
    async indexPhotoWithFaceService(photoId, envRef = env, options = {}) {
      const row = await this.getPhotoRow(photoId);
      if (!row) throw Object.assign(new Error("Photo not found."), { status: 404 });
      if (row.deleted_at) {
        return { id: row.id, skipped: true, reason: "hidden" };
      }
      if (!row.r2_key && !options.bytes) throw new Error("Photo has no storage key.");

      const statusMap = await this.getFaceIndexStatusMap();
      const prev = statusMap[row.id] || { retryCount: 0 };

      try {
        await this.setFaceIndexStatus(row.id, {
          status: "processing",
          retryCount: prev.retryCount || 0,
          lastError: null,
          faceCount: prev.faceCount || 0,
        });
      } catch {
        /* 0008 may be missing in local; continue indexing */
      }

      try {
        let bytes = options.bytes || null;
        let contentType = options.contentType || "image/jpeg";
        if (!bytes) {
          const object = await bucket.get(row.r2_key);
          if (!object) throw new Error("Photo bytes missing from storage.");
          bytes = await object.arrayBuffer();
          contentType = object.httpMetadata?.contentType || contentType;
        }
        const result = await faceServiceDetectEmbed(
          envRef,
          bytes instanceof Blob ? bytes : new Blob([bytes], { type: contentType }),
          row.name || "photo.jpg",
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
        await this.upsertFaceRecord(row.id, faces, FACE_EMBEDDING_VERSION, { kind: "admin" }, {
          model: FACE_MODEL,
          embeddingVersion: FACE_EMBEDDING_VERSION,
        });
        try {
          await this.setFaceIndexStatus(row.id, {
            status: "completed",
            retryCount: 0,
            lastError: null,
            faceCount: faces.length,
          });
        } catch {
          /* ignore if 0008 missing */
        }
        return {
          id: row.id,
          status: "completed",
          faceCount: faces.length,
          rejected: result.rejected || 0,
          model: FACE_MODEL,
          version: FACE_EMBEDDING_VERSION,
        };
      } catch (error) {
        const retryCount = (prev.retryCount || 0) + 1;
        try {
          await this.setFaceIndexStatus(row.id, {
            status: "failed",
            retryCount,
            lastError: String(error.message || error).slice(0, 500),
            faceCount: 0,
          });
        } catch {
          /* ignore */
        }
        return {
          id: row.id,
          status: "failed",
          ok: false,
          error: error.message,
          retryCount,
        };
      }
    },

    async getReindexProgress() {
      const gallery = await this.getGallery();
      const versions = await this.getFaceVersions();
      const statusMap = await this.getFaceIndexStatusMap();

      const faceCountById = {};
      try {
        const { results } = await db
          .prepare(
            `SELECT photo_id, faces_json
             FROM face_records
             WHERE COALESCE(embedding_version, version) = ?`
          )
          .bind(FACE_EMBEDDING_VERSION)
          .all();
        for (const row of results || []) {
          try {
            const faces = JSON.parse(row.faces_json || "[]");
            faceCountById[row.photo_id] = Array.isArray(faces) ? faces.length : 0;
          } catch {
            faceCountById[row.photo_id] = 0;
          }
        }
      } catch {
        /* ignore */
      }

      let indexed = 0;
      let withFaces = 0;
      let noFaces = 0;
      let failed = 0;
      const failedItems = [];

      for (const photo of gallery.photos) {
        const st = statusMap[photo.id];
        const ver = versions[photo.id] || 0;
        if (st?.status === "failed") {
          failed += 1;
          failedItems.push({
            id: photo.id,
            lastError: st.lastError,
            retryCount: st.retryCount,
          });
          continue;
        }
        const completed =
          st?.status === "completed" ||
          (ver === FACE_EMBEDDING_VERSION && st?.status !== "failed");
        if (completed) {
          indexed += 1;
          const faceCount =
            typeof st?.faceCount === "number" ? st.faceCount : faceCountById[photo.id] || 0;
          if (faceCount > 0) withFaces += 1;
          else noFaces += 1;
        }
      }

      const pending = Math.max(0, gallery.photos.length - indexed - failed);

      return {
        total: gallery.photos.length,
        indexed,
        withFaces,
        noFaces,
        failed,
        pending,
        failedItems: failedItems.slice(0, 20),
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
        thresholds: getFaceThresholds(),
        maxAutoRetries: FACE_REINDEX_MAX_AUTO_RETRIES,
      };
    },

    async listPhotosNeedingReindex(limit = 10, { includeFailed = false } = {}) {
      const gallery = await this.getGallery();
      const versions = await this.getFaceVersions();
      const statusMap = await this.getFaceIndexStatusMap();
      return gallery.photos
        .filter((photo) => {
          const st = statusMap[photo.id];
          if (st?.status === "completed") return false;
          if ((versions[photo.id] || 0) === FACE_EMBEDDING_VERSION && st?.status !== "failed") {
            return false;
          }
          if (st?.status === "failed") return includeFailed;
          return true;
        })
        .slice(0, Math.min(50, Math.max(1, limit)));
    },

    async searchFacesForRequest(request, { descriptors, queryPreview = "", useProfile = false } = {}) {
      if (useProfile) {
        const user = await this.requireUser(request);
        let face = null;
        if (user.face_json) {
          try {
            face = JSON.parse(user.face_json);
          } catch {
            face = null;
          }
        }
        const profileDescriptors = face?.descriptors || (face?.descriptor ? [face.descriptor] : null);
        if (!profileDescriptors?.length) {
          throw Object.assign(new Error("Upload your face photo in Account first."), { status: 400 });
        }
        return this.searchFaces(profileDescriptors, queryPreview || face?.preview || "");
      }
      await this.requireMember(request);
      return this.searchFaces(descriptors, queryPreview);
    },

    async upsertFaceRecord(id, faces, version = FACE_EMBEDDING_VERSION, actor = null, meta = {}) {
      if (!id) {
        throw new Error("Missing photo.");
      }
      if (actor) {
        const photo = await this.getPhotoRow(id);
        if (!photo && actor.kind !== "admin") {
          throw Object.assign(new Error("Photo not found."), { status: 404 });
        }
      }
      const model = meta.model || FACE_MODEL;
      const embeddingVersion = Number(meta.embeddingVersion ?? version) || FACE_EMBEDDING_VERSION;
      const sanitized = sanitizeFacesForStorage(faces);
      // Empty faces (no detection) is a valid completed index — still must be buffalo_l v8
      assertSearchableFaceWrite(sanitized, { model, embeddingVersion });
      // Reject if caller passed faces that all failed sanitize (but input was non-empty invalid)
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
      await db
        .prepare(
          `INSERT INTO face_records (photo_id, faces_json, version, updated_at, model, embedding_version)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(photo_id) DO UPDATE SET
             faces_json = excluded.faces_json,
             version = excluded.version,
             updated_at = excluded.updated_at,
             model = excluded.model,
             embedding_version = excluded.embedding_version`
        )
        .bind(
          id,
          JSON.stringify(record.faces),
          record.version,
          record.updatedAt,
          record.model,
          record.embeddingVersion
        )
        .run();
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
      await db.prepare("DELETE FROM face_records WHERE photo_id = ?").bind(id).run();
      try {
        await db.prepare("DELETE FROM face_index_status WHERE photo_id = ?").bind(id).run();
      } catch {
        /* 0008 optional */
      }
    },

    async loginAdmin(password) {
      if (!password || password !== getAdminPassword(env)) {
        throw new Error("Wrong password.");
      }
      const token = createSessionToken();
      const tokenHash = await hashValue(token);
      const createdAt = new Date().toISOString();
      const expiresAt = sessionExpiryIso();
      await db
        .prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
        .bind(tokenHash, createdAt, expiresAt)
        .run();
      return { token, expiresAt };
    },

    async logoutAdmin(request) {
      const token = getSessionToken(request);
      if (!token) return;
      const tokenHash = await hashValue(token);
      await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(tokenHash).run();
    },

    async requireAdmin(request) {
      const token = getSessionToken(request);
      if (!token) {
        throw Object.assign(new Error("Admin login required."), { status: 401 });
      }
      const tokenHash = await hashValue(token);
      const row = await db
        .prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .first();
      if (!row) {
        throw Object.assign(new Error("Admin login required."), { status: 401 });
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(tokenHash).run();
        throw Object.assign(new Error("Session expired. Log in again."), { status: 401 });
      }
      return true;
    },

    async createApprovals(items = []) {
      const created = [];
      for (const item of items) {
        if (!item?.candidatePhotoId || !item?.queryDescriptors?.length) continue;
        const id = randomId();
        const createdAt = new Date().toISOString();
        await db
          .prepare(
            `INSERT INTO approval_queue (
              id, query_preview, query_descriptors, candidate_photo_id, candidate_url,
              candidate_name, candidate_preview, distance, status, created_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
          )
          .bind(
            id,
            item.queryPreview || "",
            JSON.stringify(item.queryDescriptors),
            item.candidatePhotoId,
            item.candidateUrl || "",
            item.candidateName || "photo",
            item.candidatePreview || "",
            Number(item.distance) || 1,
            createdAt
          )
          .run();
        created.push(id);
      }
      return { created: created.length };
    },

    async listApprovals(status = "pending") {
      const { results } = await db
        .prepare(
          `SELECT id, query_preview, candidate_photo_id, candidate_url, candidate_name,
                  candidate_preview, distance, status, created_at, resolved_at
           FROM approval_queue
           WHERE status = ?
           ORDER BY created_at DESC
           LIMIT 100`
        )
        .bind(status)
        .all();
      return (results || []).map((row) => ({
        id: row.id,
        queryPreview: row.query_preview,
        candidatePhotoId: row.candidate_photo_id,
        candidateUrl: row.candidate_url,
        candidateName: row.candidate_name,
        candidatePreview: row.candidate_preview,
        distance: row.distance,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      }));
    },

    async resolveApproval(id, decision) {
      if (!id) throw new Error("Missing approval.");
      const allowed = new Set(["same", "different", "unsure"]);
      if (!allowed.has(decision)) {
        throw new Error("Choose Same, Different, or Not sure.");
      }

      const row = await db
        .prepare(
          "SELECT id, query_descriptors, candidate_photo_id, status FROM approval_queue WHERE id = ?"
        )
        .bind(id)
        .first();
      if (!row) throw new Error("Approval not found.");
      if (row.status !== "pending") {
        throw new Error("This item was already reviewed.");
      }

      let validDescriptors = [];
      if (decision === "same") {
        let descriptors = [];
        try {
          descriptors = JSON.parse(row.query_descriptors);
        } catch {
          descriptors = [];
        }
        // Validate before resolving — never store FaceNet / wrong dim
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

      const resolvedAt = new Date().toISOString();
      await db
        .prepare("UPDATE approval_queue SET status = ?, resolved_at = ? WHERE id = ?")
        .bind(decision, resolvedAt, id)
        .run();

      if (decision === "same") {
        const existing = await db
          .prepare(
            "SELECT faces_json, version, model, embedding_version FROM face_records WHERE photo_id = ?"
          )
          .bind(row.candidate_photo_id)
          .first();
        let faces = [];
        if (existing) {
          try {
            faces = JSON.parse(existing.faces_json);
          } catch {
            faces = [];
          }
          faces = sanitizeFacesForStorage(faces);
        }
        for (const embedding of validDescriptors) {
          faces.push({
            embedding,
            descriptors: [embedding],
            descriptor: embedding,
          });
        }
        const flat = [];
        for (const face of faces) {
          const emb = face.embedding || face.descriptor || face.descriptors?.[0];
          if (emb?.length === FACE_DIM) flat.push(emb);
        }
        const unique = [];
        for (const item of flat) {
          if (
            unique.some((other) => {
              if (other.length !== FACE_DIM || item.length !== FACE_DIM) return false;
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
        faces = unique.map((embedding) => ({
          embedding,
          descriptors: [embedding],
          descriptor: embedding,
        }));
        await this.upsertFaceRecord(row.candidate_photo_id, faces, FACE_EMBEDDING_VERSION, null, {
          model: FACE_MODEL,
          embeddingVersion: FACE_EMBEDDING_VERSION,
        });
      }

      return { id, status: decision, resolvedAt };
    },

    async approvalCounts() {
      const { results } = await db
        .prepare("SELECT status, COUNT(*) AS count FROM approval_queue GROUP BY status")
        .all();
      const counts = { pending: 0, same: 0, different: 0, unsure: 0 };
      for (const row of results || []) {
        counts[row.status] = Number(row.count) || 0;
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

      const existing = await db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(cleanEmail)
        .first();
      if (existing) throw new Error("An account with that email already exists.");

      const id = randomId();
      const salt = createSalt();
      const passwordHash = await hashPassword(password, salt);
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO users (
            id, name, email, password_hash, password_salt, photo_url, photo_key, face_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
        )
        .bind(id, cleanName, cleanEmail, passwordHash, salt, now, now)
        .run();

      const token = createSessionToken();
      const tokenHash = await hashValue(token);
      await db
        .prepare(
          "INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
        )
        .bind(tokenHash, id, now, sessionExpiryIso())
        .run();

      return { token, user: publicUser({ id, name: cleanName, email: cleanEmail, created_at: now }) };
    },

    async loginUser({ email, password }) {
      const cleanEmail = String(email || "").trim().toLowerCase();
      const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(cleanEmail).first();
      if (!row) throw Object.assign(new Error("Wrong email or password."), { status: 401 });
      const passwordHash = await hashPassword(password || "", row.password_salt);
      if (passwordHash !== row.password_hash) {
        throw Object.assign(new Error("Wrong email or password."), { status: 401 });
      }
      const token = createSessionToken();
      const tokenHash = await hashValue(token);
      const now = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
        )
        .bind(tokenHash, row.id, now, sessionExpiryIso())
        .run();
      return { token, user: publicUser(row) };
    },

    async logoutUser(request) {
      const token = getUserSessionToken(request);
      if (!token) return;
      const tokenHash = await hashValue(token);
      await db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").bind(tokenHash).run();
    },

    async requireUser(request) {
      const token = getUserSessionToken(request);
      if (!token) {
        throw Object.assign(new Error("Please log in first."), { status: 401 });
      }
      const tokenHash = await hashValue(token);
      const session = await db
        .prepare("SELECT user_id, expires_at FROM user_sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .first();
      if (!session) {
        throw Object.assign(new Error("Please log in first."), { status: 401 });
      }
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").bind(tokenHash).run();
        throw Object.assign(new Error("Session expired. Log in again."), { status: 401 });
      }
      const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
      if (!user) {
        throw Object.assign(new Error("Please log in first."), { status: 401 });
      }
      return user;
    },

    async getCurrentUser(request) {
      const user = await this.requireUser(request);
      let hasFace = false;
      if (user.face_json) {
        try {
          const face = JSON.parse(user.face_json);
          hasFace = Boolean(face?.descriptors?.length || face?.descriptor?.length);
        } catch {
          hasFace = false;
        }
      }
      return { ...publicUser(user), hasFace };
    },

    async saveMyPhoto(request, { name, dataUrl, face }) {
      const user = await this.requireUser(request);
      const { type, bytes } = decodeDataUrl(dataUrl);
      if (bytes.byteLength > 8 * 1024 * 1024) {
        throw new Error("Photo is too large (max 8MB).");
      }
      const r2Key = `profiles/${user.id}-${Date.now()}-${safeName(name || "my-photo.jpg")}`;
      await bucket.put(r2Key, bytes, {
        httpMetadata: { contentType: type },
      });
      if (user.photo_key) {
        try {
          await bucket.delete(user.photo_key);
        } catch {
          /* old photo already gone */
        }
      }
      const url = mediaUrl(origin, r2Key);
      const now = new Date().toISOString();
      const hasFace = Boolean(face?.descriptors?.length || face?.descriptor?.length);
      const faceJson = hasFace
        ? JSON.stringify({
            descriptors: face.descriptors || [face.descriptor],
            preview: typeof face.preview === "string" ? face.preview.slice(0, 200000) : "",
          })
        : null;
      await db
        .prepare(
          `UPDATE users
           SET photo_url = ?, photo_key = ?, face_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(url, r2Key, faceJson, now, user.id)
        .run();
      return {
        user: {
          ...publicUser({
            ...user,
            photo_url: url,
            updated_at: now,
          }),
          hasFace,
        },
        photoUrl: url,
      };
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
      const id = randomId();
      const createdAt = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO consents (id, full_name, statement, agreed, user_agent, created_at)
           VALUES (?, ?, ?, 1, ?, ?)`
        )
        .bind(id, name, statement, String(userAgent || "").slice(0, 400), createdAt)
        .run();
      return { id, fullName: name, statement, createdAt };
    },

    async listConsents(limit = 100) {
      const { results } = await db
        .prepare(
          `SELECT id, full_name, statement, agreed, created_at
           FROM consents
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .bind(Math.min(Number(limit) || 100, 500))
        .all();
      return (results || []).map((row) => ({
        id: row.id,
        fullName: row.full_name,
        statement: row.statement,
        agreed: Boolean(row.agreed),
        createdAt: row.created_at,
      }));
    },

    async listDbTables() {
      const { results } = await db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
           ORDER BY name`
        )
        .all();
      return (results || []).map((row) => row.name);
    },

    async exportTableCsv(table) {
      const name = String(table || "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error("Invalid table name.");
      }
      const tables = await this.listDbTables();
      if (!tables.includes(name)) {
        throw new Error("Unknown table.");
      }
      const { results } = await db.prepare(`SELECT * FROM "${name}" LIMIT 5000`).all();
      const rows = results || [];
      if (!rows.length) {
        return { table: name, csv: "", rowCount: 0 };
      }
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
      const raw = String(sql || "").trim();
      if (!raw) throw new Error("Enter an SQL statement.");
      if (raw.length > 12000) throw new Error("SQL is too long.");
      if (raw.includes(";")) {
        throw new Error("Run one statement at a time (no semicolons).");
      }

      const normalized = raw.replace(/\s+/g, " ").trim();
      const upper = normalized.toUpperCase();
      const allowed =
        /^(SELECT|WITH|PRAGMA|EXPLAIN|INSERT|UPDATE|DELETE|ALTER|CREATE\s+(TABLE|INDEX))\b/.test(
          upper
        );
      if (!allowed) {
        throw new Error(
          "Allowed: SELECT, WITH, PRAGMA, EXPLAIN, INSERT, UPDATE, DELETE, ALTER, CREATE TABLE/INDEX."
        );
      }
      const blocked =
        /\b(DROP|ATTACH|DETACH|VACUUM|REINDEX|REPLACE\s+INTO|TRUNCATE|GRANT|REVOKE)\b/i;
      if (blocked.test(normalized) && !/^CREATE\s+INDEX\b/i.test(normalized)) {
        throw new Error("That SQL command is not allowed.");
      }

      const isQuery = /^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(normalized);
      if (isQuery) {
        const result = await db.prepare(normalized).all();
        return {
          kind: "query",
          columns: result.results?.[0] ? Object.keys(result.results[0]) : [],
          rows: result.results || [],
          meta: result.meta || null,
        };
      }

      const result = await db.prepare(normalized).run();
      return {
        kind: "exec",
        success: Boolean(result.success ?? true),
        meta: result.meta || null,
        changes: result.meta?.changes ?? result.changes ?? 0,
      };
    },
  };
}

export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...secureHeaders(),
      ...headers,
    },
  });
}

export function errorResponse(error, status = 400, headers = {}) {
  const message = error?.message || "Request failed.";
  const code = error?.status || status;
  return jsonResponse({ error: message, busy: code === 429 || code === 503 }, code, headers);
}
