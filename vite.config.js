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
    MAX_SEARCH_QUEUE: process.env.MAX_SEARCH_QUEUE || "3000",
    MAX_SEARCH_CONCURRENCY: process.env.MAX_SEARCH_CONCURRENCY || "2",
    GATEWAY_PROCESS_CONCURRENCY: process.env.GATEWAY_PROCESS_CONCURRENCY || "2",
    FACE_SEARCH_JOB_TTL_MS: process.env.FACE_SEARCH_JOB_TTL_MS || String(10 * 60 * 1000),
    FACE_SEARCH_DUP_TTL_MS: process.env.FACE_SEARCH_DUP_TTL_MS || "90000",
    MAX_IMAGE_BYTES: process.env.MAX_IMAGE_BYTES || String(8 * 1024 * 1024),
    FACE_SEARCH_SKIP_PROCESS: process.env.FACE_SEARCH_SKIP_PROCESS || "",
    FACE_SEARCH_SYNTHETIC: process.env.FACE_SEARCH_SYNTHETIC || "",
    FACE_SEARCH_SYNTHETIC_MS: process.env.FACE_SEARCH_SYNTHETIC_MS || "50",
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
              const { acceptFaceSearchJob } = await import("./lib/face-search-job.js");
              const { clientKeyFromRequest, consumeRateLimit } = await import("./lib/rate-limit.js");
              const raw = await readRawBody(req);
              const fwdHeaders = { "content-type": contentType };
              if (req.headers["x-event-token"]) {
                fwdHeaders["x-event-token"] = req.headers["x-event-token"];
              }
              if (req.headers["x-gallery-session"]) {
                fwdHeaders["x-gallery-session"] = req.headers["x-gallery-session"];
              }
              if (req.headers["x-forwarded-for"]) {
                fwdHeaders["x-forwarded-for"] = req.headers["x-forwarded-for"];
              }
              const request = new Request("http://localhost/api/faces/search", {
                method: "POST",
                headers: fwdHeaders,
                body: raw,
              });
              const key = await clientKeyFromRequest(request);
              const rl = consumeRateLimit(key, {
                limit: Number(process.env.FACE_SEARCH_RATE_LIMIT) || 40,
                windowMs: Number(process.env.FACE_SEARCH_RATE_WINDOW_MS) || 60_000,
              });
              if (!rl.ok) {
                res.setHeader("Retry-After", String(rl.retryAfterSec || 3));
                sendJson(res, 429, {
                  error:
                    "Too many face searches from this device. Please wait a few seconds and try again.",
                  busy: true,
                });
                return;
              }
              const form = await request.formData();
              const file = form.get("image") || form.get("file");
              if (!file || typeof file === "string") {
                sendJson(res, 400, { error: "Upload a selfie image." });
                return;
              }
              const bytes = await file.arrayBuffer();
              try {
                const accepted = await acceptFaceSearchJob({
                  store,
                  env: faceServiceEnv(),
                  imageBytes: bytes,
                  contentType: file.type || "image/jpeg",
                  filename: file.name || "selfie.jpg",
                  clientKey: key,
                  schedule: (fn) => {
                    setImmediate(() => {
                      Promise.resolve()
                        .then(fn)
                        .catch(() => {});
                    });
                  },
                });
                if (accepted.httpStatus === 202) {
                  res.setHeader("Retry-After", "2");
                }
                sendJson(res, accepted.httpStatus, { ...accepted.body, async: true });
              } catch (error) {
                const status = error.status || 400;
                if (status === 429 || status === 503) {
                  res.setHeader("Retry-After", String(error.retryAfter || 5));
                }
                sendJson(res, status, {
                  error: error.message || "Face search failed",
                  busy: status === 429 || status === 503,
                });
              }
              return;
            }

            // Poll: /api/faces/search/:jobId or ?jobId=
            {
              const jobMatch = pathName.match(/^\/api\/faces\/search\/([^/]+)$/);
              const jobId =
                (jobMatch && decodeURIComponent(jobMatch[1])) ||
                (pathName === "/api/faces/search" && req.method === "GET"
                  ? new URL(webRequest.url).searchParams.get("jobId") ||
                    new URL(webRequest.url).searchParams.get("id")
                  : null);
              if (jobId && req.method === "GET") {
                const { publicJobView } = await import("./lib/face-search-job.js");
                const job = await store.getFaceSearchJob(jobId);
                if (!job) {
                  sendJson(res, 404, { error: "Search job not found or expired." });
                  return;
                }
                if (
                  job.expiresAt &&
                  Date.parse(job.expiresAt) < Date.now() &&
                  job.status !== "completed"
                ) {
                  sendJson(res, 410, { error: "Search job expired. Please try again." });
                  return;
                }
                sendJson(res, 200, publicJobView(job, faceServiceEnv()));
                return;
              }
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
