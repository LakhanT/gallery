import { list, put } from "@vercel/blob";

const FACES_PATH = "meta/faces.json";

async function getIndex() {
  try {
    const { blobs } = await list({ prefix: FACES_PATH });
    const file = blobs.find((blob) => blob.pathname === FACES_PATH) || blobs[0];
    if (!file) return {};
    const response = await fetch(file.url, { cache: "no-store" });
    if (!response.ok) return {};
    const data = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function saveIndex(index) {
  await put(FACES_PATH, JSON.stringify(index), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function getFaceIndex() {
  return getIndex();
}

export async function upsertFaceRecord(id, faces) {
  if (!id) {
    throw new Error("Missing photo.");
  }
  const index = await getIndex();
  index[id] = {
    faces: Array.isArray(faces) ? faces : [],
    updatedAt: new Date().toISOString(),
  };
  await saveIndex(index);
  return index[id];
}

export async function removeFaceRecord(id) {
  if (!id) return;
  const index = await getIndex();
  if (!index[id]) return;
  delete index[id];
  await saveIndex(index);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      res.status(200).json({ index: await getFaceIndex() });
      return;
    }

    if (req.method === "POST") {
      const { id, faces } = req.body || {};
      const record = await upsertFaceRecord(id, faces);
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
