-- A launch token is atomically rotated into a browser session on redemption.
-- Only hashes are persisted. No API keys or provider/session data are copied here.
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('launch', 'browser')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry ON dashboard_sessions(expires_at);
