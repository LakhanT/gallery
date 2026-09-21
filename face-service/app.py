"""
FastAPI face inference service — InsightFace buffalo_l (SCRFD + ArcFace ResNet50).

Event-scale additions:
- Bounded search vs index concurrency
- Bounded queue / backpressure (503 busy)
- Short-lived duplicate-image cache
- Safe preprocess (size / pixels / resize)
- Metrics without secrets or embeddings

Does NOT store the gallery face index. Matching stays in Cloudflare.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from cache import embed_cache
from capacity import CapacityBusyError, capacity
from config import (
    FACE_EMBEDDING_VERSION,
    FACE_MATCH_SIMILARITY,
    FACE_MIN_DETECTION_SCORE,
    FACE_MIN_QUALITY_SCORE,
    FACE_MODEL,
    FACE_SERVICE_API_KEY,
    FACE_UNCERTAIN_SIMILARITY,
    INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_PIXELS,
    MAX_INDEX_CONCURRENCY,
    MAX_LONG_EDGE,
    MAX_QUEUE_SIZE,
    MAX_SEARCH_CONCURRENCY,
    REQUEST_TIMEOUT_SECONDS,
    SEARCH_CACHE_TTL,
)
from face_engine import detect_and_embed, get_engine
from metrics import metrics
from preprocess import decode_and_preprocess

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("face-service")

app = FastAPI(title="Gallery Face Service", version="2.0.0-scale")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_key(x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")) -> None:
    if not FACE_SERVICE_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="FACE_SERVICE_API_KEY is not configured on the face service.",
        )
    if not x_api_key or x_api_key != FACE_SERVICE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key.")


@app.on_event("startup")
def startup() -> None:
    t0 = time.perf_counter()
    try:
        get_engine()
        metrics.observe("model_init_ms", (time.perf_counter() - t0) * 1000)
        metrics.set_gauge("model_ready", 1)
    except Exception as exc:  # noqa: BLE001
        metrics.set_gauge("model_ready", 0)
        log.exception("Model warm-up failed (will retry on first request): %s", exc)


@app.get("/livez")
def livez() -> dict:
    """Process liveness — no API key (Render healthCheckPath)."""
    return {"ok": True}


@app.get("/readyz")
def readyz() -> JSONResponse:
    """Model readiness without secrets — 503 if model not loaded."""
    snap = capacity.snapshot()
    ready = False
    try:
        get_engine()
        ready = True
    except Exception:  # noqa: BLE001
        ready = False
    body = {
        "ok": ready,
        "ready": ready,
        "model": FACE_MODEL,
        "version": FACE_EMBEDDING_VERSION,
        "capacity": {
            "search_active": snap.search_active,
            "index_active": snap.index_active,
            "queue_depth": snap.search_waiting + snap.index_waiting,
            "max_queue": snap.max_queue,
        },
    }
    return JSONResponse(body, status_code=200 if ready else 503)


@app.get("/health")
@app.post("/health")
def health(_: None = Depends(require_key)) -> dict:
    ready = True
    err = None
    try:
        get_engine()
    except Exception as exc:  # noqa: BLE001
        ready = False
        err = str(exc)
    snap = capacity.snapshot()
    payload = {
        "ok": ready,
        "ready": ready,
        "model": FACE_MODEL,
        "version": FACE_EMBEDDING_VERSION,
        "thresholds": {
            "match_similarity": FACE_MATCH_SIMILARITY,
            "uncertain_similarity": FACE_UNCERTAIN_SIMILARITY,
            "min_detection_score": FACE_MIN_DETECTION_SCORE,
            "min_quality_score": FACE_MIN_QUALITY_SCORE,
        },
        "limits": {
            "max_image_bytes": MAX_IMAGE_BYTES,
            "max_image_pixels": MAX_IMAGE_PIXELS,
            "max_long_edge": MAX_LONG_EDGE,
            "max_search_concurrency": MAX_SEARCH_CONCURRENCY,
            "max_index_concurrency": MAX_INDEX_CONCURRENCY,
            "max_queue_size": MAX_QUEUE_SIZE,
            "request_timeout_seconds": REQUEST_TIMEOUT_SECONDS,
            "search_cache_ttl": SEARCH_CACHE_TTL,
            "index_pause_when_search_queue_gt": INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT,
        },
        "capacity": {
            "search_active": snap.search_active,
            "index_active": snap.index_active,
            "search_waiting": snap.search_waiting,
            "index_waiting": snap.index_waiting,
        },
        "metrics": metrics.snapshot(),
        "similarity_convention": "cosine_similarity = dot(L2(a), L2(b)); higher is better",
    }
    if err:
        payload["error"] = err
    return payload


@app.get("/metrics")
def metrics_endpoint(_: None = Depends(require_key)) -> dict:
    snap = capacity.snapshot()
    return {
        "metrics": metrics.snapshot(),
        "capacity": {
            "search_active": snap.search_active,
            "index_active": snap.index_active,
            "search_waiting": snap.search_waiting,
            "index_waiting": snap.index_waiting,
            "max_queue": snap.max_queue,
        },
    }


async def _run_detect_embed(data: bytes, lane: str, request_id: str) -> dict:
    metrics.inc("face_search_requests" if lane == "search" else "index_requests")
    cache_key = embed_cache.hash_bytes(data)
    if lane == "search" and SEARCH_CACHE_TTL > 0:
        hit = embed_cache.get(cache_key)
        if hit is not None:
            metrics.inc("embed_cache_hit")
            out = dict(hit)
            out["cache"] = "hit"
            out["request_id"] = request_id
            return out

    try:
        bgr = decode_and_preprocess(data)
    except ValueError as exc:
        metrics.inc("face_bad_image")
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def _infer() -> dict:
        return detect_and_embed(bgr)

    try:
        result = await capacity.run(lane, _infer)
    except CapacityBusyError as exc:
        metrics.inc("face_search_503" if lane == "search" else "index_503")
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": "3"},
        ) from exc

    metrics.inc("face_search_success" if lane == "search" else "index_success")
    out = dict(result)
    out["cache"] = "miss"
    out["request_id"] = request_id
    out["lane"] = lane
    if lane == "search" and SEARCH_CACHE_TTL > 0:
        # Cache only the model payload (faces + meta), not request_id
        embed_cache.set(
            cache_key,
            {
                "model": result.get("model"),
                "version": result.get("version"),
                "dim": result.get("dim"),
                "faces": result.get("faces"),
                "rejected": result.get("rejected"),
                "similarity_convention": result.get("similarity_convention"),
            },
        )
    return out


@app.post("/detect-embed")
async def detect_embed(
    image: UploadFile = File(...),
    lane: str = Form(default="search"),
    x_face_lane: Optional[str] = Header(default=None, alias="X-Face-Lane"),
    _: None = Depends(require_key),
) -> dict:
    """
    Live search default lane=search.
    Indexing should send lane=index (form or X-Face-Lane header).
    """
    request_id = uuid.uuid4().hex[:12]
    resolved = (x_face_lane or lane or "search").strip().lower()
    if resolved not in ("search", "index"):
        resolved = "search"

    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image.")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image too large.")

    t0 = time.perf_counter()
    try:
        result = await _run_detect_embed(data, resolved, request_id)
        metrics.observe("detect_embed_total_ms", (time.perf_counter() - t0) * 1000)
        return result
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("detect-embed failed request_id=%s", request_id)
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc


@app.post("/detect-embed-index")
async def detect_embed_index(
    image: UploadFile = File(...),
    _: None = Depends(require_key),
) -> dict:
    """Explicit indexing lane (lower priority vs live search)."""
    request_id = uuid.uuid4().hex[:12]
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image.")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image too large.")
    return await _run_detect_embed(data, "index", request_id)
