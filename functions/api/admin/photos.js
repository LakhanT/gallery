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
    const url = new URL(context.request.url);
    const includeHidden = url.searchParams.get("includeHidden") !== "0";
    const photos = await store.listAdminPhotos({ includeHidden });
    return jsonResponse({ photos });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const body = await readJson(context.request);
    const photo = await store.addPhoto(body);
    return jsonResponse({ photo });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestPatch(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const body = await readJson(context.request);
    const action = String(body.action || "").toLowerCase();
    const target = body.url || body.id;
    if (action === "hide") {
      return jsonResponse({ photo: await store.hidePhoto(target) });
    }
    if (action === "restore") {
      return jsonResponse({ photo: await store.restorePhoto(target) });
    }
    throw new Error('Use action "hide" or "restore".');
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}

export async function onRequestDelete(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);
    const url = new URL(context.request.url);
    const target = url.searchParams.get("url") || url.searchParams.get("id");
    const mode = (url.searchParams.get("mode") || "hard").toLowerCase();
    if (mode === "soft" || mode === "hide") {
      return jsonResponse({ photo: await store.hidePhoto(target), ok: true });
    }
    await store.removePhoto(target, { kind: "admin" });
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
