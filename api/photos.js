import { del, list, put } from "@vercel/blob";

export const config = {
  runtime: "edge",
};

const PREFIX = "gallery/";

function json(data, status = 200) {
  return Response.json(data, { status });
}

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

export default async function handler(request) {
  const url = new URL(request.url);

  try {
    if (request.method === "GET") {
      const { blobs } = await list({ prefix: PREFIX });
      const photos = blobs
        .map(photoFromBlob)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return json({ photos });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return json({ error: "Choose a photo to upload." }, 400);
      }
      if (!file.type || !file.type.startsWith("image/")) {
        return json({ error: "That file is not a photo." }, 400);
      }

      const blob = await put(`${PREFIX}${Date.now()}-${safeName(file.name)}`, file, {
        access: "public",
        addRandomSuffix: true,
      });

      return json({
        photo: {
          id: blob.url,
          url: blob.url,
          name: file.name,
          createdAt: new Date().toISOString(),
        },
      });
    }

    if (request.method === "DELETE") {
      const target = url.searchParams.get("url");
      if (!target) {
        return json({ error: "Missing photo." }, 400);
      }
      await del(target);
      return json({ ok: true });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json({ error: error.message || "Could not update the gallery." }, 500);
  }
}
