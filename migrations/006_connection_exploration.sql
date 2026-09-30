-- Existing connections used QA's automatic initial exploration. Preserve that history.
-- New connections explicitly insert false unless the caller opts in.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS start_exploration boolean NOT NULL DEFAULT true;
