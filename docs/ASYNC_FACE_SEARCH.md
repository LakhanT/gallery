# Async face search for event-scale spikes

> Local buffalo_l benchmark (2026-09-21): **~0.48 RPS/instance** at concurrency 2.
> Do **not** claim “supports 3,000 users” until staging load tests prove it.

## Inspection verdict (before this change)

| Question | Answer |
|----------|--------|
| Was public search synchronous? | **Yes** — one HTTP request waited for buffalo_l + D1 match |
| Was the inference queue durable? | **No** — in-memory asyncio semaphore/queue per process only |

## Traffic capacity vs inference capacity

```text
3,000 users can SUBMIT jobs     ≠   3,000 buffalo_l inferences at once
        │                                    │
        ▼                                    ▼
  Gateway + durable job records        Workers at ~0.48 RPS each (CPU)
  (bounded MAX_SEARCH_QUEUE)           × N instances × 0.6 safety
```

The queue absorbs the burst. Workers drain it at measured throughput.

## Target flow

```text
Browser
  POST /api/faces/search   → 202 { jobId, status: queued }
  “Finding your photos…”
  GET  /api/faces/search/:jobId  (gentle poll + jitter)
       │
       ▼
Cloudflare gateway (rate limit + MAX_SEARCH_QUEUE)
       │
       ├── ephemeral selfie → R2 tmp/face-search/{jobId}  (deleted after process)
       ├── job row → D1 face_search_jobs (status + results only)
       └── process via waitUntil (local: setImmediate)
              │
              ▼
         Face workers (Render)  MAX_SEARCH_CONCURRENCY=2
              │
              ▼
         D1 cosine match → store matches (no embeddings returned)
```

Gallery browse / R2 media **never** waits on buffalo_l.

## APIs

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/faces/search` | Accept selfie → **202** `{ jobId, status }` |
| GET | `/api/faces/search/:jobId` | Poll status / results |
| GET | `/api/faces/search?jobId=` | Fallback poll |

Selfies are **not** stored in D1. Temp object deleted after success/failure.
Embeddings are **never** returned to the browser.

## Concurrency / backpressure

| Knob | Default | Role |
|------|---------|------|
| `MAX_SEARCH_CONCURRENCY` | **2** | Per face-service process (do not raise to “fix” 3k) |
| `MAX_INDEX_CONCURRENCY` | 1 | Yields under search pressure |
| `MAX_QUEUE_SIZE` | 64 | In-process inference waiters → 503 |
| `MAX_SEARCH_QUEUE` | 3000 | Gateway accepted jobs (queued+processing) → 503 |
| `FACE_SEARCH_DUP_TTL_MS` | 90000 | Same SHA → reuse job / result |
| `SEARCH_CACHE_TTL` | 60s | Face-service detect-embed cache |

## Durable queue recommendation (Cloudflare Queues first)

**Today (local / interim):** job metadata in D1/local JSON is durable; processing uses `waitUntil` / `setImmediate` (best-effort). If the isolate dies mid-job, the job can stall until TTL expiry.

**Production recommendation:** Cloudflare Queues

```text
POST accept
  → write D1 job (queued)
  → put R2 tmp selfie
  → queue.send({ jobId })
  → 202

Queue consumer (Pages/Worker)
  → load tmp selfie
  → POST face service /detect-embed (lane=search)
  → D1 match
  → update job completed|failed
  → delete R2 tmp
```

| Topic | Design |
|-------|--------|
| Job create | D1 insert + R2 tmp + queue message |
| Consume | Queue consumer (horizontal) |
| Retries | Queue retry + max attempts → job failed |
| Duplicates | SHA-256 short TTL + queue idempotency via job status check |
| Expiration | `expires_at` + R2 lifecycle on `tmp/face-search/` |
| Results | D1 `result_json` (photo IDs only), TTL prune |
| 3,000 jobs | Gateway accepts up to `MAX_SEARCH_QUEUE`; workers drain |

Alternatives if Queues are unavailable: Upstash Redis lists, AWS SQS. Prefer Queues because the app already sits on Cloudflare.

## Frontend UX

1. Upload selfie  
2. Toast: **Finding your photos…**  
3. Job accepted (queued / processing)  
4. Poll with increasing interval (≈0.8s → 4s) + jitter  
5. Show results / busy / failed  

Max ~3 accept retries on 429/503. No aggressive poll stampede.

## Local load-test commands

```powershell
cd C:\Users\Lakhan\Downloads\gallery-main

# Small real completions (uses buffalo_l)
node scripts/loadtest-async-search.mjs --base http://127.0.0.1:5173 --image .data\tmp\test-face.jpg --users 5,20

# Burst acceptance only (safe for 1000–3000 on a laptop)
# Start Vite with: $env:FACE_SEARCH_SKIP_PROCESS="1"
node scripts/loadtest-async-search.mjs --base http://127.0.0.1:5173 --image .data\tmp\test-face.jpg --users 100,500,1000,3000 --accept-only --max-inflight 40
```

### Measured (local, 2026-09-21, accept-only + SKIP_PROCESS)

| Users | Accepted | 429 | 503 | Accept RPS | Accept p50 |
|-------|----------|-----|-----|------------|------------|
| 100 | 100 | 0 | 0 | 57.7 | 611 ms |
| 500 | 500 | 0 | 0 | 69.5 | 270 ms |
| 1000 | 1000 | 0 | 0 | 115.6 | 189 ms |
| 3000 | **3000** | 0 | 0 | 192.9 | 129 ms |

Smoke (real buffalo_l): POST → 202 queued → processing → completed.

This proves **traffic/queue capacity** locally, not inference capacity.

## Capacity math (from measured 0.48 RPS)

```text
stable_rps_per_instance = 0.48
estimated_rps = 0.48 × instances × 0.6

Wall time for 3000 jobs ≈ 3000 / estimated_rps
```

| Instances | est. RPS | ~time for 3000 jobs |
|-----------|----------|---------------------|
| 1 | 0.29 | ~2.9 hours |
| 4 | 1.15 | ~43 min |
| 12 | 3.46 | ~14 min |
| 40 | 11.5 | ~4.3 min |

These are **estimates from local CPU**, not production guarantees. Render sizing needs a Docker/staging benchmark next.

## Migration (do not apply remotely yet)

`migrations/0010_face_search_jobs.sql` — local/dev only until you choose to migrate.

## What was NOT done

- No production Cloudflare secret changes  
- No remote D1 migrate  
- No Render deploy  
- No Scenario E against production  
- Backup branch untouched  
