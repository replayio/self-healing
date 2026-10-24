ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subtext_api_url TEXT NOT NULL DEFAULT 'https://api.fullstory.com/mcp/subtext';
