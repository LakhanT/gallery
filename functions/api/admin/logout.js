import { clearSessionCookie, jsonWithCookie } from "../../../lib/auth.js";
import { createStore, errorResponse } from "../../../lib/store.js";

export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.logoutAdmin(context.request);
    return jsonWithCookie({ ok: true }, 200, clearSessionCookie());
  } catch (error) {
    return errorResponse(error);
  }
}
