"""Cosine similarity helpers for L2-normalized ArcFace embeddings."""

from __future__ import annotations

import numpy as np

from config import FACE_DIM, FACE_MATCH_SIMILARITY, FACE_UNCERTAIN_SIMILARITY


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(v))
    if norm < 1e-12:
        return v
    return v / norm


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """
    Cosine similarity for L2-normalized vectors = dot product.
    Range approximately [-1, 1]; same person typically >> 0.3 for buffalo_l.
    """
    aa = np.asarray(a, dtype=np.float32).reshape(-1)
    bb = np.asarray(b, dtype=np.float32).reshape(-1)
    if aa.shape[0] != FACE_DIM or bb.shape[0] != FACE_DIM:
        return -1.0
    return float(np.dot(aa, bb))


def classify_similarity(sim: float) -> str:
    if sim >= FACE_MATCH_SIMILARITY:
        return "match"
    if sim >= FACE_UNCERTAIN_SIMILARITY:
        return "uncertain"
    return "none"
