#!/usr/bin/env node
/**
 * Migrate photos + face records from the live Vercel gallery API into Cloudflare R2 + D1.
 * Uses public /api/photos and /api/faces — no BLOB_READ_WRITE_TOKEN required.
 * Uses wrangler (already logged in) for R2 uploads and D1 inserts.
 *
 * Usage:
 *   node scripts/migrate-from-vercel.js --origin https://gallery-752.pages.dev
 *   node scripts/migrate-from-vercel.js --from https://gallery-nine-sigma-24.vercel.app --origin https://gallery-752.pages.dev
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PREFIX = "gallery/";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: true,
    ...options,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new Error(err || `${cmd} ${args.join(" ")} failed`);
  }
  return result.stdout || "";
}

function sqlEscape(value) {
  return String(value ?? "").replace(/'/g, "''");
}

function r2KeyFromBlobUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/^\//, "");
    if (pathname.startsWith(PREFIX)) return pathname;
  } catch {
    /* fall through */
  }
  const base = url.split("/").pop() || `photo-${Date.now()}.jpg`;
  return `${PREFIX}${base}`;
}

function photoFromSource(photo, origin) {
  const r2Key = r2KeyFromBlobUrl(photo.url || photo.id);
  const url = `${origin}/media/${r2Key}`;
  return {
    oldId: photo.id || photo.url,
    id: url,
    r2Key,
    url,
    name: photo.name || "photo.jpg",
    createdAt: photo.createdAt || new Date().toISOString(),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

function putR2(tmpDir, r2Key, bytes, contentType) {
  const localPath = path.join(tmpDir, r2Key.replace(/[\\/]/g, "__"));
  writeFileSync(localPath, bytes);
  run("npx", [
    "wrangler",
    "r2",
    "object",
    "put",
    `gallery-photos/${r2Key}`,
    `--file=${localPath}`,
    `--content-type=${contentType}`,
    "--remote",
  ]);
}

function d1ExecuteFile(sqlPath) {
  run("npx", [
    "wrangler",
    "d1",
    "execute",
    "gallery-db",
    "--remote",
    `--file=${sqlPath}`,
    "--yes",
  ]);
}

function writeSqlBatch(tmpDir, name, statements) {
  if (!statements.length) return null;
  const filePath = path.join(tmpDir, name);
  writeFileSync(filePath, statements.join("\n"));
  return filePath;
}

async function main() {
  const from = arg("from", "https://gallery-nine-sigma-24.vercel.app").replace(/\/$/, "");
  const origin = arg("origin", "https://gallery-752.pages.dev").replace(/\/$/, "");
  if (!origin) {
    throw new Error("Pass --origin https://your-site.pages.dev");
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "gallery-migrate-"));
  mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`Source: ${from}`);
    console.log(`Target: ${origin}`);

    const gallery = await fetchJson(`${from}/api/photos`);
    const facesPayload = await fetchJson(`${from}/api/faces`);
    const photos = gallery.photos || [];
    const names = gallery.names || {};
    const faceIndex = facesPayload.index || {};

    console.log(`Found ${photos.length} photos, ${Object.keys(names).length} names, ${Object.keys(faceIndex).length} face records`);

    const idMap = new Map();
    const photoStatements = [];

    for (const [i, source] of photos.entries()) {
      const photo = photoFromSource(source, origin);
      console.log(`[${i + 1}/${photos.length}] ${photo.r2Key}`);

      const response = await fetch(source.url);
      if (!response.ok) {
        console.warn(`  skip: download failed (${response.status})`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") || "image/jpeg";
      putR2(tmpDir, photo.r2Key, bytes, contentType);

      idMap.set(photo.oldId, photo.id);
      if (source.url && source.url !== photo.oldId) {
        idMap.set(source.url, photo.id);
      }

      const displayName = sqlEscape(names[photo.oldId] || names[source.url] || photo.name);
      photoStatements.push(
        `INSERT OR REPLACE INTO photos (id, r2_key, url, name, created_at) VALUES ('${sqlEscape(photo.id)}', '${sqlEscape(photo.r2Key)}', '${sqlEscape(photo.url)}', '${displayName}', '${sqlEscape(photo.createdAt)}');`
      );
    }

    const remapId = (photoId) => idMap.get(photoId) || photoId;

    const nameStatements = Object.entries(names).map(([photoId, name]) => {
      return `INSERT OR REPLACE INTO display_names (photo_id, name) VALUES ('${sqlEscape(remapId(photoId))}', '${sqlEscape(name)}');`;
    });

    const faceStatements = Object.values(faceIndex).map((record) => {
      const photoId = remapId(record.id);
      const facesJson = JSON.stringify(record.faces || []);
      const version = Number(record.version) || 1;
      const updatedAt = record.updatedAt || new Date().toISOString();
      return `INSERT OR REPLACE INTO face_records (photo_id, faces_json, version, updated_at) VALUES ('${sqlEscape(photoId)}', '${sqlEscape(facesJson)}', ${version}, '${sqlEscape(updatedAt)}');`;
    });

    const photoSql = writeSqlBatch(tmpDir, "photos.sql", photoStatements);
    const namesSql = writeSqlBatch(tmpDir, "names.sql", nameStatements);
    const facesSql = writeSqlBatch(tmpDir, "faces.sql", faceStatements);

    if (photoSql) {
      console.log("Writing photos to D1...");
      d1ExecuteFile(photoSql);
    }
    if (namesSql) {
      console.log("Writing names to D1...");
      d1ExecuteFile(namesSql);
    }
    if (facesSql) {
      console.log("Writing face records to D1...");
      d1ExecuteFile(facesSql);
    }

    console.log("Migration complete.");
    console.log(`Photos: ${photoStatements.length}`);
    console.log(`Names: ${nameStatements.length}`);
    console.log(`Face records: ${faceStatements.length}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
