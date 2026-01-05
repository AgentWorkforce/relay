ALTER TABLE "users" ADD COLUMN "stripe_customer_id" varchar(255);--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "ssh_host";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "ssh_port";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "ssh_password";