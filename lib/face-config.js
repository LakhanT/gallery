/**
 * Face recognition config — InsightFace buffalo_l (ArcFace 512-d).
 * Similarity convention: cosine_similarity = dot(L2(a), L2(b)); higher is better.
 * Do NOT reuse FaceNet Euclidean thresholds (0.55 / 0.68).
 *
 * Detection/quality thresholds must stay aligned with face-service/config.py
 * (FACE_MATCH_SIMILARITY, FACE_UNCERTAIN_SIMILARITY, FACE_MIN_*, FACE_PROVIDERS).
 */

export const FACE_MODEL = "insightface-buffalo-l";
export const FACE_EMBEDDING_VERSION = 8;
export const FACE_DIM = 512;

/** Confident match: cosine similarity >= this */
export const FACE_MATCH_SIMILARITY = 0.42;

/** Uncertain / admin review band: [uncertain, match) */
export const FACE_UNCERTAIN_SIMILARITY = 0.32;

export const FACE_MIN_DETECTION_SCORE = 0.5;
export const FACE_MIN_QUALITY_SCORE = 0.25;

/**
 * Secondary ranking weights (must stay small so quality cannot overpower identity).
 * rankingScore ≈ similarity + wq*quality + wd*detection
 */
export const FACE_RANK_QUALITY_WEIGHT = 0.04;
export const FACE_RANK_DETECTION_WEIGHT = 0.02;

/** Max automatic retries before a photo stays in failed (admin can Retry failed). */
export const FACE_REINDEX_MAX_AUTO_RETRIES = 3;

/** @deprecated Use FACE_EMBEDDING_VERSION — kept for older UI labels */
export const SCAN_VERSION = FACE_EMBEDDING_VERSION;
