"""InsightFace buffalo_l engine — SCRFD detection + ArcFace ResNet50 embeddings."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

import cv2
import numpy as np
from insightface.app import FaceAnalysis

from config import (
    FACE_DIM,
    FACE_EMBEDDING_VERSION,
    FACE_MIN_DETECTION_SCORE,
    FACE_MIN_FACE_PX,
    FACE_MIN_QUALITY_SCORE,
    FACE_MODEL,
    FACE_PROVIDERS,
)
from matching import l2_normalize
from quality import score_face_quality

log = logging.getLogger("face-engine")

_app: FaceAnalysis | None = None


def get_engine() -> FaceAnalysis:
    global _app
    if _app is not None:
        return _app

    log.info("Loading InsightFace model=%s providers=%s", FACE_MODEL, FACE_PROVIDERS)
    app = FaceAnalysis(name="buffalo_l", providers=FACE_PROVIDERS)
    # det_size: larger helps small faces in event photos
    app.prepare(ctx_id=0, det_size=(640, 640))
    _app = app
    log.info("InsightFace ready")
    return app


def decode_image(data: bytes) -> np.ndarray:
    """Legacy helper — prefer preprocess.decode_and_preprocess for API path."""
    from preprocess import decode_and_preprocess

    return decode_and_preprocess(data)


def detect_and_embed(image_bgr: np.ndarray) -> dict[str, Any]:
    """
    Detect ALL faces with SCRFD, embed with ArcFace (512-d), L2-normalize.
    Applies quality filtering; keeps moderate-quality faces.
    """
    app = get_engine()
    faces_raw = app.get(image_bgr) or []
    faces_out: list[dict[str, Any]] = []
    rejected = 0

    for face in faces_raw:
        bbox = face.bbox.astype(float).tolist()  # [x1,y1,x2,y2]
        det = float(getattr(face, "det_score", 0.0) or 0.0)
        x1, y1, x2, y2 = bbox
        bw, bh = x2 - x1, y2 - y1
        if min(bw, bh) < FACE_MIN_FACE_PX:
            rejected += 1
            continue
        if det < FACE_MIN_DETECTION_SCORE:
            rejected += 1
            continue

        emb = getattr(face, "normed_embedding", None)
        if emb is None:
            emb = getattr(face, "embedding", None)
        if emb is None:
            rejected += 1
            continue

        embedding = l2_normalize(np.asarray(emb, dtype=np.float32))
        if embedding.shape[0] != FACE_DIM:
            rejected += 1
            continue

        quality = score_face_quality(image_bgr, bbox, det)
        if quality < FACE_MIN_QUALITY_SCORE:
            rejected += 1
            continue

        faces_out.append(
            {
                "embedding": embedding.astype(np.float32).tolist(),
                "bbox": [float(x1), float(y1), float(x2), float(y2)],
                "detection_score": det,
                "quality_score": quality,
            }
        )

    # Largest face first (stable for single-face query UX)
    faces_out.sort(
        key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]),
        reverse=True,
    )

    return {
        "model": FACE_MODEL,
        "version": FACE_EMBEDDING_VERSION,
        "dim": FACE_DIM,
        "faces": faces_out,
        "rejected": rejected,
        "similarity_convention": "cosine_similarity = dot(L2(a), L2(b)); higher is better",
    }
