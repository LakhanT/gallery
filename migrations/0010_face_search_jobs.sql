-- Short-lived async face-search jobs (status + results only).
-- Selfies are NOT stored in this table. Ephemeral bytes live in R2/tmp and are deleted after processing.
-- Do NOT apply to production until you intentionally run remote migrations.

CREATE TABLE IF NOT EXISTS face_search_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  image_sha256 TEXT,
  client_key TEXT,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_face_search_jobs_status
  ON face_search_jobs(status);

CREATE INDEX IF NOT EXISTS idx_face_search_jobs_sha_created
  ON face_search_jobs(image_sha256, created_at);

CREATE INDEX IF NOT EXISTS idx_face_search_jobs_expires
  ON face_search_jobs(expires_at);
