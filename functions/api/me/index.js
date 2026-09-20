import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

export async function onRequestGet(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const user = await store.getCurrentUser(context.request);
    return jsonResponse({ user });
  } catch (error) {
    return errorResponse(error, error.status || 401);
  }
}
