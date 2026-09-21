# InsightFace buffalo_l face service for Render (and local Docker).
# Binds to Render's $PORT. Do not hardcode 8090 in production.

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # CPU-only on Render
    FACE_PROVIDERS=CPUExecutionProvider \
    # Persist / cache InsightFace models inside the image/workdir
    INSIGHTFACE_HOME=/app/.insightface

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY app.py config.py face_engine.py matching.py quality.py ./

# Optional: warm nothing at build time (models download on first boot).
# First deploy / cold start may take several minutes while buffalo_l downloads.

EXPOSE 10000

# Render injects PORT. Fallback 10000 for local docker runs.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000}"]
