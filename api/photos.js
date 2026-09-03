import { del, list, put } from "@vercel/blob";
import { removeFaceRecord } from "./faces.js";

const PREFIX = "gallery/";
const NAMES_PATH = "meta/names.json";

function photoFromBlob(blob) {
  const fileName = blob.pathname.slice(PREFIX.length).replace(/^\d+-/, "");
  return {
    id: blob.url,
    url: blob.url,
    name: decodeURIComponent(fileName || "photo.jpg"),
    createdAt: blob.uploadedAt,
  };
}

function safeName(name) {
  const base = (name || "photo.jpg").split(/[/\\]/).pop();
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 80) || "photo.jpg";
}

function cleanDisplayName(name) {
  const trimmed = String(name || "").trim().replace(/[/\\]/g, "");
  if (!trimmed) {
    throw new Error("Enter a name.");
  }
  return trimmed.slice(0, 80);
}

async function getNames() {
  try {
    const { blobs } = await list({ prefix: NAMES_PATH });
    const file = blobs.find((blob) => blob.pathname === NAMES_PATH) || blobs[0];
    if (!file) return {};
    const response = await fetch(file.url, { cache: "no-store" });
    if (!response.ok) return {};
    const data = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function saveNames(names) {
  await put(NAMES_PATH, JSON.stringify(names), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function getGallery() {
  const names = await getNames();
  const { blobs } = await list({ prefix: PREFIX });
  const photos = blobs
    .filter((blob) => !blob.pathname.endsWith(".json"))
    .map((blob) => {
      const photo = photoFromBlob(blob);
      return {
        ...photo,
        name: names[photo.id] || photo.name,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { photos, names };
}

export async function addPhoto({ name, dataUrl }) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("Choose a photo to upload.");
  }

  const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("That file is not a photo.");
  }

  const type = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("That photo is empty.");
  }

  const blob = await put(`${PREFIX}${Date.now()}-${safeName(name)}`, buffer, {
    access: "public",
    addRandomSuffix: true,
    contentType: type,
  });

  return {
    id: blob.url,
    url: blob.url,
    name: name || "photo.jpg",
    createdAt: new Date().toISOString(),
  };
}

export async function renamePhoto(id, name) {
  if (!id) {
    throw new Error("Missing photo.");
  }
  const next = cleanDisplayName(name);
  const names = await getNames();
  names[id] = next;
  await saveNames(names);
  return next;
}

export async function removePhoto(target) {
  if (!target) {
    throw new Error("Missing photo.");
  }
  await del(target);
  const names = await getNames();
  if (names[target]) {
    delete names[target];
    await saveNames(names);
  }
  await removeFaceRecord(target);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      res.status(200).json(await getGallery());
      return;
    }

    if (req.method === "POST") {
      const photo = await addPhoto(req.body || {});
      res.status(200).json({ photo });
      return;
    }

    if (req.method === "PATCH") {
      const { id, name } = req.body || {};
      const renamed = await renamePhoto(id, name);
      res.status(200).json({ name: renamed });
      return;
    }

    if (req.method === "DELETE") {
      await removePhoto(req.query?.url);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not update the gallery." });
  }
}
