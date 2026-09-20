import { jsonWithCookie, sessionCookie } from "../../../lib/auth.js";
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
    const { token } = await store.loginAdmin(body.password);
    const secure = new URL(context.request.url).protocol === "https:";
    return jsonWithCookie({ ok: true }, 200, sessionCookie(token, { secure }));
  } catch (error) {
    return errorResponse(error, 401);
  }
}
