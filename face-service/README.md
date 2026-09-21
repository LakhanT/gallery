# Face service (InsightFace buffalo_l)

Python FastAPI inference layer for Abbsolute Legends Gallery.

## Model

- **Name:** `insightface-buffalo-l`
- **Detector:** SCRFD-10GF
- **Recognizer:** ResNet50 @ WebFace600K (ArcFace)
- **Embedding:** 512-d, L2-normalized
- **Similarity:** `cosine_similarity = dot(a, b)` (higher = more similar)

## Setup

```bash
cd face-service
python -m venv .venv
# Windows:
.venv\Scripts\activate
pip install -r requirements.txt
```

First run downloads buffalo_l weights (~200MB+) into the insightface model cache.

## Run

```bash
# from face-service/
python -m uvicorn app:app --host 0.0.0.0 --port 8090
```

Or from repo root: `npm run face-service`

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `FACE_EMBEDDING_VERSION` | `8` | Must match gallery `FACE_EMBEDDING_VERSION` |
| `FACE_MATCH_SIMILARITY` | `0.42` | Confident match threshold |
| `FACE_UNCERTAIN_SIMILARITY` | `0.32` | Uncertain / admin review floor |
| `FACE_MIN_DETECTION_SCORE` | `0.50` | SCRFD score floor |
| `FACE_MIN_QUALITY_SCORE` | `0.25` | Quality heuristic floor |
| `FACE_MIN_FACE_PX` | `40` | Min face box side |
| `FACE_PROVIDERS` | `CUDAExecutionProvider,CPUExecutionProvider` | ONNX providers |
| `FACE_SERVICE_API_KEY` | empty | If set, require `X-API-Key` header |
| `MAX_IMAGE_BYTES` | 15MB | Upload limit |

## Endpoints

- `GET|POST /health` — readiness + thresholds
- `POST /detect-embed` — multipart `image` → faces with embeddings (does **not** search gallery)

## Tests

```bash
pytest tests -q
# optional full model:
set RUN_FACE_MODEL_TESTS=1
pytest tests -q
```
