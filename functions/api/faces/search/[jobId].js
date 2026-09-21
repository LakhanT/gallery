import { createStore, errorResponse, jsonResponse } from "../../../../lib/store.js";
import { publicJobView } from "../../../../lib/face-search-job.js";

/**
 * Poll async face-search job status.
 * GET /api/faces/search/:jobId
 *
 * Returns queued | processing | completed | failed.
 * Never returns embeddings or selfie bytes.
 */
export async function onRequestGet(context) {
  try {
    const jobId = context.params?.jobId;
    if (!jobId) {
      throw Object.assign(new Error("Missing job id."), { status: 400 });
    }
    const store = createStore(context.env, new URL(context.request.url).origin);
    const job = await store.getFaceSearchJob(jobId);
    if (!job) {
      throw Object.assign(new Error("Search job not found or expired."), { status: 404 });
    }
    if (job.expiresAt && Date.parse(job.expiresAt) < Date.now() && job.status !== "completed") {
      throw Object.assign(new Error("Search job expired. Please try again."), { status: 410 });
    }
    return jsonResponse(publicJobView(job, context.env));
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
