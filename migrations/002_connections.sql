-- Only encrypted credentials and coordination metadata live here. Session bodies stay in QA.
CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY,
  account_id text UNIQUE NOT NULL,
  encrypted_key text NOT NULL,
  name text NOT NULL,
  production_url text NOT NULL,
  qa_project_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
