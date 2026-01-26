-- Migration: Add email authentication support
-- Allows users to sign up and log in with email/password in addition to GitHub OAuth

-- Make githubId nullable (for email-only users)
ALTER TABLE "users" ALTER COLUMN "github_id" DROP NOT NULL;

-- Make githubUsername nullable (for email-only users)
ALTER TABLE "users" ALTER COLUMN "github_username" DROP NOT NULL;

-- Add email authentication fields
ALTER TABLE "users"
ADD COLUMN "password_hash" varchar(255),
ADD COLUMN "email_verified" boolean NOT NULL DEFAULT false,
ADD COLUMN "email_verification_token" varchar(255),
ADD COLUMN "email_verification_expires" timestamp,
ADD COLUMN "display_name" varchar(255);

-- Add unique constraint on email (if not already exists)
-- Drop old index if exists and create unique constraint
DROP INDEX IF EXISTS "idx_users_email";
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE ("email");

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");
