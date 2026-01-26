-- Migration: Add user_emails table for storing GitHub-linked emails
-- This enables account reconciliation when users log in with email

CREATE TABLE IF NOT EXISTS "user_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email" varchar(255) NOT NULL,
  "verified" boolean NOT NULL DEFAULT false,
  "primary" boolean NOT NULL DEFAULT false,
  "source" varchar(50) NOT NULL DEFAULT 'github',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_emails_user_email_unique" UNIQUE ("user_id", "email")
);

-- Index for looking up users by email (for login reconciliation)
CREATE INDEX IF NOT EXISTS "idx_user_emails_email" ON "user_emails" ("email");

-- Index for looking up all emails for a user
CREATE INDEX IF NOT EXISTS "idx_user_emails_user_id" ON "user_emails" ("user_id");

-- Note: Requires 'user:email' scope in Nango GitHub integration configuration
