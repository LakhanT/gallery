import { createStore, errorResponse, jsonResponse } from "../../lib/store.js";
import { publicPhoto, queueFaceIndex } from "../../lib/face-auto-index.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequestGet(context) {
  try {
    const origin = new URL(context.request.url).origin;
    const store = createStore(context.env, origin);
    return jsonResponse(await store.getGallery());
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestPost(context) {
  try {
    const origin = new URL(context.request.url).origin;
    const store = createStore(context.env, origin);
    const body = await readJson(context.request);
    const photo = await store.addPhoto(body, null);
    // Background buffalo_l index — upload response stays fast
    queueFaceIndex(store, photo, context.env, context.waitUntil?.bind(context));
    return jsonResponse({ photo: publicPhoto(photo), faceIndex: "queued" });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestPatch(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const body = await readJson(context.request);
    const name = await store.renamePhoto(body.id, body.name, null);
    return jsonResponse({ name });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestDelete(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const url = new URL(context.request.url);
    await store.removePhoto(url.searchParams.get("url"), null);
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
