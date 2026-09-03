import { del, list, put } from "@vercel/blob";

const PREFIX = "gallery/";

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

export async function listPhotos() {
  const { blobs } = await list({ prefix: PREFIX });
  return blobs
    .map(photoFromBlob)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

export async function removePhoto(target) {
  if (!target) {
    throw new Error("Missing photo.");
  }
  await del(target);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      res.status(200).json({ photos: await listPhotos() });
      return;
    }

    if (req.method === "POST") {
      const photo = await addPhoto(req.body || {});
      res.status(200).json({ photo });
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
