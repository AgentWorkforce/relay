-- Add Nango OAuth connection columns to users table
-- These columns support the two-connection pattern:
-- - nango_connection_id: Permanent login connection
-- - incoming_connection_id: Temp connection for polling during login
-- - pending_installation_request: Tracks org approval wait state

ALTER TABLE users ADD COLUMN IF NOT EXISTS nango_connection_id VARCHAR(255);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS incoming_connection_id VARCHAR(255);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_installation_request TIMESTAMP;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_nango_connection ON users(nango_connection_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_incoming_connection ON users(incoming_connection_id);
