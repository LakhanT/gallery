import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

export async function onRequestGet(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const counts = await store.approvalCounts();
    return jsonResponse({ ok: true, admin: true, counts });
  } catch (error) {
    return errorResponse(error, error.status || 401);
  }
}
