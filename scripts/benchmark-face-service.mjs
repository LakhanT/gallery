#!/usr/bin/env node
/**
 * Benchmark Face service /detect-embed (controlled concurrency).
 *
 * Usage:
 *   node scripts/benchmark-face-service.mjs --url http://127.0.0.1:8090 --key SECRET --image path.jpg --concurrency 1,5,10
 *
 * Does NOT claim 3000-user capacity. Measure first, then multiply by workers.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const base = (arg("url", "http://127.0.0.1:8090") || "").replace(/\/$/, "");
const key = arg("key", process.env.FACE_SERVICE_API_KEY || "");
const imagePath = resolve(arg("image", ""));
const concList = (arg("concurrency", "1,5,10") || "1")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);
const requestsPerLevel = Number(arg("requests", "20")) || 20;

if (!key) {
  console.error("Missing --key or FACE_SERVICE_API_KEY");
  process.exit(1);
}
if (!imagePath) {
  console.error("Missing --image path.jpg");
  process.exit(1);
}

const imageBytes = readFileSync(imagePath);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function oneRequest() {
  const form = new FormData();
  form.append("image", new Blob([imageBytes], { type: "image/jpeg" }), "bench.jpg");
  form.append("lane", "search");
  const t0 = performance.now();
  const res = await fetch(`${base}/detect-embed`, {
    method: "POST",
    headers: { "X-API-Key": key },
    body: form,
  });
  const ms = performance.now() - t0;
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ms, faces: (body.faces || []).length };
}

async function runLevel(concurrency) {
  const latencies = [];
  let ok = 0;
  let busy = 0;
  let err = 0;
  let remaining = requestsPerLevel;
  const workers = Array.from({ length: concurrency }, async () => {
    while (remaining > 0) {
      remaining -= 1;
      try {
        const r = await oneRequest();
        latencies.push(r.ms);
        if (r.status === 200) ok += 1;
        else if (r.status === 429 || r.status === 503) busy += 1;
        else err += 1;
      } catch {
        err += 1;
      }
    }
  });
  const t0 = performance.now();
  await Promise.all(workers);
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    concurrency,
    requests: requestsPerLevel,
    ok,
    busy,
    err,
    rps: +(ok / elapsed).toFixed(2),
    p50: +percentile(latencies, 50).toFixed(1),
    p95: +percentile(latencies, 95).toFixed(1),
    p99: +percentile(latencies, 99).toFixed(1),
    elapsed_s: +elapsed.toFixed(2),
  };
}

const health = await fetch(`${base}/health`, { headers: { "X-API-Key": key } });
const healthBody = await health.json().catch(() => ({}));
console.log("health", health.status, {
  ready: healthBody.ready,
  limits: healthBody.limits,
  capacity: healthBody.capacity,
});

console.log("\nconcurrency,ok,busy,err,rps,p50_ms,p95_ms,p99_ms,elapsed_s");
for (const c of concList) {
  if (c > 500) {
    console.warn(`Skipping concurrency=${c} (use staging only; pass explicitly if needed)`);
    continue;
  }
  const row = await runLevel(c);
  console.log(
    [row.concurrency, row.ok, row.busy, row.err, row.rps, row.p50, row.p95, row.p99, row.elapsed_s].join(
      ","
    )
  );
}

console.log(`
Notes:
- Throughput per worker ≈ max stable RPS at concurrency where busy≈0 and p95 acceptable.
- Estimated cluster throughput ≈ per_worker_rps × instances × safety_margin(0.5–0.7).
- Do NOT claim 3000 concurrent users until load tests on staging demonstrate it.
`);
