-- Non-destructive indexes to speed gallery + face lookups under load.
-- Do NOT apply to production until you intentionally run remote migrations.

CREATE INDEX IF NOT EXISTS idx_photos_deleted_created
  ON photos(deleted_at, created_at);

CREATE INDEX IF NOT EXISTS idx_face_records_model_version
  ON face_records(model, embedding_version);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status_created
  ON approval_queue(status, created_at);
