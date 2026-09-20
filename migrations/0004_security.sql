ALTER TABLE photos ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_photos_owner ON photos(owner_id);
