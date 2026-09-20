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
    const consent = await store.createConsent({
      fullName: body.fullName,
      agreed: body.agreed,
      userAgent: context.request.headers.get("User-Agent") || "",
    });
    return jsonResponse({ consent });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
