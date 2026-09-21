# Event-scale face search (up to ~3,000 simultaneous attempts)

> **Backup before this work**
> - Local zip: `C:\Users\Lakhan\Downloads\gallery-backup-20260921-160147.zip`
> - GitHub branch: `backup/pre-scale-20260921`
>
> **Do not claim “supports 3,000 users” until staging load tests prove it.**

## Architecture (target)

```text
Browser (gallery browse NEVER waits on buffalo_l)
   │
   │  POST /api/faces/search  → 202 { jobId, status: queued }
   │  GET  /api/faces/search/:jobId  (poll + backoff + jitter)
   ▼
Cloudflare Pages + Functions
   │  rate limit + MAX_SEARCH_QUEUE
   │  D1 face_search_jobs
   │  R2 tmp/face-search/{jobId}  (private, deleted after)
   ▼
Cloudflare Queue: gallery-face-search  (+ DLQ)
   │  message = { jobId, objectKey, attempt, version }  ONLY
   ▼
Durable consumer Worker (wrangler.face-consumer.toml)
   │  atomic D1 claim → Render /detect-embed → match → complete
   ▼
Render face workers × N   MAX_SEARCH_CONCURRENCY=2
   │  buffalo_l → 512-d ArcFace
   ▼
D1 cosine match (full scan today — measure before replacing)
   │
   ▼
Job result (photo IDs only — no embeddings / no selfie to browser)
```

**LOCAL vs PRODUCTION dispatch**

| Mode | Mechanism |
|------|-----------|
| Local Vite | In-memory `gatewayPending` / `setImmediate` / `waitUntil` (no queue bindings) |
| Staging / Production | Cloudflare Queues producer (Pages) + durable consumer Worker |

Index uploads use `gallery-face-index` (+ DLQ) the same way; search has higher consumer concurrency.

See `docs/ASYNC_FACE_SEARCH.md` and `docs/DURABLE_QUEUES.md`.

Gallery open / thumbnails / R2 media remain independent of face workers.

## Benchmark snapshot (local CPU, 2026-09-21)

| Concurrency | RPS | p50 | Failures |
|-------------|-----|-----|----------|
| 1 | 0.40 | 1.83s | 0 |
| 2 | **0.48** | 3.80s | 0 |
| 5 | 0.39 | 11.86s | 1 |
| 10 | 0.48 | 14.07s | 1 |

**Do not raise `MAX_SEARCH_CONCURRENCY` past ~2** hoping for more throughput — CPU saturates.

## Concurrency model

| Lane | Env | Default | Role |
|------|-----|---------|------|
| Live search | `MAX_SEARCH_CONCURRENCY` | 2 / instance | Event selfies |
| Indexing | `MAX_INDEX_CONCURRENCY` | 1 / instance | Upload auto-index / admin reindex |
| Queue | `MAX_QUEUE_SIZE` | 64 | Waiting requests; overflow → **503** |
| Index pause | `INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT` | 16 | Refuse new index work under search load |

Workers are **stateless**. Horizontal scale = more Render instances behind the same URL.

## Rate-limit model (Pages)

| Env | Default | Meaning |
|-----|---------|---------|
| `FACE_SEARCH_RATE_LIMIT` | 20 | Requests / window / client key |
| `FACE_SEARCH_RATE_WINDOW_MS` | 60000 | Window |

Client key ≈ hash(event-token? + IP). Goal: stop spam/bots, not block the whole venue.

## Caching model

| Layer | What | TTL |
|-------|------|-----|
| Face service | SHA-256(image bytes) → detect-embed JSON (no selfie stored) | `SEARCH_CACHE_TTL` (default 60s) |

## New / updated endpoints

| Endpoint | Notes |
|----------|--------|
| `GET /livez` | Liveness (no key) |
| `GET /readyz` | Model ready + capacity (no key) |
| `GET/POST /health` | Full limits + metrics (API key) |
| `GET /metrics` | Counters/gauges (API key) |
| `POST /detect-embed` | `lane=search` (default) |
| `POST /detect-embed-index` | Indexing lane |

## Environment variables (face service)

```text
FACE_SERVICE_API_KEY
FACE_PROVIDERS=CPUExecutionProvider
MAX_IMAGE_BYTES
MAX_IMAGE_PIXELS
MAX_LONG_EDGE
MAX_SEARCH_CONCURRENCY
MAX_INDEX_CONCURRENCY
MAX_QUEUE_SIZE
REQUEST_TIMEOUT_SECONDS
SEARCH_CACHE_TTL
INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT
```

Pages (in addition to existing secrets):

```text
FACE_SERVICE_URL
FACE_SERVICE_API_KEY
FACE_SEARCH_RATE_LIMIT
FACE_SEARCH_RATE_WINDOW_MS
FACE_SERVICE_TIMEOUT_MS
```

## Benchmark (measure one worker first)

```powershell
cd C:\Users\Lakhan\Downloads\gallery-main
# face-service must be running with API key
node scripts/benchmark-face-service.mjs `
  --url http://127.0.0.1:8090 `
  --key YOUR_KEY `
  --image .data\tmp\test-face.jpg `
  --concurrency 1,2,5,10 `
  --requests 20
```

## Load-test scenarios

```powershell
# A: gallery open
node scripts/loadtest-scenarios.mjs --scenario A --gallery http://127.0.0.1:5173 --users 100

# B: open + /api/photos
node scripts/loadtest-scenarios.mjs --scenario B --gallery http://127.0.0.1:5173 --users 100

# C/D: face search (local)
node scripts/loadtest-scenarios.mjs --scenario C --gallery http://127.0.0.1:5173 --image .data\tmp\test-face.jpg --users 50

# E: only on STAGING
node scripts/loadtest-scenarios.mjs --scenario E --gallery https://STAGING --image selfie.jpg --users 500 --i-understand-staging-only
```

## Capacity math (template — fill from benchmark)

```text
stable_rps_per_instance  = <from benchmark where busy≈0 and p95 OK>
instances                = N  (Render)
safety_margin            = 0.6
estimated_sustained_rps  = stable_rps_per_instance × N × safety_margin

For a 10-minute spike of 3000 searches:
  required_rps ≈ 3000 / average_seconds_users_will_wait
```

**Until you fill numbers from staging tests, do not publish a “supports 3000” claim.**

## Cost estimate (order-of-magnitude)

| Render plan | Rough | Notes |
|-------------|-------|--------|
| Standard (2GB) | ~$25/instance/mo | Minimum for buffalo_l CPU |
| For event: 4–12 instances | ~$100–300/mo | Tuned after benchmark |
| Peak-only scale-up | Higher short-term | Prefer scheduled scale for event day |

Exact cost depends on region and Render pricing at deploy time.

## D1 / R2

- Migration **file only** (not applied remotely): `migrations/0009_face_scale_indexes.sql`
- Matching is still **in-memory cosine over v8 face_records** — measure at 10k/50k/100k faces before adding pgvector/Qdrant/FAISS
- Gallery should keep lazy-loading / not dump thousands of full-res images at once (`public/_headers` + frontend lazy load)

## Production sequence (later — not now)

1. Finish local benchmarks  
2. Deploy face workers to Render staging (multi-instance)  
3. Point staging Pages at staging face URL + secrets  
4. Apply D1 0007/0008/0009 on staging  
5. Run scenarios A–E on staging  
6. Only then: production secrets, migrations, deploy, reindex  

## Files changed (this hardening pass)

- `face-service/app.py`, `config.py`, `capacity.py`, `metrics.py`, `cache.py`, `preprocess.py`, `Dockerfile`
- `lib/face-client.js`, `rate-limit.js`, `face-auto-index.js`, `store.js`, `local-store.js`
- `functions/api/faces/search.js`
- `src/faces.js`
- `scripts/benchmark-face-service.mjs`, `scripts/loadtest-scenarios.mjs`
- `migrations/0009_face_scale_indexes.sql`
- `docs/SCALE_3000.md` (this file)
