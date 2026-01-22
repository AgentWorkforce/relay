-- Add SSH access columns to workspaces for port forwarding (e.g., Codex OAuth callback tunneling)
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ssh_host" varchar(255);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ssh_port" integer;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ssh_password" varchar(255);
