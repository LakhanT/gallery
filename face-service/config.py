"""Configuration for InsightFace buffalo_l face service."""

from __future__ import annotations

import os

FACE_MODEL = "insightface-buffalo-l"
FACE_EMBEDDING_VERSION = int(os.getenv("FACE_EMBEDDING_VERSION", "8"))
FACE_DIM = 512

# Cosine similarity on L2-normalized embeddings (higher = more similar).
# Starting defaults for buffalo_l / ResNet50@WebFace600K — calibrate on your gallery.
FACE_MATCH_SIMILARITY = float(os.getenv("FACE_MATCH_SIMILARITY", "0.42"))
FACE_UNCERTAIN_SIMILARITY = float(os.getenv("FACE_UNCERTAIN_SIMILARITY", "0.32"))
FACE_MIN_DETECTION_SCORE = float(os.getenv("FACE_MIN_DETECTION_SCORE", "0.50"))
FACE_MIN_QUALITY_SCORE = float(os.getenv("FACE_MIN_QUALITY_SCORE", "0.25"))
FACE_MIN_FACE_PX = int(os.getenv("FACE_MIN_FACE_PX", "40"))

# insightface providers: CUDAExecutionProvider, CPUExecutionProvider
FACE_PROVIDERS = [
    p.strip()
    for p in os.getenv("FACE_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider").split(",")
    if p.strip()
]

FACE_SERVICE_API_KEY = os.getenv("FACE_SERVICE_API_KEY", "").strip()
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(15 * 1024 * 1024)))
