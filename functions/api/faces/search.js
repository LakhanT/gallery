import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";
import { clientKeyFromRequest, consumeRateLimit } from "../../../lib/rate-limit.js";
import {
  acceptFaceSearchJob,
  publicJobView,
} from "../../../lib/face-search-job.js";

/**
 * Public face search — async job accept.
 *
 * POST multipart selfie → 202 { jobId, status: "queued" }
 * Browser polls GET /api/faces/search/:jobId
 *
 * Does NOT hold the HTTP request open for buffalo_l.
 * Gallery browsing is unaffected.
 */
export async function onRequestPost(context) {
  const requestId = crypto.randomUUID?.() || String(Date.now());
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const contentType = context.request.headers.get("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
      throw Object.assign(
        new Error(
          "Public face search requires multipart/form-data with an image field. Client-supplied embeddings are not accepted."
        ),
        { status: 400 }
      );
    }

    const limit = Number(context.env.FACE_SEARCH_RATE_LIMIT) || 20;
    const windowMs = Number(context.env.FACE_SEARCH_RATE_WINDOW_MS) || 60_000;
    const key = await clientKeyFromRequest(context.request);
    const rl = consumeRateLimit(key, { limit, windowMs });
    if (!rl.ok) {
      return errorResponse(
        Object.assign(
          new Error(
            "Too many face searches from this device. Please wait a few seconds and try again."
          ),
          { status: 429 }
        ),
        429,
        { "Retry-After": String(rl.retryAfterSec || 3) }
      );
    }

    const form = await context.request.formData();
    const file = form.get("image") || form.get("file");
    if (!file || typeof file === "string") {
      throw Object.assign(new Error("Upload a selfie image."), { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const schedule = (fn) => {
      if (typeof context.waitUntil === "function") {
        context.waitUntil(
          Promise.resolve()
            .then(fn)
            .catch(() => {})
        );
      } else {
        Promise.resolve()
          .then(fn)
          .catch(() => {});
      }
    };

    let accepted;
    try {
      accepted = await acceptFaceSearchJob({
        store,
        env: context.env,
        imageBytes: bytes,
        contentType: file.type || "image/jpeg",
        filename: file.name || "selfie.jpg",
        clientKey: key,
        schedule,
      });
    } catch (error) {
      if (error.status === 503 || error.status === 429) {
        return errorResponse(
          Object.assign(
            new Error(
              error.message ||
                "We're processing many requests right now. Please try again in a few seconds."
            ),
            { status: error.status }
          ),
          error.status,
          { "Retry-After": String(error.retryAfter || 5) }
        );
      }
      throw error;
    }

    return jsonResponse(
      {
        ...accepted.body,
        requestId,
        async: true,
      },
      accepted.httpStatus,
      accepted.httpStatus === 202 || accepted.httpStatus === 503
        ? { "Retry-After": "2" }
        : {}
    );
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

/** Optional: GET /api/faces/search?jobId=… when dynamic route is unavailable. */
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const jobId = url.searchParams.get("jobId") || url.searchParams.get("id");
    if (!jobId) {
      throw Object.assign(new Error("Missing jobId."), { status: 400 });
    }
    const store = createStore(context.env, url.origin);
    const job = await store.getFaceSearchJob(jobId);
    if (!job) {
      throw Object.assign(new Error("Search job not found or expired."), { status: 404 });
    }
    return jsonResponse(publicJobView(job, context.env));
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
