# Deploy face-service on Render (no VPS)

InsightFace **buffalo_l** FastAPI service for Abbsolute Legends Gallery.

Gallery stays on Cloudflare Pages: `https://69ff6c06.gallery-752.pages.dev`  
This doc only covers the **Render** face-service. Do **not** set Cloudflare secrets or run D1/reindex until Render `/health` passes.

---

## What was added in this repo

| File | Purpose |
|------|---------|
| `face-service/Dockerfile` | Production image; listens on `$PORT` |
| `face-service/.dockerignore` | Keeps image small (excludes `.venv`, tests) |
| `render.yaml` | Render Blueprint (Docker web service) |
| `GET /livez` | Unauthenticated probe for Render (no secrets) |
| `GET/POST /health` | Still requires `X-API-Key` |
| `POST /detect-embed` | Unchanged; requires `X-API-Key` |

Recognition logic (SCRFD + ArcFace) is unchanged.

---

## 1. What to configure in Render

### Option A — Blueprint (recommended)

1. Push this repo to GitHub (`LakhanT/gallery`).
2. Render Dashboard → **New** → **Blueprint**.
3. Connect `LakhanT/gallery`.
4. Confirm `render.yaml` creates **gallery-face-service**.
5. When prompted, set secret `FACE_SERVICE_API_KEY` (generate a long random value; do not commit it).
6. Deploy. First boot downloads buffalo_l models (can take several minutes).

### Option B — Manual Web Service

1. **New** → **Web Service** → connect GitHub `LakhanT/gallery`.
2. Settings below.

---

## 2. GitHub repository / directory

| Setting | Value |
|---------|--------|
| Repository | `https://github.com/LakhanT/gallery` |
| Branch | `main` (or your active branch) |
| Runtime | **Docker** |
| Dockerfile path | `face-service/Dockerfile` |
| Docker build context | `face-service` |

If using **Native Python** instead of Docker (not recommended for InsightFace):

| Setting | Value |
|---------|--------|
| Root Directory | `face-service` |
| Runtime | Python 3 |

---

## 3. Build command

**Docker (recommended):** leave blank — Render builds from the Dockerfile.

**Native Python (fallback only):**

```text
pip install -r requirements.txt
```

---

## 4. Start command

**Docker:** leave blank — image `CMD` is:

```text
uvicorn app:app --host 0.0.0.0 --port $PORT
```

**Native Python:**

```text
uvicorn app:app --host 0.0.0.0 --port $PORT
```

Do **not** hardcode `8090` on Render.

---

## 5. Required environment variables

Set in Render → Environment (mark `FACE_SERVICE_API_KEY` as **secret**):

| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `FACE_SERVICE_API_KEY` | **Yes** | Long random string; same value later for Cloudflare |
| `FACE_PROVIDERS` | Yes | `CPUExecutionProvider` |
| `FACE_MATCH_SIMILARITY` | Optional | `0.42` |
| `FACE_UNCERTAIN_SIMILARITY` | Optional | `0.32` |
| `FACE_MIN_DETECTION_SCORE` | Optional | `0.50` |
| `FACE_MIN_QUALITY_SCORE` | Optional | `0.25` |

Never put the API key in source, `render.yaml` plaintext commits, or the frontend.

---

## 6. Is Render free / cheap enough for buffalo_l?

| Plan | Verdict |
|------|---------|
| **Free** (512 MB) | **Not sufficient.** buffalo_l + ONNX Runtime usually OOMs or thrash. Also spins down → slow cold starts + model reload. |
| **Starter** (~512 MB–1 GB class) | Risky; may OOM under load. |
| **Standard** (2 GB RAM) | **Minimum recommended** for CPU buffalo_l. |
| Larger / more CPU | Better for gallery reindex batches. |

`render.yaml` defaults to `plan: standard`.

Expect **first start** to download InsightFace models (~hundreds of MB) into the container.

---

## 7. Public URL you should expect

Render assigns something like:

```text
https://gallery-face-service.onrender.com
```

Exact hostname is shown in the Render dashboard after the first deploy (you can add a custom domain later).

Use that HTTPS origin (no trailing slash) later as Cloudflare `FACE_SERVICE_URL` — **not yet**.

---

## 8. Exact `/health` test command

Replace `YOUR_RENDER_URL` and `YOUR_API_KEY`:

```powershell
curl.exe -s -H "X-API-Key: YOUR_API_KEY" https://YOUR_RENDER_URL/health
```

Expected JSON includes `"ok":true`, `"ready":true`, `"model":"insightface-buffalo-l"`, `"version":8`.

Without key (should be **401**):

```powershell
curl.exe -s -w "`nHTTP:%{http_code}" https://YOUR_RENDER_URL/health
```

Platform probe (no key, **200**):

```powershell
curl.exe -s https://YOUR_RENDER_URL/livez
```

Optional detect-embed smoke test:

```powershell
curl.exe -s -H "X-API-Key: YOUR_API_KEY" -F "image=@C:\path\to\face.jpg" https://YOUR_RENDER_URL/detect-embed
```

---

## After Render is healthy (do later — not now)

1. `npx wrangler pages secret put FACE_SERVICE_URL --project-name gallery` → `https://gallery-face-service.onrender.com`
2. `npx wrangler pages secret put FACE_SERVICE_API_KEY --project-name gallery` → same key as Render
3. Apply D1 migrations `0007` / `0008`
4. Admin re-index until `pending = 0`

---

## Security notes

- uvicorn listens on `0.0.0.0:$PORT` behind Render’s HTTPS proxy.
- `/detect-embed` and `/health` require `X-API-Key`.
- `/livez` only returns `{"ok":true}` (no embeddings, no config secrets).
