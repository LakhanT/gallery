import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const body = await readJson(context.request);
    const result = await store.saveMyPhoto(context.request, body);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
