import { createStore, errorResponse, jsonResponse } from "../../lib/store.js";

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
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      throw new Error("No uncertain matches to review.");
    }
    const safe = items.slice(0, 20).map((item) => ({
      ...item,
      queryDescriptors: Array.isArray(item.queryDescriptors)
        ? item.queryDescriptors.slice(0, 4)
        : [],
    }));
    const result = await store.createApprovals(safe);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
