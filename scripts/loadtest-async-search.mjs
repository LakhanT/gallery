#!/usr/bin/env node
/**
 * Async face-search load test (job accept + poll).
 *
 * Measures gateway queue stability — NOT raw buffalo_l RPS.
 *
 * Usage:
 *   node scripts/loadtest-async-search.mjs --base http://127.0.0.1:5173 --image .data/tmp/test-face.jpg --users 100
 *
 * Flags:
 *   --users 100,300,500     comma list of burst sizes
 *   --accept-only           accept jobs but do not wait for completion (safe for 3000)
 *   --max-inflight 50       max concurrent POSTs during the burst
 *   --poll-timeout-ms       per-job wait when not accept-only (default 120000)
 *
 * Do NOT claim 3000-user capacity unless results demonstrate stability.
 * Do NOT run huge real-inference bursts against a laptop --accept-only for 1000+.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const base = (arg("base", "http://127.0.0.1:5173") || "").replace(/\/$/, "");
const imagePath = resolve(arg("image", ".data/tmp/test-face.jpg"));
const userLevels = (arg("users", "100") || "100")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);
const acceptOnly = process.argv.includes("--accept-only");
const maxInflight = Number(arg("max-inflight", "50")) || 50;
const pollTimeoutMs = Number(arg("poll-timeout-ms", "120000")) || 120000;

if (acceptOnly) {
  console.warn(
    "NOTE: --accept-only measures gateway acceptance. Start Vite with FACE_SEARCH_SKIP_PROCESS=1 so 3000 jobs do not invoke buffalo_l."
  );
}

const imageBytes = readFileSync(imagePath);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function postJob(uniqueSalt) {
  // Slightly mutate bytes so SHA cache does not collapse the whole burst into one job
  const buf = Buffer.from(imageBytes);
  if (uniqueSalt != null) {
    buf[buf.length - 1] = (buf[buf.length - 1] + (uniqueSalt % 200)) & 0xff;
  }
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/jpeg" }), "bench.jpg");
  const t0 = performance.now();
  // Unique event token per simulated attendee (rate limit is per client key)
  const res = await fetch(`${base}/api/faces/search`, {
    method: "POST",
    body: form,
    headers: { "x-event-token": `loadtest-user-${uniqueSalt}` },
  });
  const ms = performance.now() - t0;
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ms, jobId: body.jobId, body };
}

async function pollJob(jobId) {
  const t0 = performance.now();
  let delay = 800;
  while (performance.now() - t0 < pollTimeoutMs) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(4000, Math.floor(delay * 1.35) + Math.floor(Math.random() * 200));
    let res = await fetch(`${base}/api/faces/search/${encodeURIComponent(jobId)}`);
    if (res.status === 404) {
      res = await fetch(`${base}/api/faces/search?jobId=${encodeURIComponent(jobId)}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) continue;
    if (body.status === "completed" || body.status === "failed") {
      return { status: body.status, waitMs: performance.now() - t0, error: body.error };
    }
  }
  return { status: "timeout", waitMs: performance.now() - t0 };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function runLevel(users) {
  const ids = Array.from({ length: users }, (_, i) => i);
  const tBurst = performance.now();
  const accepts = await mapPool(ids, maxInflight, async (_u, idx) => {
    try {
      return await postJob(idx + 1);
    } catch (e) {
      return { status: 0, ms: 0, error: e.message };
    }
  });
  const burstMs = performance.now() - tBurst;

  let accepted = 0;
  let rejected429 = 0;
  let rejected503 = 0;
  let errors = 0;
  const acceptLat = [];
  const jobIds = [];

  for (const a of accepts) {
    if (a.status === 202 || (a.status === 200 && a.jobId)) {
      accepted += 1;
      acceptLat.push(a.ms);
      if (a.jobId) jobIds.push(a.jobId);
    } else if (a.status === 429) rejected429 += 1;
    else if (a.status === 503) rejected503 += 1;
    else errors += 1;
  }

  const summary = {
    users,
    accepted,
    rejected429,
    rejected503,
    errors,
    accept_rps: +(accepted / (burstMs / 1000)).toFixed(2),
    accept_p50_ms: +percentile([...acceptLat].sort((a, b) => a - b), 50).toFixed(1),
    accept_p95_ms: +percentile([...acceptLat].sort((a, b) => a - b), 95).toFixed(1),
    burst_s: +(burstMs / 1000).toFixed(2),
  };

  if (acceptOnly) {
    return { ...summary, completed: null, failed: null, timed_out: null, note: "accept-only" };
  }

  const polls = await mapPool(jobIds, Math.min(40, jobIds.length || 1), async (jobId) => {
    try {
      return await pollJob(jobId);
    } catch {
      return { status: "error", waitMs: 0 };
    }
  });

  const waits = [];
  let completed = 0;
  let failed = 0;
  let timedOut = 0;
  for (const p of polls) {
    if (p.status === "completed") {
      completed += 1;
      waits.push(p.waitMs);
    } else if (p.status === "failed") failed += 1;
    else timedOut += 1;
  }
  waits.sort((a, b) => a - b);

  return {
    ...summary,
    completed,
    failed,
    timed_out: timedOut,
    wait_p50_ms: +percentile(waits, 50).toFixed(1),
    wait_p95_ms: +percentile(waits, 95).toFixed(1),
    wait_p99_ms: +percentile(waits, 99).toFixed(1),
    wait_avg_ms: waits.length ? +(waits.reduce((s, x) => s + x, 0) / waits.length).toFixed(1) : 0,
  };
}

console.log(
  JSON.stringify(
    {
      base,
      image: imagePath,
      acceptOnly,
      maxInflight,
      measured_worker_rps_hint: 0.48,
      note: "Traffic capacity ≠ inference capacity. Queue absorbs bursts.",
    },
    null,
    2
  )
);

for (const n of userLevels) {
  if (n >= 1000 && !acceptOnly) {
    console.warn(
      `Skipping users=${n} without --accept-only (would run real buffalo_l completions). Re-run with --accept-only.`
    );
    continue;
  }
  if (n >= 3000 && !acceptOnly) {
    console.warn(`users=${n} requires --accept-only on local machines.`);
    continue;
  }
  // Clear prior queued accept-only jobs so MAX_SEARCH_QUEUE is measured per level
  if (acceptOnly) {
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        resolve(".data/face-search-jobs.json"),
        JSON.stringify({ jobs: [] }),
        "utf8"
      );
    } catch {
      /* ignore */
    }
  }
  const row = await runLevel(n);
  console.log(JSON.stringify(row));
}

console.log(`
Interpretation:
- High accepted + low 503 at users=3000 with --accept-only ⇒ gateway can absorb the burst.
- Completion rate / wait times need a real worker farm (or small --users without accept-only).
- estimated_wall_time_for_3000 ≈ 3000 / (stable_rps_per_instance × instances × 0.6)
- Do NOT claim production readiness from this script alone.
`);
