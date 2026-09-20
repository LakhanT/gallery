import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

export async function onRequestGet(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    return jsonResponse({ versions: await store.getFaceVersions() });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
