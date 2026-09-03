import { loadEnv } from "vite";
import { addPhoto, listPhotos, removePhoto } from "./api/photos.js";

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
          if (path !== "/api/photos") {
            next();
            return;
          }

          try {
            if (req.method === "GET") {
              sendJson(res, 200, { photos: await listPhotos() });
              return;
            }

            if (req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              sendJson(res, 200, { photo: await addPhoto(body) });
              return;
            }

            if (req.method === "DELETE") {
              const url = new URL(req.url, "http://localhost");
              await removePhoto(url.searchParams.get("url"));
              sendJson(res, 200, { ok: true });
              return;
            }

            sendJson(res, 405, { error: "Method not allowed." });
          } catch (error) {
            sendJson(res, 400, { error: error.message });
          }
        });
      },
    },
  ],
};
