import { clearUserSessionCookie, jsonWithCookie } from "../../../lib/auth.js";
import { createStore, errorResponse } from "../../../lib/store.js";

export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.logoutUser(context.request);
    return jsonWithCookie({ ok: true }, 200, clearUserSessionCookie());
  } catch (error) {
    return errorResponse(error);
  }
}
