# Face recognition upgrade (buffalo_l)

See also:
- [FACE_SERVICE_RENDER.md](./FACE_SERVICE_RENDER.md) — deploy face-service on **Render** (recommended without a VPS)
- [FACE_SERVICE_DEPLOY.md](./FACE_SERVICE_DEPLOY.md) — Hostinger VPS + Nginx

## Architecture

```
Vite gallery  →  Cloudflare Pages Functions  →  D1 (face_records v8) + R2
                              │
                              ▼
                     FACE_SERVICE_URL
                              │
                              ▼
              FastAPI + InsightFace buffalo_l
                 SCRFD detect + ArcFace 512-d
```

- Visitors **search** only (selfie → `/api/faces/search` multipart).
- **Indexing** is admin-only (`/api/admin/reindex`) → face service → D1.
- FaceNet 128-d records are **ignored** (never mixed with ArcFace).

## Similarity convention

For L2-normalized embeddings:

`cosine_similarity = dot(a, b)`  (higher is better)

Defaults (calibrate on your gallery):

- Match: `similarity >= 0.42`
- Uncertain: `0.32 <= similarity < 0.42`

Configured in `lib/face-config.js` and face-service `config.py` (env overrides on the service).

## Environment / secrets

Pages:

```bash
npx wrangler pages secret put FACE_SERVICE_URL --project-name gallery
npx wrangler pages secret put FACE_SERVICE_API_KEY --project-name gallery
npx wrangler pages secret put ADMIN_PASSWORD --project-name gallery
```

Local:

```bash
set FACE_SERVICE_URL=http://127.0.0.1:8090
set FACE_SERVICE_API_KEY=dev-key
```

## Commands

```bash
# Face service
cd face-service && python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8090

# Gallery
npm install
npm run db:migrate:remote   # includes 0007 + 0008 (reindex status)
npm run build
npm test
npx wrangler pages deploy dist --project-name gallery

# Unit tests (no model download)
npm test
cd face-service && python -m pytest tests -q
```

## Re-index

1. Start face service and ensure Pages can reach `FACE_SERVICE_URL` with matching `FACE_SERVICE_API_KEY`.
2. Apply D1 migrations `0007` and `0008` if not already applied.
3. Open `/admin.html` → **Re-index (buffalo_l)**.
4. Click **Run until done** (stops when pending = 0; failures are tracked separately).
5. Progress: Indexed / With faces / No faces / Failed / Pending.
6. Use **Retry failed** to reset failed photos to pending.

## Public search invariant

`image → FastAPI → SCRFD → ArcFace → 512-d → D1 match`

Client-supplied embeddings are rejected on `/api/faces/search`.
Admin-only embedding search: `POST /api/admin/faces/search`.

## Threshold calibration

1. Admin reindex panel shows current thresholds JSON.
2. Adjust `FACE_MATCH_SIMILARITY` / `FACE_UNCERTAIN_SIMILARITY` in:
   - `lib/face-config.js` (gallery matching)
   - face-service env (quality gates / health display)
3. Redeploy gallery after JS threshold changes.
4. Use Same/Different/Not sure on uncertain matches; inspect similarity in approval cards.

## Known limitations

- buffalo_l needs CPU/GPU host — not runnable inside Cloudflare Workers.
- First face-service start downloads models.
- Worker CPU time limits batch size (~5–8 photos per admin request).
- Tiny / extreme profile faces may still miss.
- Multi-reference selfie aggregation uses up to 3 faces from one image; multi-file references can be added later.
- Production is not ready until secrets + migrations + reindex pending=0 are confirmed on the live project.
