/**
 * HTTP client from Cloudflare Pages Functions → Python face service.
 * FACE_SERVICE_API_KEY must never appear in browser/client bundles.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

function serviceUrl(env) {
  const url = (env.FACE_SERVICE_URL || "").replace(/\/$/, "");
  if (!url) {
    throw Object.assign(
      new Error(
        "Face service is not configured. Set FACE_SERVICE_URL (e.g. http://127.0.0.1:8090)."
      ),
      { status: 503 }
    );
  }
  return url;
}

function requireApiKey(env) {
  const key = String(env.FACE_SERVICE_API_KEY || "").trim();
  if (!key) {
    throw Object.assign(
      new Error("Face service is not configured. Set FACE_SERVICE_API_KEY."),
      { status: 503 }
    );
  }
  return key;
}

function authHeaders(env) {
  return {
    "X-API-Key": requireApiKey(env),
  };
}

/** Strip secrets from error text before returning to callers. */
function safeErrorMessage(message, status) {
  let text = typeof message === "string" ? message : "Face service error";
  text = text.replace(/X-API-Key[:\s]*\S+/gi, "X-API-Key=[redacted]");
  text = text.replace(/FACE_SERVICE_API_KEY[=:\s]*\S+/gi, "FACE_SERVICE_API_KEY=[redacted]");
  if (status === 429) {
    return text || "Too many face search requests. Please wait a moment.";
  }
  if (status === 503) {
    return (
      text ||
      "We're processing many face searches right now. Please try again in a few seconds."
    );
  }
  if (status >= 500) {
    return text.includes("Face service") ? text : `Face service unavailable (${status}).`;
  }
  return text;
}

async function parseJsonSafe(response) {
  return response.json().catch(() => ({}));
}

/**
 * @param {Env} env
 * @param {string} path
 * @param {RequestInit} init
 */
async function faceServiceFetch(env, path, init = {}) {
  const base = serviceUrl(env);
  const timeoutMs = Number(env.FACE_SERVICE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...authHeaders(env),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("Face service timed out."), { status: 503 });
    }
    throw Object.assign(
      new Error(safeErrorMessage(error?.message || "Face service unreachable", 503)),
      { status: 503 }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function faceServiceHealth(env) {
  const response = await faceServiceFetch(env, "/health", { method: "GET" });
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw Object.assign(
      new Error(safeErrorMessage(data.detail || data.error || "Face service unhealthy", response.status)),
      { status: 503 }
    );
  }
  return data;
}

/**
 * @param {Env} env
 * @param {Blob|ArrayBuffer|Uint8Array} imageBytes
 * @param {string} [filename]
 * @param {{ lane?: "search"|"index" }} [options]
 */
export async function faceServiceDetectEmbed(
  env,
  imageBytes,
  filename = "photo.jpg",
  options = {}
) {
  const lane = options.lane === "index" ? "index" : "search";
  const form = new FormData();
  const blob =
    imageBytes instanceof Blob
      ? imageBytes
      : new Blob([imageBytes], { type: "image/jpeg" });
  form.append("image", blob, filename);
  form.append("lane", lane);

  const path = lane === "index" ? "/detect-embed-index" : "/detect-embed";
  const response = await faceServiceFetch(env, path, {
    method: "POST",
    headers: {
      "X-Face-Lane": lane,
    },
    body: form,
  });
  const data = await parseJsonSafe(response);
  if (!response.ok) {
    const raw =
      (typeof data.detail === "string" && data.detail) ||
      data.error ||
      `Face service error (${response.status})`;
    const status =
      response.status === 429
        ? 429
        : response.status === 503
          ? 503
          : response.status >= 500
            ? 503
            : 400;
    throw Object.assign(new Error(safeErrorMessage(raw, status)), {
      status,
      retryAfter: Number(response.headers.get("Retry-After")) || undefined,
    });
  }
  return data;
}
