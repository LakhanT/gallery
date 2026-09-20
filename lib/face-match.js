export const MATCH_DISTANCE = 0.55;
export const UNCERTAIN_DISTANCE = 0.68;

/**
 * FaceNet (128-d): Euclidean distance.
 * ArcFace (512-d): cosine distance = 1 − cos(θ) for L2-normalized vectors.
 */
export function faceDistance(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 64) return 1;
  if (a.length >= 256) {
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return Math.max(0, Math.min(2, 1 - dot));
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function storedDescriptors(face) {
  const raw =
    Array.isArray(face?.descriptors) && face.descriptors.length
      ? face.descriptors
      : face?.descriptor
        ? [face.descriptor]
        : [];
  return raw.filter((item) => Array.isArray(item) && item.length >= 64);
}

/** Best same-dimension descriptor-pair distance for a photo. */
function photoMatchDistance(queryDescriptors, faces) {
  const queries = (queryDescriptors || []).filter((item) => item?.length >= 64);
  let best = Infinity;
  for (const face of faces || []) {
    for (const stored of storedDescriptors(face)) {
      for (const query of queries) {
        if (query.length !== stored.length) continue;
        const distance = faceDistance(query, stored);
        if (distance < best) best = distance;
      }
    }
  }
  return best;
}

export function rankFaceMatches(queryDescriptors, indexEntries) {
  const rows = [];
  for (const entry of indexEntries) {
    const distance = photoMatchDistance(queryDescriptors, entry.faces || []);
    if (Number.isFinite(distance)) {
      rows.push({
        id: entry.id,
        distance,
        name: entry.name || "",
        url: entry.url || "",
      });
    }
  }
  rows.sort((a, b) => a.distance - b.distance);
  return rows;
}

export function splitMatches(rows) {
  const matches = rows.filter((row) => row.distance <= MATCH_DISTANCE);
  const uncertain = rows.filter(
    (row) => row.distance > MATCH_DISTANCE && row.distance <= UNCERTAIN_DISTANCE
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
