const SESSION_DAYS = 7;
const ADMIN_COOKIE = "gallery_admin";
const USER_COOKIE = "gallery_user";

export function getAdminPassword(env) {
  const password = env?.ADMIN_PASSWORD;
  if (!password) {
    throw Object.assign(new Error("Admin password is not configured on the server."), {
      status: 500,
    });
  }
  return password;
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function getCookie(request, name) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return cookies[name] || "";
}

export function getSessionToken(request) {
  return getCookie(request, ADMIN_COOKIE);
}

export function getUserSessionToken(request) {
  return getCookie(request, USER_COOKIE);
}

export async function hashValue(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSalt() {
  return createSessionToken().slice(0, 32);
}

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sessionExpiryIso(days = SESSION_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function buildCookie(name, token, { secure = false, maxAgeSeconds = SESSION_DAYS * 24 * 60 * 60 } = {}) {
  return [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function sessionCookie(token, options = {}) {
  return buildCookie(ADMIN_COOKIE, token, options);
}

export function userSessionCookie(token, options = {}) {
  return buildCookie(USER_COOKIE, token, options);
}

export function clearSessionCookie() {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearUserSessionCookie() {
  return `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function jsonWithCookie(data, status, setCookie) {
  const headers = { "Content-Type": "application/json" };
  if (setCookie) {
    if (Array.isArray(setCookie)) {
      // Multiple Set-Cookie isn't portable via Headers append in all runtimes;
      // use the first and note callers should prefer single cookie responses.
      headers["Set-Cookie"] = setCookie[0];
    } else {
      headers["Set-Cookie"] = setCookie;
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    photoUrl: row.photo_url || row.photoUrl || null,
    hasPhoto: Boolean(row.photo_url || row.photoUrl),
    createdAt: row.created_at || row.createdAt,
  };
}
