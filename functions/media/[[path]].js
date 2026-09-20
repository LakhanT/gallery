import { createStore } from "../../lib/store.js";
import { secureHeaders } from "../../lib/face-match.js";

export async function onRequestGet(context) {
  const segments = context.params.path;
  const r2Key = Array.isArray(segments) ? segments.join("/") : String(segments || "");
  if (!r2Key || r2Key.includes("..")) {
    return new Response("Not found", { status: 404, headers: secureHeaders() });
  }

  const object = await context.env.PHOTOS.get(r2Key);
  if (!object) {
    return new Response("Not found", { status: 404, headers: secureHeaders() });
  }

  const headers = new Headers(
    secureHeaders({
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    })
  );

  return new Response(object.body, { headers });
}
