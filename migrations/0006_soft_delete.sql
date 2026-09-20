ALTER TABLE photos ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_photos_deleted_at ON photos(deleted_at);
