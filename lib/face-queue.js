/**
 * Cloudflare Queues helpers for face search / index.
 *
 * PRODUCTION / STAGING: Pages produces to FACE_SEARCH_QUEUE / FACE_INDEX_QUEUE;
 * a separate Worker (workers/face-queue-consumer.js) consumes durably.
 *
 * LOCAL: no queue bindings → in-memory gateway dispatcher (face-search-job.js).
 *
 * Queue messages contain ONLY identifiers — never selfie bytes, embeddings, or API keys.
 */

export const QUEUE_MSG_VERSION = 1;

export const SEARCH_QUEUE_NAME = "gallery-face-search";
export const SEARCH_DLQ_NAME = "gallery-face-search-dlq";
export const INDEX_QUEUE_NAME = "gallery-face-index";
export const INDEX_DLQ_NAME = "gallery-face-index-dlq";

export function hasDurableSearchQueue(env = {}) {
  return Boolean(env?.FACE_SEARCH_QUEUE?.send);
}

export function hasDurableIndexQueue(env = {}) {
  return Boolean(env?.FACE_INDEX_QUEUE?.send);
}

export function tempSelfieObjectKey(jobId) {
  return `tmp/face-search/${jobId}`;
}

export function buildSearchQueueMessage({ jobId, objectKey, attempt = 1 }) {
  return {
    type: "face-search",
    jobId: String(jobId),
    objectKey: String(objectKey || tempSelfieObjectKey(jobId)),
    attempt: Number(attempt) || 1,
    version: QUEUE_MSG_VERSION,
  };
}

export function buildIndexQueueMessage({ photoId, attempt = 1 }) {
  return {
    type: "face-index",
    photoId: String(photoId),
    attempt: Number(attempt) || 1,
    version: QUEUE_MSG_VERSION,
  };
}

/** Reject payloads that accidentally include sensitive fields. */
export function assertSafeQueuePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Queue payload must be an object.");
  }
  const banned = ["image", "bytes", "selfie", "embedding", "embeddings", "apiKey", "api_key"];
  for (const key of banned) {
    if (key in payload) {
      throw new Error(`Queue payload must not include "${key}".`);
    }
  }
  return payload;
}

/**
 * Publish a face-search job to Cloudflare Queues when bound.
 * @returns {Promise<boolean>} true if durable queue send succeeded
 */
export async function enqueueFaceSearchMessage(env, message) {
  if (!hasDurableSearchQueue(env)) return false;
  const body = assertSafeQueuePayload(buildSearchQueueMessage(message));
  await env.FACE_SEARCH_QUEUE.send(body);
  return true;
}

/**
 * Publish a face-index job to Cloudflare Queues when bound.
 * @returns {Promise<boolean>} true if durable queue send succeeded
 */
export async function enqueueFaceIndexMessage(env, message) {
  if (!hasDurableIndexQueue(env)) return false;
  const body = assertSafeQueuePayload(buildIndexQueueMessage(message));
  await env.FACE_INDEX_QUEUE.send(body);
  return true;
}

export function isTransientFaceError(error) {
  const status = Number(error?.status) || 0;
  if (status === 429 || status === 503 || status >= 500) return true;
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("temporar") ||
    msg.includes("unavailable") ||
    msg.includes("capacity") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}

export function isPermanentFaceError(error) {
  const status = Number(error?.status) || 0;
  if ([400, 401, 403, 404, 410, 413, 415, 422].includes(status)) return true;
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("no clear face") ||
    msg.includes("quality") ||
    msg.includes("too large") ||
    msg.includes("unsupported") ||
    msg.includes("corrupt") ||
    msg.includes("expired") ||
    msg.includes("invalid image") ||
    msg.includes("malformed")
  );
}
