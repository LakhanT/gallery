import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";
import { faceServiceHealth } from "../../../lib/face-client.js";
import { FACE_EMBEDDING_VERSION, FACE_MODEL, getFaceThresholds } from "../../../lib/face-match.js";
import {
  enqueueFaceIndexMessage,
  hasDurableIndexQueue,
} from "../../../lib/face-queue.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** GET progress + face service health + thresholds (admin calibration). */
export async function onRequestGet(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const progress = await store.getReindexProgress();
    let service = null;
    try {
      service = await faceServiceHealth(context.env);
    } catch (error) {
      service = { ok: false, error: error.message };
    }
    return jsonResponse({
      progress,
      service,
      thresholds: getFaceThresholds(),
      model: FACE_MODEL,
      version: FACE_EMBEDDING_VERSION,
      durableIndexQueue: hasDurableIndexQueue(context.env),
    });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

/**
 * POST body: { limit?, photoId?, retryFailed?, enqueueAll? }
 * - enqueueAll: publish pending photoIds to FACE_INDEX_QUEUE (server consumer drains)
 * - otherwise: processes a small batch inline (admin/debug)
 * Failed photos do not block pending → 0; use retryFailed to reset failures.
 */
export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const body = await readJson(context.request);

    if (body.retryFailed) {
      const reset = await store.retryFailedFaceIndexes();
      const progress = await store.getReindexProgress();
      return jsonResponse({
        retried: true,
        reset: reset.reset,
        progress,
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
      });
    }

    // Server-side path: enqueue identifiers only; Worker consumer + face service do the work.
    if (body.enqueueAll) {
      if (!hasDurableIndexQueue(context.env)) {
        throw Object.assign(
          new Error(
            "Durable index queue is not bound. Deploy Pages with FACE_INDEX_QUEUE, then retry."
          ),
          { status: 503 }
        );
      }
      if (body.resetFailed) {
        await store.retryFailedFaceIndexes();
      }
      const targets = await store.listPhotosNeedingReindex(10_000, {
        includeFailed: Boolean(body.includeFailed),
        includeQueued: false,
      });
      let enqueued = 0;
      for (const photo of targets) {
        try {
          await store.setFaceIndexStatus(photo.id, {
            status: "queued",
            retryCount: 0,
            lastError: null,
            faceCount: 0,
          });
        } catch {
          /* status table optional */
        }
        await enqueueFaceIndexMessage(context.env, { photoId: photo.id, attempt: 1 });
        enqueued += 1;
      }
      const progress = await store.getReindexProgress();
      return jsonResponse({
        enqueued,
        dispatch: "cloudflare-queue",
        message:
          enqueued > 0
            ? `Queued ${enqueued} photos for buffalo_l indexing. The queue consumer drains them on the server.`
            : "Nothing to queue — pending is already empty or already queued.",
        progress,
        model: FACE_MODEL,
        version: FACE_EMBEDDING_VERSION,
      });
    }

    const limit = Math.min(20, Math.max(1, Number(body.limit) || 5));

    const targets = body.photoId
      ? [{ id: body.photoId }]
      : await store.listPhotosNeedingReindex(limit, { includeFailed: false });

    const results = [];
    let facesFound = 0;
    let rejected = 0;
    let errors = 0;
    let completed = 0;

    for (const photo of targets) {
      const outcome = await store.indexPhotoWithFaceService(photo.id, context.env);
      if (outcome.skipped) {
        results.push({ ok: true, ...outcome });
        continue;
      }
      if (outcome.status === "failed" || outcome.ok === false) {
        errors += 1;
        results.push({ ok: false, ...outcome });
        continue;
      }
      completed += 1;
      facesFound += outcome.faceCount || 0;
      rejected += outcome.rejected || 0;
      results.push({ ok: true, ...outcome });
    }

    const progress = await store.getReindexProgress();
    return jsonResponse({
      processed: results.length,
      completed,
      facesFound,
      rejected,
      errors,
      results,
      progress,
      model: FACE_MODEL,
      version: FACE_EMBEDDING_VERSION,
    });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
