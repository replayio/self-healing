-- Access configuration only: never customer payloads, recordings, or query results.
CREATE TABLE IF NOT EXISTS account_data_configs (
  account_id UUID PRIMARY KEY REFERENCES accounts(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  fingerprint TEXT NOT NULL,
  encrypted_configuration TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
