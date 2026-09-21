#!/usr/bin/env node
/**
 * Controlled load scenarios for gallery + face search.
 *
 * Examples:
 *   node scripts/loadtest-scenarios.mjs --scenario A --gallery http://127.0.0.1:5173 --users 100
 *   node scripts/loadtest-scenarios.mjs --scenario C --gallery http://127.0.0.1:5173 --image selfie.jpg --users 50
 *
 * Scenario E (3000 face searches) should ONLY target staging, never production.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const scenario = (arg("scenario", "A") || "A").toUpperCase();
const gallery = (arg("gallery", "http://127.0.0.1:5173") || "").replace(/\/$/, "");
const users = Number(arg("users", "50")) || 50;
const imagePath = arg("image", "");
const allowHigh = process.argv.includes("--i-understand-staging-only");

if (scenario === "E" && users >= 1000 && !allowHigh) {
  console.error("Scenario E with high concurrency requires --i-understand-staging-only");
  process.exit(1);
}

const imageBytes = imagePath ? readFileSync(resolve(imagePath)) : null;

async function galleryOpen() {
  const t0 = performance.now();
  const res = await fetch(`${gallery}/`);
  await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - t0 };
}

async function galleryPhotos() {
  const t0 = performance.now();
  const res = await fetch(`${gallery}/api/photos`);
  const data = await res.json().catch(() => ({}));
  return {
    status: res.status,
    ms: performance.now() - t0,
    count: (data.photos || []).length,
  };
}

async function faceSearch() {
  if (!imageBytes) throw new Error("Face scenarios need --image");
  const form = new FormData();
  form.append("image", new Blob([imageBytes], { type: "image/jpeg" }), "selfie.jpg");
  const t0 = performance.now();
  const res = await fetch(`${gallery}/api/faces/search`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ms: performance.now() - t0, error: data.error };
}

function summarize(label, rows) {
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300).length;
  const r429 = rows.filter((r) => r.status === 429).length;
  const r503 = rows.filter((r) => r.status === 503).length;
  const err = rows.length - ok - r429 - r503;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] || 0;
  console.log(
    JSON.stringify(
      {
        scenario: label,
        users: rows.length,
        success_pct: +((ok / rows.length) * 100).toFixed(1),
        pct_429: +((r429 / rows.length) * 100).toFixed(1),
        pct_503: +((r503 / rows.length) * 100).toFixed(1),
        errors: err,
        p50_ms: +pct(50).toFixed(1),
        p95_ms: +pct(95).toFixed(1),
        p99_ms: +pct(99).toFixed(1),
      },
      null,
      2
    )
  );
}

async function burst(fn, n) {
  const jobs = Array.from({ length: n }, () => fn().catch((e) => ({ status: 0, ms: 0, error: e.message })));
  return Promise.all(jobs);
}

console.log(`Running scenario ${scenario} users=${users} gallery=${gallery}`);

if (scenario === "A") {
  summarize("A_gallery_open", await burst(galleryOpen, users));
} else if (scenario === "B") {
  const rows = await burst(async () => {
    const a = await galleryOpen();
    const b = await galleryPhotos();
    return { status: b.status, ms: a.ms + b.ms };
  }, users);
  summarize("B_open_browse", rows);
} else if (["C", "D", "E"].includes(scenario)) {
  summarize(`${scenario}_face_search`, await burst(faceSearch, users));
} else {
  console.error("Unknown scenario. Use A|B|C|D|E");
  process.exit(1);
}
