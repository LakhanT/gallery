import { createHash } from "crypto";
import { del, list, put } from "@vercel/blob";

export const config = {
  maxDuration: 30,
};

const LEGACY_PATH = "meta/faces.json";
const RECORD_PREFIX = "meta/face-records/";

function recordPath(id) {
  const hash = createHash("sha1").update(String(id)).digest("hex");
  return `${RECORD_PREFIX}${hash}.json`;
}

async function listAll(prefix) {
  const files = [];
  let cursor;
  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    files.push(...(result.blobs || []));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return files;
}

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function loadLegacyIndex() {
  try {
    const blobs = await listAll(LEGACY_PATH);
    const file = blobs.find((blob) => blob.pathname === LEGACY_PATH) || blobs[0];
    if (!file) return {};
    const data = await readJson(file.url);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export async function getFaceIndex() {
  const index = await loadLegacyIndex();
  const blobs = (await listAll(RECORD_PREFIX)).filter((blob) =>
    blob.pathname.startsWith(RECORD_PREFIX)
  );

  for (let i = 0; i < blobs.length; i += 20) {
    const batch = blobs.slice(i, i + 20);
    const records = await Promise.all(batch.map((blob) => readJson(blob.url)));
    for (const record of records) {
      if (record?.id) {
        index[record.id] = record;
      }
    }
  }

  return index;
}

export async function upsertFaceRecord(id, faces, version = 1) {
  if (!id) {
    throw new Error("Missing photo.");
  }
  const record = {
    id,
    faces: Array.isArray(faces) ? faces : [],
    version: Number(version) || 1,
    updatedAt: new Date().toISOString(),
  };
  await put(recordPath(id), JSON.stringify(record), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  return record;
}

export async function removeFaceRecord(id) {
  if (!id) return;
  try {
    await del(recordPath(id));
  } catch {
    /* already gone */
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      res.status(200).json({ index: await getFaceIndex() });
      return;
    }

    if (req.method === "POST") {
      const { id, faces, version } = req.body || {};
      const record = await upsertFaceRecord(id, faces, version);
      res.status(200).json({ record });
      return;
    }

    if (req.method === "DELETE") {
      await removeFaceRecord(req.query?.id);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not update face index." });
  }
}
