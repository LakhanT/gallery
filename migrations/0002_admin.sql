CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_queue (
  id TEXT PRIMARY KEY,
  query_preview TEXT NOT NULL,
  query_descriptors TEXT NOT NULL,
  candidate_photo_id TEXT NOT NULL,
  candidate_url TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  candidate_preview TEXT,
  distance REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_queue(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
