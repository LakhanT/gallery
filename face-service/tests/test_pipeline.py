"""
Unit tests that do not require the full buffalo_l model download.
Integration tests marked with model are skipped unless RUN_FACE_MODEL_TESTS=1.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from matching import classify_similarity, cosine_similarity, l2_normalize
from quality import score_face_quality


def test_l2_normalize_unit_length():
    v = l2_normalize(np.random.randn(512).astype(np.float32))
    assert abs(float(np.linalg.norm(v)) - 1.0) < 1e-5


def test_cosine_identical_is_one():
    v = l2_normalize(np.random.randn(512).astype(np.float32))
    assert cosine_similarity(v, v) > 0.999


def test_cosine_orthogonal_near_zero():
    a = np.zeros(512, dtype=np.float32)
    a[0] = 1.0
    b = np.zeros(512, dtype=np.float32)
    b[1] = 1.0
    assert abs(cosine_similarity(a, b)) < 1e-5


def test_classify_thresholds():
    assert classify_similarity(0.50) == "match"
    assert classify_similarity(0.35) == "uncertain"
    assert classify_similarity(0.10) == "none"


def test_api_key_required(monkeypatch):
    monkeypatch.setenv("FACE_SERVICE_API_KEY", "")
    # reload config binding used by app
    import config as cfg

    monkeypatch.setattr(cfg, "FACE_SERVICE_API_KEY", "")
    from fastapi.testclient import TestClient
    import app as face_app

    monkeypatch.setattr(face_app, "FACE_SERVICE_API_KEY", "")
    client = TestClient(face_app.app)
    response = client.get("/health")
    assert response.status_code == 503


def test_api_key_rejects_wrong(monkeypatch):
    from fastapi.testclient import TestClient
    import app as face_app

    monkeypatch.setattr(face_app, "FACE_SERVICE_API_KEY", "secret-key")
    client = TestClient(face_app.app)
    response = client.get("/health", headers={"X-API-Key": "wrong"})
    assert response.status_code == 401
    response_ok = client.get("/health", headers={"X-API-Key": "secret-key"})
    # May be 200 or 200 with ready false if model missing — not 401
    assert response_ok.status_code != 401


def test_quality_tiny_face_low():
    img = np.full((400, 400, 3), 128, dtype=np.uint8)
    q = score_face_quality(img, [10, 10, 30, 30], 0.9)
    assert q < 0.7


def test_quality_large_sharp_face_higher():
    rng = np.random.default_rng(0)
    img = rng.integers(40, 200, size=(800, 800, 3), dtype=np.uint8)
    # add high-frequency noise in face region for sharpness
    img[200:450, 200:450] = rng.integers(0, 255, size=(250, 250, 3), dtype=np.uint8)
    q = score_face_quality(img, [200, 200, 450, 450], 0.95)
    assert q > 0.4


@pytest.mark.skipif(os.getenv("RUN_FACE_MODEL_TESTS") != "1", reason="Requires buffalo_l download")
def test_detect_embed_no_face_blank():
    from face_engine import detect_and_embed

    blank = np.zeros((480, 640, 3), dtype=np.uint8)
    result = detect_and_embed(blank)
    assert result["model"] == "insightface-buffalo-l"
    assert result["version"] == 8
    assert isinstance(result["faces"], list)
