-- Per-photo face re-index status (retry-safe; pending can reach 0 with failures).
-- Does not alter already-applied migration 0007.

CREATE TABLE IF NOT EXISTS face_index_status (
  photo_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  face_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_face_index_status_status
  ON face_index_status(status);
