-- Factory-authored PR associations only. QA retains reports, runs and recordings.
CREATE TABLE IF NOT EXISTS bug_fix_prs (
  account_id text NOT NULL REFERENCES connections(account_id) ON DELETE CASCADE,
  qa_project_id text NOT NULL,
  bug_id text NOT NULL,
  pr_url text NOT NULL,
  PRIMARY KEY (account_id, qa_project_id, bug_id, pr_url)
);
