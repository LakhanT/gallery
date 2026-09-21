/**
 * Auto-index helpers — queue buffalo_l indexing after upload without blocking the response.
 */

/** Strip internal upload buffers before sending JSON to the browser. */
export function publicPhoto(photo) {
  if (!photo || typeof photo !== "object") return photo;
  const { _faceIndexBytes, _faceIndexContentType, ...rest } = photo;
  return rest;
}

/**
 * Queue face indexing in the background.
 * On Cloudflare Pages, pass context.waitUntil so work continues after the response.
 * Locally, the promise runs without awaiting the upload response.
 *
 * @param {object} store
 * @param {object} photo — may include _faceIndexBytes from addPhoto
 * @param {object} env — FACE_SERVICE_URL + FACE_SERVICE_API_KEY
 * @param {function} [waitUntil]
 */
export function queueFaceIndex(store, photo, env, waitUntil) {
  if (!photo?.id) return null;
  if (!env?.FACE_SERVICE_URL || !String(env.FACE_SERVICE_API_KEY || "").trim()) {
    return null;
  }
  if (typeof store.indexPhotoWithFaceService !== "function") return null;

  const job = store
    .indexPhotoWithFaceService(photo.id, env, {
      bytes: photo._faceIndexBytes,
      contentType: photo._faceIndexContentType,
    })
    .catch((error) => {
      console.error("[face-auto-index]", photo.id, error?.message || error);
      return { ok: false, id: photo.id, error: error?.message };
    });

  if (typeof waitUntil === "function") {
    waitUntil(job);
  }
  return job;
}
