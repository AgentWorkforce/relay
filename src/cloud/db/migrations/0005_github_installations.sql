-- Create github_installations table and add foreign key to repositories
-- This table tracks GitHub App installations for accessing repos

CREATE TABLE IF NOT EXISTS github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id VARCHAR(255) UNIQUE NOT NULL,
  account_type VARCHAR(50) NOT NULL,
  account_login VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  installed_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  permissions JSONB DEFAULT '{}',
  events TEXT[],
  suspended BOOLEAN NOT NULL DEFAULT false,
  suspended_at TIMESTAMP,
  suspended_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_github_installations_account_login ON github_installations(account_login);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_github_installations_installed_by ON github_installations(installed_by_id);
--> statement-breakpoint
-- Add foreign key constraint to repositories.installation_id
ALTER TABLE repositories
  ADD CONSTRAINT fk_repositories_installation
  FOREIGN KEY (installation_id)
  REFERENCES github_installations(id)
  ON DELETE SET NULL;
--> statement-breakpoint
-- Add updated_at trigger for github_installations
DROP TRIGGER IF EXISTS trg_github_installations_updated_at ON github_installations;
CREATE TRIGGER trg_github_installations_updated_at
  BEFORE UPDATE ON github_installations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
