import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequestGet(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const status = new URL(context.request.url).searchParams.get("status") || "pending";
    const approvals = await store.listApprovals(status);
    const counts = await store.approvalCounts();
    return jsonResponse({ approvals, counts });
  } catch (error) {
    return errorResponse(error, error.status || 401);
  }
}

export async function onRequestPatch(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const body = await readJson(context.request);
    const result = await store.resolveApproval(body.id, body.decision);
    const counts = await store.approvalCounts();
    return jsonResponse({ ...result, counts });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
