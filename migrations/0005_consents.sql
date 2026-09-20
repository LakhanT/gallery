CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  statement TEXT NOT NULL,
  agreed INTEGER NOT NULL DEFAULT 1,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consents_created_at ON consents(created_at DESC);
