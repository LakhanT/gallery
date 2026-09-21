/**
 * Auto-index helpers — queue buffalo_l indexing after upload without blocking the response.
 *
 * PRODUCTION/STAGING: FACE_INDEX_QUEUE (Cloudflare Queues) when bound.
 * LOCAL: waitUntil / background promise fallback.
 */

import { enqueueFaceIndexMessage, hasDurableIndexQueue } from "./face-queue.js";

/** Strip internal upload buffers before sending JSON to the browser. */
export function publicPhoto(photo) {
  if (!photo || typeof photo !== "object") return photo;
  const { _faceIndexBytes, _faceIndexContentType, ...rest } = photo;
  return rest;
}

/**
 * Queue face indexing in the background.
 * On Cloudflare Pages with FACE_INDEX_QUEUE, publishes a durable message.
 * Otherwise uses waitUntil / fire-and-forget (local only).
 *
 * @param {object} store
 * @param {object} photo — may include _faceIndexBytes from addPhoto
 * @param {object} env — FACE_SERVICE_URL + FACE_SERVICE_API_KEY (+ optional FACE_INDEX_QUEUE)
 * @param {function} [waitUntil]
 */
export function queueFaceIndex(store, photo, env, waitUntil) {
  if (!photo?.id) return null;
  if (!env?.FACE_SERVICE_URL || !String(env.FACE_SERVICE_API_KEY || "").trim()) {
    return null;
  }
  if (typeof store.indexPhotoWithFaceService !== "function") return null;

  if (hasDurableIndexQueue(env)) {
    const send = enqueueFaceIndexMessage(env, { photoId: photo.id, attempt: 1 }).catch(
      (error) => {
        console.error("[face-auto-index:queue]", photo.id, error?.message || error);
        return { ok: false, id: photo.id, error: error?.message };
      }
    );
    if (typeof waitUntil === "function") waitUntil(send);
    return send;
  }

  const job = store
    .indexPhotoWithFaceService(photo.id, env, {
      bytes: photo._faceIndexBytes,
      contentType: photo._faceIndexContentType,
      lane: "index",
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
