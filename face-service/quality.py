"""Face quality heuristics for InsightFace detections."""

from __future__ import annotations

import cv2
import numpy as np

from config import FACE_MIN_FACE_PX


def _laplacian_var(gray: np.ndarray) -> float:
    if gray.size == 0:
        return 0.0
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def score_face_quality(
    image_bgr: np.ndarray,
    bbox: list[float],
    detection_score: float,
) -> float:
    """
    Return quality in [0, 1]. Combines size, detection confidence, sharpness, brightness.
    Does not hard-reject moderate faces — callers apply FACE_MIN_QUALITY_SCORE.
    """
    h, w = image_bgr.shape[:2]
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    bw, bh = max(0, x2 - x1), max(0, y2 - y1)
    if bw < 2 or bh < 2:
        return 0.0

    face = image_bgr[y1:y2, x1:x2]
    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)

    # Size: prefer faces with min side >= ~112px
    min_side = float(min(bw, bh))
    size_score = min(1.0, min_side / 112.0)
    if min_side < FACE_MIN_FACE_PX:
        size_score *= 0.35

    # Relative area
    rel = (bw * bh) / float(max(1, w * h))
    area_score = min(1.0, rel / 0.04)

    det_score = float(np.clip(detection_score, 0.0, 1.0))

    sharp = _laplacian_var(gray)
    # Typical sharp crops land well above 50–100; map softly
    sharp_score = float(np.clip(sharp / 120.0, 0.0, 1.0))

    mean = float(np.mean(gray))
    # Penalize near-black / near-white
    if mean < 25 or mean > 235:
        bright_score = 0.25
    elif mean < 45 or mean > 210:
        bright_score = 0.55
    else:
        bright_score = 1.0

    quality = (
        0.30 * size_score
        + 0.15 * area_score
        + 0.30 * det_score
        + 0.15 * sharp_score
        + 0.10 * bright_score
    )
    return float(np.clip(quality, 0.0, 1.0))
