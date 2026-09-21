import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalStore } from "./lib/local-store.js";
import { clearSessionCookie, clearUserSessionCookie, sessionCookie, userSessionCookie } from "./lib/auth.js";

const root = path.dirname(fileURLToPath(import.meta.url));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function faceServiceEnv() {
  return {
    FACE_SERVICE_URL: process.env.FACE_SERVICE_URL || "http://127.0.0.1:8090",
    FACE_SERVICE_API_KEY: process.env.FACE_SERVICE_API_KEY || "",
  };
}

function sendJson(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(data));
}

function sendBuffer(res, status, body, contentType) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(body);
}

function requestFromNode(req) {
  return {
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "cookie") {
          return req.headers.cookie || "";
        }
        const key = String(name).toLowerCase();
        const value = req.headers[key];
        return value == null ? null : String(value);
      },
    },
  };
}

export default {
  server: {
    host: true,
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, "index.html"),
        admin: path.resolve(root, "admin.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["@vladmandic/face-api", "@mediapipe/tasks-vision"],
    exclude: ["onnxruntime-web"],
  },
  plugins: [
    {
      name: "strip-ort-wasm",
      generateBundle(_options, bundle) {
        for (const fileName of Object.keys(bundle)) {
          if (fileName.endsWith(".wasm")) delete bundle[fileName];
        }
      },
    },
    {
      name: "gallery-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost:5173");
          const pathName = url.pathname;

          try {
            const store = createLocalStore(url.origin, {
              ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123",
            });
            const webRequest = requestFromNode(req);

            if (pathName.startsWith("/media/")) {
              if (req.method !== "GET") {
                sendJson(res, 405, { error: "Method not allowed." });
                return;
              }
              const r2Key = decodeURIComponent(pathName.slice("/media/".length));
              const media = await store.readMedia(r2Key);
              if (!media) {
                sendJson(res, 404, { error: "Not found." });
                return;
              }
              sendBuffer(res, 200, media.body, media.contentType);
              return;
            }

            if (pathName === "/api/photos") {
              if (req.method === "GET") {
                sendJson(res, 200, await store.getGallery());
                return;
              }

              if (req.method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const photo = await store.addPhoto(body, null);
                const { publicPhoto, queueFaceIndex } = await import("./lib/face-auto-index.js");
                queueFaceIndex(store, photo, faceServiceEnv());
                sendJson(res, 200, { photo: publicPhoto(photo), faceIndex: "queued" });
                return;
              }

              if (req.method === "PATCH") {
                const body = JSON.parse((await readBody(req)) || "{}");
                sendJson(res, 200, { name: await store.renamePhoto(body.id, body.name, null) });
                return;
              }

              if (req.method === "DELETE") {
                await store.removePhoto(url.searchParams.get("url"), null);
                sendJson(res, 200, { ok: true });
                return;
              }

              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (pathName === "/api/faces/status" && req.method === "GET") {
              sendJson(res, 200, { versions: await store.getFaceVersions() });
              return;
            }

            if (pathName === "/api/faces/search" && req.method === "POST") {
              const contentType = req.headers["content-type"] || "";
              if (!contentType.includes("multipart/form-data")) {
                sendJson(res, 400, {
                  error:
                    "Public face search requires multipart/form-data with an image field. Client-supplied embeddings are not accepted.",
                });
                return;
              }
              const { faceServiceDetectEmbed } = await import("./lib/face-client.js");
              const { FACE_DIM, FACE_EMBEDDING_VERSION, FACE_MIN_QUALITY_SCORE, FACE_MODEL } =
                await import("./lib/face-config.js");
              const { isValidArcFaceEmbedding } = await import("./lib/face-validate.js");
              const raw = await readRawBody(req);
              const request = new Request("http://localhost/api/faces/search", {
                method: "POST",
                headers: { "content-type": contentType },
                body: raw,
              });
              const form = await request.formData();
              const file = form.get("image") || form.get("file");
              if (!file || typeof file === "string") {
                sendJson(res, 400, { error: "Upload a selfie image." });
                return;
              }
              const bytes = await file.arrayBuffer();
              const detect = await faceServiceDetectEmbed(
                faceServiceEnv(),
                new Blob([bytes], { type: file.type || "image/jpeg" }),
                file.name || "selfie.jpg"
              );
              const faces = detect.faces || [];
              if (!faces.length) {
                sendJson(res, 400, {
                  error: "No clear face found. Use a front-facing selfie with good lighting.",
                });
                return;
              }
              if ((faces[0].quality_score ?? 1) < FACE_MIN_QUALITY_SCORE) {
                sendJson(res, 400, { error: "Selfie quality is too low. Try again." });
                return;
              }
              const descriptors = faces
                .slice(0, 3)
                .map((f) => f.embedding)
                .filter((e) => isValidArcFaceEmbedding(e));
              if (!descriptors.length) {
                sendJson(res, 502, { error: "Face service returned invalid embeddings." });
                return;
              }
              const result = await store.searchFaces(descriptors, "");
              sendJson(res, 200, {
                ...result,
                model: FACE_MODEL,
                version: FACE_EMBEDDING_VERSION,
                dim: FACE_DIM,
              });
              return;
            }

            if (pathName === "/api/admin/faces/search" && req.method === "POST") {
              await store.requireAdmin(webRequest);
              const body = JSON.parse((await readBody(req)) || "{}");
              const { filterQueryEmbeddings, isValidArcFaceEmbedding } = await import(
                "./lib/face-validate.js"
              );
              const raw = body.descriptors || body.embeddings || [];
              let descriptors = filterQueryEmbeddings(Array.isArray(raw) ? raw : []);
              if (!descriptors.length && isValidArcFaceEmbedding(body.embedding)) {
                descriptors = [body.embedding];
              }
              if (!descriptors.length) {
                sendJson(res, 400, { error: "Send 512-d ArcFace embeddings." });
                return;
              }
              sendJson(res, 200, {
                ...(await store.searchFaces(descriptors, body.queryPreview || "")),
                admin: true,
              });
              return;
            }

            if (pathName === "/api/faces") {
              if (req.method === "GET" || req.method === "POST") {
                sendJson(res, 403, {
                  error:
                    req.method === "GET"
                      ? "Face index is not publicly available."
                      : "Public face indexing is disabled. Use Admin → Re-index faces.",
                });
                return;
              }

              if (req.method === "DELETE") {
                await store.requireAdmin(webRequest);
                await store.removeFaceRecord(url.searchParams.get("id"));
                sendJson(res, 200, { ok: true });
                return;
              }

              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (pathName === "/api/admin/reindex") {
              await store.requireAdmin(webRequest);
              if (req.method === "GET") {
                let service = null;
                try {
                  const { faceServiceHealth } = await import("./lib/face-client.js");
                  service = await faceServiceHealth(faceServiceEnv());
                } catch (error) {
                  service = { ok: false, error: error.message };
                }
                sendJson(res, 200, {
                  progress: await store.getReindexProgress(),
                  service,
                  thresholds: {
                    model: "insightface-buffalo-l",
                    version: 8,
                    matchSimilarity: 0.42,
                    uncertainSimilarity: 0.32,
                  },
                  model: "insightface-buffalo-l",
                  version: 8,
                });
                return;
              }
              if (req.method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                if (body.retryFailed && typeof store.retryFailedFaceIndexes === "function") {
                  const reset = await store.retryFailedFaceIndexes();
                  sendJson(res, 200, {
                    retried: true,
                    reset: reset.reset,
                    progress: await store.getReindexProgress(),
                  });
                  return;
                }
                if (typeof store.indexPhotoWithFaceService === "function") {
                  const limit = Math.min(20, Math.max(1, Number(body.limit) || 5));
                  const targets = body.photoId
                    ? [{ id: body.photoId }]
                    : await store.listPhotosNeedingReindex(limit);
                  const results = [];
                  let facesFound = 0;
                  let errors = 0;
                  let completed = 0;
                  for (const photo of targets) {
                    const outcome = await store.indexPhotoWithFaceService(
                      photo.id,
                      faceServiceEnv()
                    );
                    if (outcome.status === "failed" || outcome.ok === false) {
                      errors += 1;
                      results.push({ ok: false, ...outcome });
                    } else {
                      completed += 1;
                      facesFound += outcome.faceCount || 0;
                      results.push({ ok: true, ...outcome });
                    }
                  }
                  sendJson(res, 200, {
                    processed: results.length,
                    completed,
                    facesFound,
                    errors,
                    results,
                    progress: await store.getReindexProgress(),
                  });
                  return;
                }
                sendJson(res, 503, { error: "Local reindex requires face-service + store support." });
                return;
              }
              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (pathName === "/api/approvals" && req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              sendJson(res, 200, await store.createApprovals(body.items || []));
              return;
            }

            if (pathName === "/api/admin/login" && req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              const { token } = await store.loginAdmin(body.password);
              sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(token, { secure: false }) });
              return;
            }

            if (pathName === "/api/admin/logout" && req.method === "POST") {
              await store.logoutAdmin(webRequest);
              sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
              return;
            }

            if (pathName === "/api/admin/me" && req.method === "GET") {
              await store.requireAdmin(webRequest);
              sendJson(res, 200, { ok: true, admin: true, counts: await store.approvalCounts() });
              return;
            }

            if (pathName === "/api/admin/approvals") {
              await store.requireAdmin(webRequest);
              if (req.method === "GET") {
                const status = url.searchParams.get("status") || "pending";
                sendJson(res, 200, {
                  approvals: await store.listApprovals(status),
                  counts: await store.approvalCounts(),
                });
                return;
              }
              if (req.method === "PATCH") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const result = await store.resolveApproval(body.id, body.decision);
                sendJson(res, 200, { ...result, counts: await store.approvalCounts() });
                return;
              }
              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (pathName === "/api/admin/photos") {
              await store.requireAdmin(webRequest);
              if (req.method === "GET") {
                const includeHidden = url.searchParams.get("includeHidden") !== "0";
                sendJson(res, 200, {
                  photos: await store.listAdminPhotos({ includeHidden }),
                });
                return;
              }
              if (req.method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const photo = await store.addPhoto(body);
                const { publicPhoto, queueFaceIndex } = await import("./lib/face-auto-index.js");
                queueFaceIndex(store, photo, faceServiceEnv());
                sendJson(res, 200, { photo: publicPhoto(photo), faceIndex: "queued" });
                return;
              }
              if (req.method === "PATCH") {
                const body = JSON.parse((await readBody(req)) || "{}");
                const action = String(body.action || "").toLowerCase();
                const target = body.url || body.id;
                if (action === "hide") {
                  sendJson(res, 200, { photo: await store.hidePhoto(target) });
                  return;
                }
                if (action === "restore") {
                  sendJson(res, 200, { photo: await store.restorePhoto(target) });
                  return;
                }
                sendJson(res, 400, { error: 'Use action "hide" or "restore".' });
                return;
              }
              if (req.method === "DELETE") {
                const target = url.searchParams.get("url") || url.searchParams.get("id");
                const mode = (url.searchParams.get("mode") || "hard").toLowerCase();
                if (mode === "soft" || mode === "hide") {
                  sendJson(res, 200, { photo: await store.hidePhoto(target), ok: true });
                  return;
                }
                await store.removePhoto(target, { kind: "admin" });
                sendJson(res, 200, { ok: true });
                return;
              }
              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (pathName === "/api/admin/db") {
              await store.requireAdmin(webRequest);
              if (req.method === "GET") {
                const table = url.searchParams.get("table");
                const format = (url.searchParams.get("format") || "").toLowerCase();
                if (table && (format === "csv" || url.searchParams.get("download") === "1")) {
                  const exported = await store.exportTableCsv(table);
                  res.statusCode = 200;
                  res.setHeader("Content-Type", "text/csv; charset=utf-8");
                  res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${exported.table}.csv"`
                  );
                  res.setHeader("Cache-Control", "no-store");
                  res.end(exported.csv || "");
                  return;
                }
                if (table) {
                  sendJson(res, 200, await store.exportTableCsv(table));
                  return;
                }
                sendJson(res, 200, { tables: await store.listDbTables() });
                return;
              }
              if (req.method === "POST") {
                const body = JSON.parse((await readBody(req)) || "{}");
                sendJson(res, 200, await store.runAdminSql(body.sql));
                return;
              }
              sendJson(res, 405, { error: "Method not allowed." });
              return;
            }

            if (pathName === "/api/consent" && req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              sendJson(res, 200, {
                consent: await store.createConsent({
                  fullName: body.fullName,
                  agreed: body.agreed,
                  userAgent: req.headers["user-agent"] || "",
                }),
              });
              return;
            }

            if (pathName === "/api/auth/register" && req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              const { token, user } = await store.registerUser(body);
              sendJson(res, 200, { user }, { "Set-Cookie": userSessionCookie(token, { secure: false }) });
              return;
            }

            if (pathName === "/api/auth/login" && req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              const { token, user } = await store.loginUser(body);
              sendJson(res, 200, { user }, { "Set-Cookie": userSessionCookie(token, { secure: false }) });
              return;
            }

            if (pathName === "/api/auth/logout" && req.method === "POST") {
              await store.logoutUser(webRequest);
              sendJson(res, 200, { ok: true }, { "Set-Cookie": clearUserSessionCookie() });
              return;
            }

            if (pathName === "/api/me" && req.method === "GET") {
              sendJson(res, 200, { user: await store.getCurrentUser(webRequest) });
              return;
            }

            if (pathName === "/api/me/photo" && req.method === "POST") {
              const body = JSON.parse((await readBody(req)) || "{}");
              sendJson(res, 200, await store.saveMyPhoto(webRequest, body));
              return;
            }

            next();
          } catch (error) {
            sendJson(res, error.status || 400, { error: error.message });
          }
        });
      },
    },
  ],
};
