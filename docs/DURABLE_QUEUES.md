# Durable Cloudflare Queues (face search + index)

> Production deploy remains blocked until queues exist, consumer Worker is deployed, Render is verified, and secrets are set.
> Do **not** claim 3,000 simultaneous real inferences are proven.

## Why a separate consumer Worker?

Cloudflare **Pages can produce** to Queues, but **Pages cannot consume** Queues.
Therefore:

| Component | Role |
|-----------|------|
| Pages (`wrangler.toml`) | Accept selfie → D1 job → R2 tmp → `FACE_SEARCH_QUEUE.send(...)` → 202 |
| Worker (`wrangler.face-consumer.toml`) | Drain queue → claim job → Render → match → complete → delete tmp |

## Queue names

```text
gallery-face-search
gallery-face-search-dlq
gallery-face-index
gallery-face-index-dlq
```

Create once (do not duplicate):

```powershell
npx wrangler queues list
npx wrangler queues create gallery-face-search
npx wrangler queues create gallery-face-search-dlq
npx wrangler queues create gallery-face-index
npx wrangler queues create gallery-face-index-dlq
```

## Message shape (identifiers only)

```json
{
  "type": "face-search",
  "jobId": "...",
  "objectKey": "tmp/face-search/...",
  "attempt": 1,
  "version": 1
}
```

Never includes: selfie bytes, embeddings, API keys.

## Idempotency

1. Consumer loads D1 job.
2. If `completed` / `failed` / `expired` → **ack** (no re-inference).
3. Else atomic `claimFaceSearchJob` (queued → processing, or stale processing reclaim).
4. Process once; delete R2 tmp on terminal success/failure.

## Retries

| Class | Examples | Action |
|-------|----------|--------|
| Transient | 429, 503, 5xx, timeout | `message.retry()` → CF retries → DLQ |
| Permanent | 400, 413, no face, expired, corrupt | mark failed, delete tmp, **ack** |

Search consumer: `max_concurrency = 4`  
Index consumer: `max_concurrency = 1` (yields to live search)

## Local development

No queue bindings in Vite → **in-memory** dispatcher remains.
Response may include `"dispatch": "local"` vs `"cloudflare-queue"`.

## Deploy order (staging first)

1. Apply D1 migrations including `0011_face_search_jobs_queue.sql` on staging.
2. Create queues (if missing).
3. Deploy consumer Worker + secrets (`FACE_SERVICE_URL`, `FACE_SERVICE_API_KEY`).
4. Deploy Pages with producer bindings.
5. Smoke: POST search → 202 → poll → completed.
6. Synthetic / load tests before production cutover.

## Git branch

Hardened + durable queue work lives on:

```text
scale/durable-face-queue
```
