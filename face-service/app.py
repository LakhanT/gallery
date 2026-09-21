"""
FastAPI face inference service — InsightFace buffalo_l (SCRFD + ArcFace ResNet50).

Does NOT expose the gallery face index. Embeddings are returned only for images
you upload to this service (detect-embed / query). Matching against the gallery
happens in the Cloudflare gallery layer.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from config import (
    FACE_EMBEDDING_VERSION,
    FACE_MATCH_SIMILARITY,
    FACE_MIN_DETECTION_SCORE,
    FACE_MIN_QUALITY_SCORE,
    FACE_MODEL,
    FACE_SERVICE_API_KEY,
    FACE_UNCERTAIN_SIMILARITY,
    MAX_IMAGE_BYTES,
)
from face_engine import decode_image, detect_and_embed, get_engine

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("face-service")

app = FastAPI(title="Gallery Face Service", version="1.0.0")
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
    try:
        get_engine()
    except Exception as exc:  # noqa: BLE001
        log.exception("Model warm-up failed (will retry on first request): %s", exc)


@app.get("/livez")
def livez() -> dict:
    """
    Unauthenticated liveness for platform probes (e.g. Render healthCheckPath).
    Does not expose model status or secrets. Use /health with X-API-Key for readiness.
    """
    return {"ok": True}


@app.get("/health")
@app.post("/health")
def health(_: None = Depends(require_key)) -> dict:
    ready = True
    try:
        get_engine()
    except Exception as exc:  # noqa: BLE001
        ready = False
        return {
            "ok": False,
            "ready": False,
            "error": str(exc),
            "model": FACE_MODEL,
            "version": FACE_EMBEDDING_VERSION,
        }
    return {
        "ok": True,
        "ready": ready,
        "model": FACE_MODEL,
        "version": FACE_EMBEDDING_VERSION,
        "thresholds": {
            "match_similarity": FACE_MATCH_SIMILARITY,
            "uncertain_similarity": FACE_UNCERTAIN_SIMILARITY,
            "min_detection_score": FACE_MIN_DETECTION_SCORE,
            "min_quality_score": FACE_MIN_QUALITY_SCORE,
        },
        "similarity_convention": "cosine_similarity = dot(L2(a), L2(b)); higher is better",
    }


@app.post("/detect-embed")
async def detect_embed(
    image: UploadFile = File(...),
    _: None = Depends(require_key),
) -> dict:
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image.")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image too large.")
    try:
        bgr = decode_image(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return detect_and_embed(bgr)
    except Exception as exc:  # noqa: BLE001
        log.exception("detect-embed failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
