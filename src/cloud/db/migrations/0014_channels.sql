-- Channels table for workspace-scoped messaging
CREATE TABLE IF NOT EXISTS "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"channel_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"visibility" varchar(50) DEFAULT 'public' NOT NULL,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_workspace_channel_unique" ON "channels" USING btree ("workspace_id","channel_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channels_workspace_id" ON "channels" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channels_status" ON "channels" USING btree ("status");
--> statement-breakpoint

-- Channel members table
CREATE TABLE IF NOT EXISTS "channel_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
	"member_id" varchar(255) NOT NULL,
	"member_type" varchar(50) DEFAULT 'user' NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"invited_by" varchar(255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_members_channel_member_unique" ON "channel_members" USING btree ("channel_id","member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_members_channel_id" ON "channel_members" USING btree ("channel_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_members_member_id" ON "channel_members" USING btree ("member_id");
