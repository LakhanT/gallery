import { jsonWithCookie, userSessionCookie } from "../../../lib/auth.js";
import { createStore, errorResponse } from "../../../lib/store.js";

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
    const { token, user } = await store.registerUser(body);
    const secure = new URL(context.request.url).protocol === "https:";
    return jsonWithCookie({ user }, 200, userSessionCookie(token, { secure }));
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
