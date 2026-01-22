-- Add workspace_id to credentials table
-- Credentials are now workspace-scoped: tokens are stored on workspace daemons
-- Existing credentials keep workspace_id = NULL (legacy global credentials)
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Create index for workspace-based queries
CREATE INDEX IF NOT EXISTS idx_credentials_workspace_id ON credentials(workspace_id);
--> statement-breakpoint
-- Drop old unique constraint (user_id, provider) if it exists
ALTER TABLE credentials DROP CONSTRAINT IF EXISTS credentials_user_provider_unique;
--> statement-breakpoint
-- Add new unique constraint (user_id, provider, workspace_id) if it doesn't exist
-- This allows the same provider to be connected per-workspace
-- Note: NULL workspace_id values are treated as distinct, so legacy credentials still work
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credentials_user_provider_workspace_unique'
  ) THEN
    ALTER TABLE credentials ADD CONSTRAINT credentials_user_provider_workspace_unique
      UNIQUE (user_id, provider, workspace_id);
  END IF;
END $$;
