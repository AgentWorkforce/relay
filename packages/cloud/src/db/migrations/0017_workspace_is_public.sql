-- Add isPublic column to workspaces table for public community rooms
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_is_public" ON "workspaces" USING btree ("is_public");
