/**
 * Lightweight in-isolate rate limiter for Pages Functions / Vite.
 * Privacy-conscious: hashes IP + optional event token; no PII stored beyond short window.
 */

const buckets = new Map();

function prune(now, windowMs) {
  if (buckets.size < 5000) return;
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart > windowMs * 2) buckets.delete(key);
  }
}

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 * @returns {{ ok: boolean, remaining: number, retryAfterSec: number }}
 */
export function consumeRateLimit(key, { limit = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  prune(now, windowMs);
  let entry = buckets.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { windowStart: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;
  const remaining = Math.max(0, limit - entry.count);
  if (entry.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - entry.windowStart)) / 1000));
    return { ok: false, remaining: 0, retryAfterSec };
  }
  return { ok: true, remaining, retryAfterSec: 0 };
}

export async function clientKeyFromRequest(request) {
  const eventToken =
    request.headers.get("x-event-token") ||
    request.headers.get("x-gallery-session") ||
    "";
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const raw = `${eventToken || "anon"}|${ip}`;
  // Short hash — avoid storing raw IP in logs elsewhere
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `rl_${h.toString(16)}`;
}
