import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** Full face index is never exposed to clients. */
export async function onRequestGet() {
  return errorResponse(
    Object.assign(new Error("Face index is not publicly available."), { status: 403 }),
    403
  );
}

export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const body = await readJson(context.request);
    const record = await store.upsertFaceRecord(body.id, body.faces, body.version, null);
    return jsonResponse({ record });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestDelete(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const url = new URL(context.request.url);
    await store.removeFaceRecord(url.searchParams.get("id"));
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
