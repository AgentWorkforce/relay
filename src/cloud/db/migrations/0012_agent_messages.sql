-- Agent Messages table for cloud-synced message history
-- Stores relay messages from daemons for search and retention

CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"daemon_id" uuid,
	"original_id" varchar(255) NOT NULL,
	"from_agent" varchar(255) NOT NULL,
	"to_agent" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"kind" varchar(50) DEFAULT 'message' NOT NULL,
	"topic" varchar(255),
	"thread" varchar(255),
	"channel" varchar(255),
	"is_broadcast" boolean DEFAULT false NOT NULL,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"data" jsonb,
	"payload_meta" jsonb,
	"message_ts" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"indexed_at" timestamp,
	CONSTRAINT "agent_messages_workspace_original_unique" UNIQUE("workspace_id","original_id")
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_daemon_id_linked_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."linked_daemons"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_workspace_id" ON "agent_messages" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_daemon_id" ON "agent_messages" USING btree ("daemon_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_from_agent" ON "agent_messages" USING btree ("from_agent");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_to_agent" ON "agent_messages" USING btree ("to_agent");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_thread" ON "agent_messages" USING btree ("thread");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_channel" ON "agent_messages" USING btree ("channel");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_message_ts" ON "agent_messages" USING btree ("message_ts");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_expires_at" ON "agent_messages" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_messages_indexed_at" ON "agent_messages" USING btree ("indexed_at");
