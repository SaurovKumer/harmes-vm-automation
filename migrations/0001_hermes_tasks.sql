-- Hermes task queue schema (development branch only).
-- Apply with Wrangler D1 migrations after binding a dedicated D1 database.
CREATE TABLE IF NOT EXISTS hermes_tasks (
  id TEXT PRIMARY KEY,
  telegram_update_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  request_text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result_summary TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_hermes_tasks_state_created
  ON hermes_tasks(state, created_at);
CREATE INDEX IF NOT EXISTS idx_hermes_tasks_lease
  ON hermes_tasks(state, lease_expires_at);
