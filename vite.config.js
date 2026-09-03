import { loadEnv } from "vite";
import photosHandler from "./api/photos.js";

function toWebRequest(req) {
  const url = `http://${req.headers.host}${req.url}`;
  const method = req.method || "GET";
  const headers = req.headers;

  if (method === "GET" || method === "HEAD") {
    return Promise.resolve(new Request(url, { method, headers }));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      resolve(
        new Request(url, {
          method,
          headers,
          body: Buffer.concat(chunks),
          duplex: "half",
        })
      );
    });
    req.on("error", reject);
  });
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
            const request = await toWebRequest(req);
            const response = await photosHandler(request);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => {
              res.setHeader(key, value);
            });
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      },
    },
  ],
};
