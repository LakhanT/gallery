import { loadEnv } from "vite";
import { addPhoto, getGallery, removePhoto, renamePhoto } from "./api/photos.js";
import { getFaceIndex, removeFaceRecord, upsertFaceRecord } from "./api/faces.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export default {
  server: {
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    include: ["@vladmandic/face-api"],
  },
  plugins: [
    {
      name: "gallery-api",
      configResolved() {
        const env = loadEnv("development", process.cwd(), "");
        if (env.BLOB_READ_WRITE_TOKEN) {
          process.env.BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN;
        }
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = req.url?.split("?")[0];
          try {
            if (path === "/api/photos") {
              if (req.method === "GET") {
                sendJson(res, 200, await getGallery());
                return;
              }

              if (req.method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                sendJson(res, 200, { photo: await addPhoto(body) });
                return;
              }

              if (req.method === "PATCH") {
                const body = JSON.parse((await readBody(req)) || "{}");
                sendJson(res, 200, { name: await renamePhoto(body.id, body.name) });
                return;
              }

              if (req.method === "DELETE") {
                const url = new URL(req.url, "http://localhost");
                await removePhoto(url.searchParams.get("url"));
                sendJson(res, 200, { ok: true });
                return;
              }

              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (path === "/api/faces") {
              if (req.method === "GET") {
                sendJson(res, 200, { index: await getFaceIndex() });
                return;
              }

              if (req.method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                sendJson(res, 200, {
                  record: await upsertFaceRecord(body.id, body.faces, body.version),
                });
                return;
              }

              if (req.method === "DELETE") {
                const url = new URL(req.url, "http://localhost");
                await removeFaceRecord(url.searchParams.get("id"));
                sendJson(res, 200, { ok: true });
                return;
              }

              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            next();
          } catch (error) {
            sendJson(res, 400, { error: error.message });
          }
        });
      },
    },
  ],
};
