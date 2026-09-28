CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  repository_url text NOT NULL,
  production_url text NOT NULL,
  default_branch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS projects_account_id ON projects (account_id, id);

-- Store desired configuration, never provider tokens or raw session recordings.
CREATE TABLE IF NOT EXISTS project_configurations (
  account_id text NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('integrations', 'context', 'sightmap', 'environments', 'report-settings')),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, project_id, kind),
  FOREIGN KEY (account_id, project_id) REFERENCES projects (account_id, id) ON DELETE CASCADE
);
