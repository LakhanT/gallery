"""Configuration for InsightFace buffalo_l face service (event-scale)."""

from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


FACE_MODEL = "insightface-buffalo-l"
FACE_EMBEDDING_VERSION = _int("FACE_EMBEDDING_VERSION", 8)
FACE_DIM = 512

FACE_MATCH_SIMILARITY = _float("FACE_MATCH_SIMILARITY", 0.42)
FACE_UNCERTAIN_SIMILARITY = _float("FACE_UNCERTAIN_SIMILARITY", 0.32)
FACE_MIN_DETECTION_SCORE = _float("FACE_MIN_DETECTION_SCORE", 0.50)
FACE_MIN_QUALITY_SCORE = _float("FACE_MIN_QUALITY_SCORE", 0.25)
FACE_MIN_FACE_PX = _int("FACE_MIN_FACE_PX", 40)

FACE_PROVIDERS = [
    p.strip()
    for p in os.getenv("FACE_PROVIDERS", "CPUExecutionProvider").split(",")
    if p.strip()
]

FACE_SERVICE_API_KEY = os.getenv("FACE_SERVICE_API_KEY", "").strip()

# Request / image limits (phone selfies should pass; huge dumps rejected)
MAX_IMAGE_BYTES = _int("MAX_IMAGE_BYTES", 8 * 1024 * 1024)
MAX_IMAGE_PIXELS = _int("MAX_IMAGE_PIXELS", 12_000_000)  # ~3464x3464
MAX_LONG_EDGE = _int("MAX_LONG_EDGE", 1600)  # resize before inference

# Bounded inference capacity (defaults conservative; tune from benchmarks)
MAX_SEARCH_CONCURRENCY = _int("MAX_SEARCH_CONCURRENCY", 2)
MAX_INDEX_CONCURRENCY = _int("MAX_INDEX_CONCURRENCY", 1)
MAX_QUEUE_SIZE = _int("MAX_QUEUE_SIZE", 64)
REQUEST_TIMEOUT_SECONDS = _float("REQUEST_TIMEOUT_SECONDS", 45.0)

# Short-lived duplicate detect-embed cache (hash of bytes) — seconds
SEARCH_CACHE_TTL = _int("SEARCH_CACHE_TTL", 60)
SEARCH_CACHE_MAX_ENTRIES = _int("SEARCH_CACHE_MAX_ENTRIES", 256)

# Pause/throttle indexing when search queue is under pressure
INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT = _int("INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT", 16)
