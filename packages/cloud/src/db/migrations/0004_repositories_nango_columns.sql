-- Add Nango connection columns to repositories table
-- These columns support GitHub App OAuth via Nango

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS installation_id UUID;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS nango_connection_id VARCHAR(255);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_repositories_installation_id ON repositories(installation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_repositories_nango_connection ON repositories(nango_connection_id);
