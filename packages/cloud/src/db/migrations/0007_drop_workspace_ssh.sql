-- Drop SSH columns from workspaces table (no longer needed - CLI auth uses device flow)
ALTER TABLE workspaces DROP COLUMN IF EXISTS ssh_host;
--> statement-breakpoint
ALTER TABLE workspaces DROP COLUMN IF EXISTS ssh_port;
--> statement-breakpoint
ALTER TABLE workspaces DROP COLUMN IF EXISTS ssh_password;
