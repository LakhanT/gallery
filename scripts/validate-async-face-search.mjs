#!/usr/bin/env node
/**
 * Local validation suite for async face search.
 * Does NOT deploy. Does NOT hit production.
 *
 * Usage:
 *   node scripts/validate-async-face-search.mjs --base http://127.0.0.1:5173 --image .data/tmp/test-face.jpg
 *
 * Modes via Vite env (restart Vite as needed):
 *   (default)           real buffalo_l completions
 *   FACE_SEARCH_SYNTHETIC=1   drain without buffalo_l
 *   FACE_SEARCH_SKIP_PROCESS=1  accept only
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const base = (arg("base", "http://127.0.0.1:5173") || "").replace(/\/$/, "");
const faceBase = (arg("face", "http://127.0.0.1:8090") || "").replace(/\/$/, "");
const faceKey = arg("key", process.env.FACE_SERVICE_API_KEY || "test-secret-123");
const imagePath = resolve(arg("image", ".data/tmp/test-face.jpg"));
const only = arg("only", ""); // e.g. restart,dup,overload,priority,complete25,synth
const imageBytes = readFileSync(imagePath);

const JOBS_PATH = resolve(".data/face-search-jobs.json");
const TMP_DIR = resolve(".data/tmp/face-search");

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function clearJobs() {
  writeFileSync(JOBS_PATH, JSON.stringify({ jobs: [] }));
}

function readJobs() {
  try {
    return JSON.parse(readFileSync(JOBS_PATH, "utf8")).jobs || [];
  } catch {
    return [];
  }
}

function countTmpFiles() {
  try {
    return readdirSync(TMP_DIR).filter((f) => f.endsWith(".bin")).length;
  } catch {
    return 0;
  }
}

async function postJob({ salt = 0, sameImage = false, token = null } = {}) {
  const buf = Buffer.from(imageBytes);
  if (!sameImage && salt != null) {
    // Spread uniqueness across more bytes so bursts don't collapse into ~200 SHA buckets
    const s = Number(salt) || 0;
    buf[buf.length - 1] = (buf[buf.length - 1] + (s % 251)) & 0xff;
    buf[buf.length - 2] = (buf[buf.length - 2] + Math.floor(s / 251)) & 0xff;
    buf[Math.max(0, buf.length - 3)] = (buf[Math.max(0, buf.length - 3)] + Math.floor(s / 63001)) & 0xff;
  }
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/jpeg" }), "bench.jpg");
  const t0 = performance.now();
  const res = await fetch(`${base}/api/faces/search`, {
    method: "POST",
    body: form,
    headers: { "x-event-token": token || `val-${salt}-${Date.now()}` },
  });
  const ms = performance.now() - t0;
  const retryAfter = res.headers.get("Retry-After");
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ms, retryAfter, jobId: body.jobId, body };
}

async function pollJob(jobId, timeoutMs = 300000) {
  const t0 = performance.now();
  let delay = 800;
  let firstProcessing = null;
  let polls = 0;
  while (performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(4000, Math.floor(delay * 1.35) + Math.floor(Math.random() * 200));
    polls += 1;
    let res = await fetch(`${base}/api/faces/search/${encodeURIComponent(jobId)}`);
    if (res.status === 404) {
      res = await fetch(`${base}/api/faces/search?jobId=${encodeURIComponent(jobId)}`);
    }
    const body = await res.json().catch(() => ({}));
    if (body.status === "processing" && firstProcessing == null) {
      firstProcessing = performance.now() - t0;
    }
    if (body.status === "completed" || body.status === "failed") {
      return {
        status: body.status,
        totalMs: performance.now() - t0,
        queueWaitMs: firstProcessing ?? performance.now() - t0,
        polls,
        error: body.error,
        synthetic: Boolean(body.synthetic),
      };
    }
  }
  return { status: "timeout", totalMs: performance.now() - t0, queueWaitMs: null, polls };
}

async function mapPool(n, concurrency, fn) {
  const results = new Array(n);
  let i = 0;
  async function worker() {
    while (i < n) {
      const idx = i++;
      results[idx] = await fn(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, () => worker()));
  return results;
}

async function sampleProc() {
  // Best-effort: query face service /metrics if available
  try {
    const res = await fetch(`${faceBase}/metrics`, {
      headers: { "X-API-Key": faceKey },
    });
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}

async function galleryOk() {
  const r = await fetch(`${base}/api/faces/status`).catch(() => null);
  if (r) return { ok: r.ok || r.status < 500, status: r.status };
  const r2 = await fetch(`${base}/`).catch(() => null);
  return r2 ? { ok: r2.ok, status: r2.status } : { ok: false };
}

function runSection(name) {
  // If --complete or --synth is the primary mode, skip unrelated sections unless --only set
  if (only) return only.split(",").map((s) => s.trim()).includes(name);
  if (arg("complete", "") || arg("synth", "")) return false;
  return true;
}

const report = { sections: {} };

// ---------- 1. Restart durability ----------
if (runSection("restart")) {
  console.log("\n=== 1. Restart / durability ===");
  clearJobs();
  await new Promise((r) => setTimeout(r, 100));
  const a = await postJob({ salt: 99901, token: "restart-test-a" });
  await new Promise((r) => setTimeout(r, 200));
  const jobsBefore = readJobs();
  const found = jobsBefore.find((j) => j.id === a.jobId);
  const tmpBefore = countTmpFiles();
  report.sections.restart = {
    acceptStatus: a.status,
    jobId: a.jobId,
    jobPersistedToDisk: Boolean(found),
    jobStatusOnDisk: found?.status || null,
    tmpFiles: tmpBefore,
    note:
      "Job metadata persists in .data/face-search-jobs.json (local) / D1 (Pages). " +
      "In-memory gatewayPending is LOST on Vite restart — queued jobs will NOT auto-resume without a durable queue consumer. " +
      "This is a PRODUCTION LIMITATION until Cloudflare Queues (or equivalent) is wired.",
    processingQueueType: "in-memory gatewayPending + best-effort setImmediate/waitUntil",
    metadataStore: "local JSON file (dev) / D1 table face_search_jobs (Pages)",
    cloudflareQueues: false,
  };
  console.log(JSON.stringify(report.sections.restart, null, 2));
}

// ---------- 2. Duplicate cache ----------
if (runSection("dup")) {
  console.log("\n=== 4. Duplicate protection ===");
  clearJobs();
  const first = await postJob({ sameImage: true, salt: 0, token: "dup-1" });
  let firstDone = null;
  if (first.jobId) {
    firstDone = await pollJob(first.jobId, 180000);
  }
  const second = await postJob({ sameImage: true, salt: 0, token: "dup-2" });
  const jobs = readJobs();
  const uniqueIds = new Set(jobs.map((j) => j.id));
  report.sections.duplicate = {
    firstAccept: first.status,
    firstJobId: first.jobId,
    firstCompletion: firstDone?.status,
    secondAccept: second.status,
    secondJobId: second.jobId,
    sameJobIdReused: first.jobId && second.jobId && first.jobId === second.jobId,
    duplicateFlag: Boolean(second.body?.duplicate) || first.jobId === second.jobId,
    gatewayDupTtlMs: 90_000,
    faceServiceCacheTtlSec: 60,
    rawSelfieInJobRecord: jobs.some((j) => j.selfie || j.imageBytes || j.image),
    embeddingInJobResult: jobs.some(
      (j) =>
        j.result &&
        (j.result.embedding ||
          j.result.embeddings ||
          (j.result.matches || []).some((m) => m.embedding))
    ),
    tmpBinsAfter: countTmpFiles(),
    note: "Gateway reuses recent job by SHA-256 (FACE_SEARCH_DUP_TTL_MS=90s). Face service also caches detect-embed by SHA for SEARCH_CACHE_TTL=60s in-process.",
  };
  console.log(JSON.stringify(report.sections.duplicate, null, 2));
}

// ---------- 3. Overload ----------
if (runSection("overload")) {
  console.log("\n=== 5. Overload behavior ===");
  // Fill queue by accepting many with unique salts; requires MAX_SEARCH_QUEUE small OR skip-process + many jobs
  // We probe by setting expectation: if current queue already near full from prior tests, clear then
  // Use rapid posts until we see 503. Cap attempts.
  clearJobs();
  let accepted = 0;
  let r429 = 0;
  let r503 = 0;
  let retryAfterSamples = [];
  const memBefore = process.memoryUsage().heapUsed;
  // Without SKIP_PROCESS this would hammer ML — use many accepts that stay queued only if SKIP set.
  // Instead: call with unique tokens and stop when 503, max 80 attempts; if never 503, report queue cap not hit at this size.
  const attempts = Number(arg("overload-attempts", "80"));
  for (let i = 0; i < attempts; i++) {
    const r = await postJob({ salt: 50000 + i, token: `ov-${i}` });
    if (r.status === 202 || r.status === 200) accepted += 1;
    else if (r.status === 429) {
      r429 += 1;
      if (r.retryAfter) retryAfterSamples.push(Number(r.retryAfter));
    } else if (r.status === 503) {
      r503 += 1;
      if (r.retryAfter) retryAfterSamples.push(Number(r.retryAfter));
      break;
    }
  }
  const gal = await galleryOk();
  const memAfter = process.memoryUsage().heapUsed;
  report.sections.overload = {
    attempts,
    accepted,
    http429: r429,
    http503: r503,
    retryAfterSamples,
    galleryStillReachable: gal.ok,
    galleryStatus: gal.status,
    nodeHeapDeltaMB: +((memAfter - memBefore) / 1024 / 1024).toFixed(2),
    activeQueued: readJobs().filter((j) => j.status === "queued" || j.status === "processing")
      .length,
    note:
      r503 > 0
        ? "Queue/capacity returned 503 with Retry-After."
        : "No 503 within attempt budget — raise --overload-attempts or lower MAX_SEARCH_QUEUE / use FACE_SEARCH_SKIP_PROCESS=1 with MAX_SEARCH_QUEUE=50 for a forced fill.",
  };
  console.log(JSON.stringify(report.sections.overload, null, 2));
}

// ---------- 4. Priority search vs index ----------
if (runSection("priority")) {
  console.log("\n=== 6. Search vs index priority ===");
  const form = new FormData();
  form.append("image", new Blob([imageBytes], { type: "image/jpeg" }), "idx.jpg");
  form.append("lane", "index");

  // Fire several index embeds + search jobs concurrently
  const t0 = performance.now();
  const indexPromises = Array.from({ length: 4 }, async (_, i) => {
    const f = new FormData();
    const buf = Buffer.from(imageBytes);
    buf[10] = (buf[10] + i) & 0xff;
    f.append("image", new Blob([buf], { type: "image/jpeg" }), "idx.jpg");
    f.append("lane", "index");
    const r = await fetch(`${faceBase}/detect-embed-index`, {
      method: "POST",
      headers: { "X-API-Key": faceKey, "X-Face-Lane": "index" },
      body: f,
    });
    return { status: r.status, ms: 0, kind: "index" };
  });
  const searchPromises = Array.from({ length: 4 }, async (_, i) => {
    const r = await postJob({ salt: 70000 + i, token: `pri-s-${i}` });
    const done = r.jobId ? await pollJob(r.jobId, 180000) : { status: "nojob" };
    return { accept: r.status, done: done.status, totalMs: done.totalMs, kind: "search" };
  });
  const [indexes, searches] = await Promise.all([
    Promise.all(indexPromises),
    Promise.all(searchPromises),
  ]);
  report.sections.priority = {
    elapsed_s: +((performance.now() - t0) / 1000).toFixed(2),
    indexStatuses: indexes.map((x) => x.status),
    indexBusyOrOk: indexes.filter((x) => x.status === 200 || x.status === 503).length,
    searchesCompleted: searches.filter((s) => s.done === "completed").length,
    searchesFailed: searches.filter((s) => s.done === "failed").length,
    searchTotalMs: searches.map((s) => s.totalMs).filter(Boolean),
    note: "Face service uses separate MAX_SEARCH_CONCURRENCY vs MAX_INDEX_CONCURRENCY; index pauses when search queue depth >= INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT.",
  };
  console.log(JSON.stringify(report.sections.priority, null, 2));
}

// ---------- 5. Real / synthetic completion bursts ----------
async function completionBurst(users, label, timeoutMs) {
  clearJobs();
  const metricsSnap = await sampleProc();
  const tBurst = performance.now();
  let maxDepth = 0;
  const depthTimer = setInterval(() => {
    const d = readJobs().filter((j) => j.status === "queued" || j.status === "processing").length;
    if (d > maxDepth) maxDepth = d;
  }, 200);

  const accepts = await mapPool(users, Math.min(25, users), async (idx) => {
    try {
      return await postJob({ salt: idx + 1, token: `${label}-${idx}` });
    } catch (e) {
      return { status: 0, error: e.message };
    }
  });

  let accepted = 0;
  let r429 = 0;
  let r503 = 0;
  const jobIds = [];
  for (const a of accepts) {
    if (a.status === 202 || a.status === 200) {
      accepted += 1;
      if (a.jobId) jobIds.push(a.jobId);
    } else if (a.status === 429) r429 += 1;
    else if (a.status === 503) r503 += 1;
  }

  const polls = await mapPool(jobIds.length, Math.min(20, jobIds.length || 1), async (i) =>
    pollJob(jobIds[i], timeoutMs)
  );
  clearInterval(depthTimer);

  const totals = [];
  const waits = [];
  let completed = 0;
  let failed = 0;
  let timedOut = 0;
  let expired = 0;
  for (const p of polls) {
    if (p.status === "completed") {
      completed += 1;
      totals.push(p.totalMs);
      if (p.queueWaitMs != null) waits.push(p.queueWaitMs);
    } else if (p.status === "failed") {
      failed += 1;
      if (/expir/i.test(p.error || "")) expired += 1;
    } else timedOut += 1;
  }
  totals.sort((a, b) => a - b);
  waits.sort((a, b) => a - b);
  const wall = (performance.now() - tBurst) / 1000;
  const gal = await galleryOk();

  return {
    label,
    submitted: users,
    accepted,
    completed,
    failed,
    expired,
    timed_out: timedOut,
    http429: r429,
    http503: r503,
    avg_completion_ms: +avg(totals).toFixed(1),
    p50_ms: +percentile(totals, 50).toFixed(1),
    p95_ms: +percentile(totals, 95).toFixed(1),
    p99_ms: +percentile(totals, 99).toFixed(1),
    avg_queue_wait_ms: +avg(waits).toFixed(1),
    p95_queue_wait_ms: +percentile(waits, 95).toFixed(1),
    throughput_jobs_per_s: completed > 0 ? +(completed / wall).toFixed(3) : 0,
    max_queue_depth: maxDepth,
    wall_s: +wall.toFixed(2),
    gallery_ok: gal.ok,
    face_metrics: metricsSnap,
  };
}

if (runSection("complete25") || runSection("complete") || (!only && false)) {
  /* handled below via --complete flag list */
}

const completeLevels = (arg("complete", "") || "")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);

if (completeLevels.length) {
  console.log("\n=== Real/synthetic completion tests ===");
  report.sections.completions = [];
  for (const n of completeLevels) {
    // Guard: don't run 3000 real unless synthetic mode is on (caller responsibility)
    if (n >= 500) {
      console.warn(`Skipping n=${n} in this script without explicit large synthetic run.`);
      continue;
    }
    const timeout = n <= 25 ? 300000 : n <= 50 ? 450000 : 600000;
    console.log(`Running n=${n} ...`);
    const row = await completionBurst(n, `c${n}`, timeout);
    report.sections.completions.push(row);
    console.log(JSON.stringify(row));
    if (row.timed_out > row.completed || row.failed > row.completed) {
      console.warn("Instability detected — stopping larger real tests.");
      break;
    }
  }
}

if (runSection("synth3000") || arg("synth", "") === "3000") {
  console.log("\n=== 7. Synthetic 3000 drain (NO buffalo_l) ===");
  console.log("Requires Vite with FACE_SEARCH_SYNTHETIC=1");
  clearJobs();
  const row = await completionBurst(3000, "synth3000", 180000);
  report.sections.synth3000 = {
    ...row,
    distinction:
      "This measures 3000 jobs accepted + drained synthetically — NOT 3000 real face inferences.",
  };
  console.log(JSON.stringify(report.sections.synth3000));
}

// ---------- Polling analysis (static) ----------
if (runSection("poll") || !only) {
  report.sections.polling = {
    initialDelayMs: 800,
    growth: "delay = min(4000, floor(delay * 1.35) + jitter)",
    jitter: "random 0..min(400, 0.25*delay)",
    maxPollIntervalMs: 4000,
    maxClientWaitMs: 5 * 60 * 1000,
    acceptRetriesOn429_503: 3,
    acceptBackoff: "Retry-After or 800*2^attempt + jitter, cap 8s",
    perSecondStorm: false,
    estimatePollsPerClientOver60s:
      "approx 800→1080→1458→1968→2657→3587→4000… ~15–20 polls / min after ramp, not 60",
    jobTtlMs: 10 * 60 * 1000,
  };
  console.log("\n=== 3. Polling behavior ===");
  console.log(JSON.stringify(report.sections.polling, null, 2));
}

writeFileSync(
  resolve(".data/tmp/validate-async-report.json"),
  JSON.stringify(report, null, 2)
);
console.log("\nWrote .data/tmp/validate-async-report.json");
