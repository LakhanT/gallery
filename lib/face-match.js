import {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MATCH_SIMILARITY,
  FACE_MIN_DETECTION_SCORE,
  FACE_MIN_QUALITY_SCORE,
  FACE_MODEL,
  FACE_RANK_DETECTION_WEIGHT,
  FACE_RANK_QUALITY_WEIGHT,
  FACE_UNCERTAIN_SIMILARITY,
} from "./face-config.js";
import { extractEmbedding, isValidArcFaceEmbedding } from "./face-validate.js";

export {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MATCH_SIMILARITY,
  FACE_MIN_DETECTION_SCORE,
  FACE_MIN_QUALITY_SCORE,
  FACE_MODEL,
  FACE_UNCERTAIN_SIMILARITY,
  SCAN_VERSION,
} from "./face-config.js";

/**
 * Cosine similarity for L2-normalized ArcFace embeddings = dot product.
 * Higher is more similar. Rejects non-512-d / FaceNet vectors.
 */
export function cosineSimilarity(a, b) {
  if (!isValidArcFaceEmbedding(a) || !isValidArcFaceEmbedding(b)) return -1;
  let dot = 0;
  for (let i = 0; i < FACE_DIM; i += 1) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

/** @deprecated Prefer cosineSimilarity. Distance = 1 − similarity. */
export function faceDistance(a, b) {
  const sim = cosineSimilarity(a, b);
  if (sim < 0 && a?.length !== FACE_DIM) return 1;
  return Math.max(0, Math.min(2, 1 - sim));
}

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function storedEmbeddings(face) {
  const emb = extractEmbedding(face);
  return emb ? [emb] : [];
}

/**
 * Reject faces below quality/detection floors.
 * Unknown scores (legacy rows) are allowed so old v8 rows remain searchable;
 * new indexes always store scores.
 */
export function isMatchableFace(face, options = {}) {
  const minQuality = options.minQualityScore ?? FACE_MIN_QUALITY_SCORE;
  const minDetection = options.minDetectionScore ?? FACE_MIN_DETECTION_SCORE;
  if (!storedEmbeddings(face).length) return false;

  const quality = face.quality_score ?? face.qualityScore;
  const detection = face.detection_score ?? face.detectionScore;

  if (typeof quality === "number" && Number.isFinite(quality) && quality < minQuality) {
    return false;
  }
  if (typeof detection === "number" && Number.isFinite(detection) && detection < minDetection) {
    return false;
  }
  return true;
}

/**
 * Secondary ranking score. Identity similarity remains primary and is never
 * replaced by quality. Quality/detection only break ties / nudge order.
 */
export function calculateRankingScore(match, options = {}) {
  const similarity = Number(match?.similarity);
  if (!Number.isFinite(similarity)) return -1;
  const wq = options.qualityWeight ?? FACE_RANK_QUALITY_WEIGHT;
  const wd = options.detectionWeight ?? FACE_RANK_DETECTION_WEIGHT;
  const quality = clamp01(match.qualityScore ?? match.quality_score);
  const detection = clamp01(match.detectionScore ?? match.detection_score);
  return similarity + wq * quality + wd * detection;
}

/**
 * Best face-level cosine similarity for a photo vs query embeddings.
 * photo score = strongest matching *matchable* face (multi-person photos).
 */
export function photoBestMatch(queryEmbeddings, faces, options = {}) {
  const queries = (queryEmbeddings || []).filter((v) => isValidArcFaceEmbedding(v));
  let best = {
    similarity: -1,
    rankingScore: -1,
    bbox: null,
    detectionScore: null,
    qualityScore: null,
  };
  for (const face of faces || []) {
    if (!isMatchableFace(face, options)) continue;
    for (const stored of storedEmbeddings(face)) {
      for (const query of queries) {
        const similarity = cosineSimilarity(query, stored);
        const candidate = {
          similarity,
          bbox: face.bbox || null,
          detectionScore: face.detection_score ?? face.detectionScore ?? null,
          qualityScore: face.quality_score ?? face.qualityScore ?? null,
        };
        candidate.rankingScore = calculateRankingScore(candidate, options);
        if (
          candidate.similarity > best.similarity ||
          (candidate.similarity === best.similarity &&
            candidate.rankingScore > best.rankingScore)
        ) {
          best = candidate;
        }
      }
    }
  }
  return best;
}

export function rankFaceMatches(queryEmbeddings, indexEntries, options = {}) {
  const rows = [];
  for (const entry of indexEntries) {
    const best = photoBestMatch(queryEmbeddings, entry.faces || [], options);
    if (best.similarity >= FACE_UNCERTAIN_SIMILARITY) {
      rows.push({
        id: entry.id,
        similarity: best.similarity,
        rankingScore: best.rankingScore,
        distance: 1 - best.similarity,
        name: entry.name || "",
        url: entry.url || "",
        matchedFaceBbox: best.bbox,
        detectionScore: best.detectionScore,
        qualityScore: best.qualityScore,
        category:
          best.similarity >= FACE_MATCH_SIMILARITY ? "match" : "uncertain",
      });
    }
  }
  // Sort by rankingScore (similarity + small quality nudge); identity still gates category
  rows.sort((a, b) => {
    const rs = (b.rankingScore ?? b.similarity) - (a.rankingScore ?? a.similarity);
    if (rs !== 0) return rs;
    return b.similarity - a.similarity;
  });
  return rows;
}

export function splitMatches(rows) {
  const matches = rows.filter((row) => row.similarity >= FACE_MATCH_SIMILARITY);
  const uncertain = rows.filter(
    (row) =>
      row.similarity >= FACE_UNCERTAIN_SIMILARITY && row.similarity < FACE_MATCH_SIMILARITY
  );
  return { matches, uncertain };
}

export function secureHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

export function getFaceThresholds() {
  return {
    model: FACE_MODEL,
    version: FACE_EMBEDDING_VERSION,
    dim: FACE_DIM,
    matchSimilarity: FACE_MATCH_SIMILARITY,
    uncertainSimilarity: FACE_UNCERTAIN_SIMILARITY,
    minDetectionScore: FACE_MIN_DETECTION_SCORE,
    minQualityScore: FACE_MIN_QUALITY_SCORE,
    rankQualityWeight: FACE_RANK_QUALITY_WEIGHT,
    rankDetectionWeight: FACE_RANK_DETECTION_WEIGHT,
    similarityConvention: "cosine_similarity = dot(L2(a), L2(b)); higher is better",
    rankingPolicy:
      "Reject below min quality/detection; rank by similarity then small quality/detection nudge",
  };
}
