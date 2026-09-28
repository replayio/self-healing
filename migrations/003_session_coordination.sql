ALTER TABLE connections ADD COLUMN IF NOT EXISTS create_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS encrypted_ingest_token text;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS reporting_start_day date;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT false;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS lease uuid;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections(id),
  session_url text NOT NULL,
  qa_session_id text,
  sealed boolean NOT NULL DEFAULT false,
  review_request_id uuid NOT NULL,
  lease uuid,
  lease_until timestamptz,
  UNIQUE(connection_id, session_url)
);
CREATE TABLE IF NOT EXISTS upload_receipts (
  session_id uuid NOT NULL REFERENCES sessions(id),
  digest text NOT NULL,
  ingested boolean NOT NULL DEFAULT false,
  result jsonb,
  PRIMARY KEY(session_id, digest)
);
-- Provider MCP handles and review client IDs are coordination metadata, not recordings.
CREATE TABLE IF NOT EXISTS gateway_contexts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  encrypted_upstream_id text,
  client_ids jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
