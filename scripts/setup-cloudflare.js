#!/usr/bin/env node
/**
 * Create D1 database + R2 bucket and patch wrangler.toml with the database id.
 *
 * Usage:
 *   node scripts/setup-cloudflare.js
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run: wrangler login`);
  }
  return value;
}

async function cfFetch(url, init = {}) {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.errors?.[0]?.message || `Cloudflare API failed: ${response.status}`);
  }
  return data;
}

async function main() {
  const wranglerPath = path.join(process.cwd(), "wrangler.toml");
  let wrangler = readFileSync(wranglerPath, "utf8");

  let dbId = "";
  try {
    const created = await cfFetch("/d1/database", {
      method: "POST",
      body: JSON.stringify({ name: "gallery-db" }),
    });
    dbId = created.result.uuid;
    console.log(`Created D1 database: ${dbId}`);
  } catch (error) {
    const listed = await cfFetch("/d1/database");
    const existing = (listed.result || []).find((item) => item.name === "gallery-db");
    if (!existing) throw error;
    dbId = existing.uuid;
    console.log(`Using existing D1 database: ${dbId}`);
  }

  try {
    await cfFetch("/r2/buckets", {
      method: "POST",
      body: JSON.stringify({ name: "gallery-photos" }),
    });
    console.log("Created R2 bucket: gallery-photos");
  } catch (error) {
    if (String(error.message).includes("already exists")) {
      console.log("Using existing R2 bucket: gallery-photos");
    } else {
      throw error;
    }
  }

  wrangler = wrangler.replace(
    /database_id = ".*"/,
    `database_id = "${dbId}"`
  );
  writeFileSync(wranglerPath, wrangler);
  console.log("Updated wrangler.toml");
  console.log("");
  console.log("Next:");
  console.log("  npm run db:migrate:remote");
  console.log("  npm run deploy");
}

main().catch((error) => {
  console.error(error.message || error);
  console.error("");
  console.error("Tip: export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or use wrangler directly:");
  console.error("  wrangler d1 create gallery-db");
  console.error("  wrangler r2 bucket create gallery-photos");
  process.exit(1);
});
