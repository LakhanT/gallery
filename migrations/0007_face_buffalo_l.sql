-- Face index v8: InsightFace buffalo_l (512-d ArcFace). Old FaceNet rows stay until re-index.

ALTER TABLE face_records ADD COLUMN model TEXT;
ALTER TABLE face_records ADD COLUMN embedding_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_face_records_embedding_version
  ON face_records(embedding_version);

CREATE TABLE IF NOT EXISTS reindex_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  faces_found INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
