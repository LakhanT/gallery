-- Queue-oriented columns for face_search_jobs (non-destructive).
-- Do NOT apply to production until you intentionally run remote migrations.

ALTER TABLE face_search_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE face_search_jobs ADD COLUMN r2_object_key TEXT;
ALTER TABLE face_search_jobs ADD COLUMN claimed_at TEXT;
