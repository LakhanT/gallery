import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

/**
 * Public face upsert disabled — indexing is admin/server-side only (buffalo_l).
 * Prevents mixing FaceNet visitor indexes with ArcFace v8.
 */
export async function onRequestGet() {
  return errorResponse(
    Object.assign(new Error("Face index is not publicly available."), { status: 403 }),
    403
  );
}

export async function onRequestPost() {
  return errorResponse(
    Object.assign(
      new Error("Public face indexing is disabled. Use Admin → Re-index faces."),
      { status: 403 }
    ),
    403
  );
}

export async function onRequestDelete(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const url = new URL(context.request.url);
    await store.removeFaceRecord(url.searchParams.get("id"));
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
