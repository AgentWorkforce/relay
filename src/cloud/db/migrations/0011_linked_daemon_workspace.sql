-- Add workspaceId to linked_daemons for associating local agents with workspaces
ALTER TABLE "linked_daemons" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "linked_daemons" ADD CONSTRAINT "linked_daemons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_linked_daemons_workspace_id" ON "linked_daemons" USING btree ("workspace_id");
