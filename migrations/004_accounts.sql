CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY,
  subtext_fingerprint TEXT NOT NULL UNIQUE,
  encrypted_subtext_key TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  encrypted_api_key TEXT NOT NULL,
  encrypted_qa_token TEXT,
  qa_issue_attempted BOOLEAN NOT NULL DEFAULT false,
  lease UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
