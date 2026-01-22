-- Remove token storage from credentials table
-- Tokens are no longer stored centrally. CLI tools authenticate directly on workspace instances.

ALTER TABLE credentials DROP COLUMN IF EXISTS access_token;
--> statement-breakpoint
ALTER TABLE credentials DROP COLUMN IF EXISTS refresh_token;
--> statement-breakpoint
ALTER TABLE credentials DROP COLUMN IF EXISTS token_expires_at;
