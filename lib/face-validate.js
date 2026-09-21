/**
 * Invariants for searchable ArcFace buffalo_l face records.
 * FaceNet / wrong dim / wrong model must never become searchable.
 */

import {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MODEL,
} from "./face-config.js";

/** True if vector is a finite 512-d ArcFace embedding (no pad/truncate). */
export function isValidArcFaceEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== FACE_DIM) return false;
  for (let i = 0; i < FACE_DIM; i += 1) {
    const n = embedding[i];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  return true;
}

/** Extract the primary embedding from a stored face object, or null. */
export function extractEmbedding(face) {
  if (isValidArcFaceEmbedding(face?.embedding)) return face.embedding;
  if (isValidArcFaceEmbedding(face?.descriptor)) return face.descriptor;
  if (isValidArcFaceEmbedding(face?.descriptors?.[0])) return face.descriptors[0];
  return null;
}

/**
 * Normalize faces for D1 upsert. Drops invalid vectors; never pads/truncates.
 * Empty array is allowed (photo indexed, zero accepted faces).
 */
export function sanitizeFacesForStorage(faces) {
  const out = [];
  for (const face of faces || []) {
    const embedding = extractEmbedding(face);
    if (!embedding) continue;
    out.push({
      embedding,
      descriptors: [embedding],
      descriptor: embedding,
      bbox: face.bbox || null,
      detection_score: face.detection_score ?? face.detectionScore ?? null,
      quality_score: face.quality_score ?? face.qualityScore ?? null,
    });
  }
  return out;
}

/**
 * Validate meta + faces before writing a searchable face_records row.
 * @throws {Error} with status 400 on violation
 */
export function assertSearchableFaceWrite(faces, meta = {}) {
  const model = meta.model || FACE_MODEL;
  const embeddingVersion = Number(meta.embeddingVersion ?? meta.version) || 0;

  if (model !== FACE_MODEL) {
    throw Object.assign(
      new Error(`Invalid face model "${model}". Expected ${FACE_MODEL}.`),
      { status: 400 }
    );
  }
  if (embeddingVersion !== FACE_EMBEDDING_VERSION) {
    throw Object.assign(
      new Error(
        `Invalid embedding_version ${embeddingVersion}. Expected ${FACE_EMBEDDING_VERSION}.`
      ),
      { status: 400 }
    );
  }

  for (const face of faces || []) {
    const embedding = extractEmbedding(face);
    if (!embedding) {
      throw Object.assign(
        new Error(
          `Invalid face embedding: only ${FACE_DIM}-d ArcFace (${FACE_MODEL} v${FACE_EMBEDDING_VERSION}) is allowed.`
        ),
        { status: 400 }
      );
    }
    if (Array.isArray(face?.embedding) && face.embedding.length !== FACE_DIM) {
      throw Object.assign(
        new Error(
          `Rejected ${face.embedding.length}-d embedding. Do not convert FaceNet/other dims to ArcFace.`
        ),
        { status: 400 }
      );
    }
  }
}

/**
 * Filter query descriptors for search — only 512-d ArcFace.
 */
export function filterQueryEmbeddings(descriptors) {
  return (descriptors || []).filter((item) => isValidArcFaceEmbedding(item));
}

/**
 * Validate approval "Same" merge descriptors.
 * @returns {number[][]} only valid 512-d vectors
 * @throws if none valid when decision requires merge
 */
export function validateApprovalEmbeddings(descriptors) {
  const valid = filterQueryEmbeddings(descriptors);
  const rejected = (descriptors || []).filter((d) => !isValidArcFaceEmbedding(d));
  if (rejected.length && !valid.length) {
    throw Object.assign(
      new Error(
        "Approval merge rejected: query embeddings are not valid buffalo_l ArcFace (need length 512, model insightface-buffalo-l, version 8)."
      ),
      { status: 400 }
    );
  }
  if (rejected.length) {
    throw Object.assign(
      new Error(
        `Approval merge rejected: ${rejected.length} invalid embedding(s) (wrong length/model). Only ${FACE_DIM}-d ArcFace v${FACE_EMBEDDING_VERSION} allowed.`
      ),
      { status: 400 }
    );
  }
  return valid;
}
