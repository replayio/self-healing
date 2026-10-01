CREATE TABLE IF NOT EXISTS service_errors (
  request_id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id TEXT,
  operation TEXT NOT NULL,
  status INTEGER NOT NULL CHECK (status >= 500 AND status <= 599),
  code TEXT NOT NULL,
  bug_id TEXT,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS service_errors_account_time ON service_errors (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS service_errors_bug_time ON service_errors (account_id, bug_id, occurred_at DESC);
