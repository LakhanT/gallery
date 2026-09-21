# Staging architecture (async face search)

> Local validation milestone (not production-ready claim):
> **3,000 jobs can be accepted safely** when the gateway queue is bounded.
> Worker drain is predictable only with measured RPS × instances.
> Processing today uses best-effort `waitUntil` / in-memory gateway pool —
> **not yet a durable queue consumer**.

## Target staging topology

```text
Browser
  │  POST /api/faces/search → 202 { jobId }
  │  GET  /api/faces/search/:jobId (poll, backoff)
  ▼
Cloudflare Pages (staging project)
  │  rate limit + MAX_SEARCH_QUEUE
  │  D1: face_search_jobs (status + results only)
  │  R2: tmp/face-search/{jobId}  (ephemeral selfie, deleted after)
  ▼
Cloudflare Queues  ← durable job messages { jobId }
  │
  ▼
Queue consumer (Pages Function / Worker)
  │  load tmp selfie → POST Render /detect-embed (lane=search)
  │  D1 cosine match → update job → delete tmp
  ▼
Render face workers × N (stateless Docker)
  │  MAX_SEARCH_CONCURRENCY=2
  │  MAX_INDEX_CONCURRENCY=0|1 during event
  │  buffalo_l CPU
  ▼
D1 metadata (source of truth)
```

Gallery browse / R2 media never wait on buffalo_l.

## Why Cloudflare Queues first

| Option | Fit | Notes |
|--------|-----|-------|
| **Cloudflare Queues** | Best default | Same platform as Pages/D1/R2; retries, delayed messages, no extra vendor |
| Upstash Redis | Good | Fast lists/streams; another secret + cost; fine if Queues lag |
| AWS SQS | Good | Mature; cross-cloud complexity vs CF-only stack |

**Do not keep production on in-memory `gatewayPending` alone** — Vite/Pages restart drops the processor list; job rows may stay `queued` until TTL without a consumer.

## Staging env (Pages)

```text
FACE_SERVICE_URL=<render-staging-url>
FACE_SERVICE_API_KEY=<secret>
MAX_SEARCH_QUEUE=3000
FACE_SEARCH_RATE_LIMIT=20
FACE_SEARCH_RATE_WINDOW_MS=60000
FACE_SEARCH_JOB_TTL_MS=600000
FACE_SEARCH_DUP_TTL_MS=90000
```

Apply migration `0010_face_search_jobs.sql` on **staging D1 only**.

## Staging env (Render × N)

```text
FACE_SERVICE_API_KEY=<same>
FACE_PROVIDERS=CPUExecutionProvider
MAX_SEARCH_CONCURRENCY=2
MAX_INDEX_CONCURRENCY=1
MAX_QUEUE_SIZE=64
SEARCH_CACHE_TTL=60
INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT=16
PORT from Render
```

Health: `/livez` (liveness), `/health` (ready + capacity).

## Capacity planning (from local CPU benchmark)

```text
stable_rps_per_instance ≈ 0.48
estimated_rps = 0.48 × N × 0.6
wall_time_3000 ≈ 3000 / estimated_rps
```

Use staging Docker benchmark before locking N.

## Exact next deployment steps (order)

1. Create Cloudflare Pages **staging** project + staging D1 + staging R2 (or separate bindings).
2. Apply D1 migrations through `0010_face_search_jobs.sql` on staging only.
3. Deploy face-service Docker to Render **staging**; set secrets; confirm `/livez` + `/health`.
4. Set Pages staging secrets: `FACE_SERVICE_URL`, `FACE_SERVICE_API_KEY`.
5. Add Cloudflare Queue + consumer binding in `wrangler.toml` (staging); wire `queue.send({jobId})` on accept; consumer calls existing `processFaceSearchJob`.
6. Deploy Pages staging; smoke: 1 selfie → 202 → poll → completed.
7. Staging load: accept-only 3000; real completions 25/50/100; synthetic drain if needed.
8. Size Render `N` from staging RPS × 0.6 margin.
9. Only then plan production cutover (secrets, migrate, deploy) — **not in this phase**.

## Acceptance milestone (staging)

```text
✓ 3,000 jobs accepted safely (bounded queue → 503)
✓ Durable queue (Cloudflare Queues) — jobs survive worker/Pages restart
✓ Workers drain predictably at measured RPS
✓ Gallery unaffected under face-search load
✗ Do NOT claim “supports 3,000 simultaneous face searches” until staging proves it
```
