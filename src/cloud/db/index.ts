/**
 * Agent Relay Cloud - Database Layer
 *
 * PostgreSQL database access for users, credentials, workspaces, and repos.
 */

import { Pool, PoolClient } from 'pg';
import { getConfig } from '../config';

// Initialize pool lazily
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

// Types
export type PlanType = 'free' | 'pro' | 'team' | 'enterprise';

export interface User {
  id: string;
  githubId: string;
  githubUsername: string;
  email?: string;
  avatarUrl?: string;
  plan: PlanType;
  onboardingCompletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Credential {
  id: string;
  userId: string;
  provider: string;
  accessToken: string; // Encrypted
  refreshToken?: string; // Encrypted
  tokenExpiresAt?: Date;
  scopes?: string[];
  providerAccountId?: string;
  providerAccountEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Workspace {
  id: string;
  userId: string;
  name: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  computeProvider: 'fly' | 'railway' | 'docker';
  computeId?: string; // External ID from compute provider
  publicUrl?: string; // Default URL (e.g., workspace-abc.agentrelay.dev)
  customDomain?: string; // User's custom domain (e.g., agents.acme.com)
  customDomainStatus?: 'pending' | 'verifying' | 'active' | 'error';
  config: WorkspaceConfig;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceConfig {
  providers: string[];
  repositories: string[];
  supervisorEnabled: boolean;
  maxAgents: number;
}

export type WorkspaceMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  invitedBy?: string;
  invitedAt: Date;
  acceptedAt?: Date;
  // Denormalized for easy display
  user?: {
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
  };
}

export interface Repository {
  id: string;
  userId: string;
  workspaceId?: string;
  githubFullName: string; // e.g., "owner/repo"
  githubId: number;
  defaultBranch: string;
  isPrivate: boolean;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// User queries
export const users = {
  async findById(id: string): Promise<User | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async findByGithubId(githubId: string): Promise<User | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM users WHERE github_id = $1',
      [githubId]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  },

  async findByGithubUsername(username: string): Promise<User | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM users WHERE github_username = $1',
      [username]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  },

  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  },

  async upsert(data: {
    githubId: string;
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
  }): Promise<User> {
    const { rows } = await getPool().query(
      `INSERT INTO users (github_id, github_username, email, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE SET
         github_username = EXCLUDED.github_username,
         email = COALESCE(EXCLUDED.email, users.email),
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         updated_at = NOW()
       RETURNING *`,
      [data.githubId, data.githubUsername, data.email, data.avatarUrl]
    );
    return mapUser(rows[0]);
  },

  async completeOnboarding(userId: string): Promise<void> {
    await getPool().query(
      'UPDATE users SET onboarding_completed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [userId]
    );
  },
};

// Credential queries
export const credentials = {
  async findByUserId(userId: string): Promise<Credential[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM credentials WHERE user_id = $1',
      [userId]
    );
    return rows.map(mapCredential);
  },

  async findByUserAndProvider(userId: string, provider: string): Promise<Credential | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM credentials WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );
    return rows[0] ? mapCredential(rows[0]) : null;
  },

  async upsert(data: {
    userId: string;
    provider: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: Date;
    scopes?: string[];
    providerAccountId?: string;
    providerAccountEmail?: string;
  }): Promise<Credential> {
    const { rows } = await getPool().query(
      `INSERT INTO credentials (user_id, provider, access_token, refresh_token, token_expires_at, scopes, provider_account_id, provider_account_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, credentials.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         provider_account_id = EXCLUDED.provider_account_id,
         provider_account_email = EXCLUDED.provider_account_email,
         updated_at = NOW()
       RETURNING *`,
      [
        data.userId,
        data.provider,
        data.accessToken,
        data.refreshToken,
        data.tokenExpiresAt,
        data.scopes,
        data.providerAccountId,
        data.providerAccountEmail,
      ]
    );
    return mapCredential(rows[0]);
  },

  async delete(userId: string, provider: string): Promise<void> {
    await getPool().query(
      'DELETE FROM credentials WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );
  },

  async updateTokens(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: Date
  ): Promise<void> {
    await getPool().query(
      `UPDATE credentials SET
         access_token = $3,
         refresh_token = COALESCE($4, refresh_token),
         token_expires_at = $5,
         updated_at = NOW()
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider, accessToken, refreshToken, expiresAt]
    );
  },
};

// Workspace queries
export const workspaces = {
  async findById(id: string): Promise<Workspace | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM workspaces WHERE id = $1',
      [id]
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  },

  async findByUserId(userId: string): Promise<Workspace[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM workspaces WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return rows.map(mapWorkspace);
  },

  async create(data: {
    userId: string;
    name: string;
    computeProvider: 'fly' | 'railway' | 'docker';
    config: WorkspaceConfig;
  }): Promise<Workspace> {
    const { rows } = await getPool().query(
      `INSERT INTO workspaces (user_id, name, status, compute_provider, config)
       VALUES ($1, $2, 'provisioning', $3, $4)
       RETURNING *`,
      [data.userId, data.name, data.computeProvider, JSON.stringify(data.config)]
    );
    return mapWorkspace(rows[0]);
  },

  async updateStatus(
    id: string,
    status: Workspace['status'],
    options?: { computeId?: string; publicUrl?: string; errorMessage?: string }
  ): Promise<void> {
    await getPool().query(
      `UPDATE workspaces SET
         status = $2,
         compute_id = COALESCE($3, compute_id),
         public_url = COALESCE($4, public_url),
         error_message = $5,
         updated_at = NOW()
       WHERE id = $1`,
      [id, status, options?.computeId, options?.publicUrl, options?.errorMessage]
    );
  },

  async delete(id: string): Promise<void> {
    await getPool().query('DELETE FROM workspaces WHERE id = $1', [id]);
  },

  async setCustomDomain(
    id: string,
    customDomain: string,
    status: Workspace['customDomainStatus'] = 'pending'
  ): Promise<void> {
    await getPool().query(
      `UPDATE workspaces SET
         custom_domain = $2,
         custom_domain_status = $3,
         updated_at = NOW()
       WHERE id = $1`,
      [id, customDomain, status]
    );
  },

  async updateCustomDomainStatus(
    id: string,
    status: Workspace['customDomainStatus']
  ): Promise<void> {
    await getPool().query(
      `UPDATE workspaces SET custom_domain_status = $2, updated_at = NOW() WHERE id = $1`,
      [id, status]
    );
  },

  async removeCustomDomain(id: string): Promise<void> {
    await getPool().query(
      `UPDATE workspaces SET custom_domain = NULL, custom_domain_status = NULL, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  async findByCustomDomain(domain: string): Promise<Workspace | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM workspaces WHERE custom_domain = $1',
      [domain]
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  },
};

// Workspace member queries
export const workspaceMembers = {
  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceMember[]> {
    const { rows } = await getPool().query(
      `SELECT wm.*, u.github_username, u.email
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1
       ORDER BY wm.role, wm.invited_at`,
      [workspaceId]
    );
    return rows.map(mapWorkspaceMember);
  },

  async findByUserId(userId: string): Promise<WorkspaceMember[]> {
    const { rows } = await getPool().query(
      `SELECT wm.*, u.github_username, u.email
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.user_id = $1 AND wm.accepted_at IS NOT NULL`,
      [userId]
    );
    return rows.map(mapWorkspaceMember);
  },

  async findMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    const { rows } = await getPool().query(
      `SELECT wm.*, u.github_username, u.email
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
      [workspaceId, userId]
    );
    return rows[0] ? mapWorkspaceMember(rows[0]) : null;
  },

  async addMember(data: {
    workspaceId: string;
    userId: string;
    role: WorkspaceMemberRole;
    invitedBy: string;
  }): Promise<WorkspaceMember> {
    const { rows } = await getPool().query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.workspaceId, data.userId, data.role, data.invitedBy]
    );
    return mapWorkspaceMember(rows[0]);
  },

  async acceptInvite(workspaceId: string, userId: string): Promise<void> {
    await getPool().query(
      `UPDATE workspace_members SET accepted_at = NOW() WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
  },

  async updateRole(workspaceId: string, userId: string, role: WorkspaceMemberRole): Promise<void> {
    await getPool().query(
      `UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId, role]
    );
  },

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await getPool().query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
  },

  async getPendingInvites(userId: string): Promise<WorkspaceMember[]> {
    const { rows } = await getPool().query(
      `SELECT wm.*, w.name as workspace_name, u.github_username as inviter_username
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       JOIN users u ON u.id = wm.invited_by
       WHERE wm.user_id = $1 AND wm.accepted_at IS NULL`,
      [userId]
    );
    return rows.map(mapWorkspaceMember);
  },

  async isOwner(workspaceId: string, userId: string): Promise<boolean> {
    const { rows } = await getPool().query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`,
      [workspaceId, userId]
    );
    return rows.length > 0;
  },

  async canEdit(workspaceId: string, userId: string): Promise<boolean> {
    const { rows } = await getPool().query(
      `SELECT 1 FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'admin', 'member')
       AND accepted_at IS NOT NULL`,
      [workspaceId, userId]
    );
    return rows.length > 0;
  },

  async canView(workspaceId: string, userId: string): Promise<boolean> {
    const { rows } = await getPool().query(
      `SELECT 1 FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
      [workspaceId, userId]
    );
    return rows.length > 0;
  },
};

// Repository queries
export const repositories = {
  async findByUserId(userId: string): Promise<Repository[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM repositories WHERE user_id = $1 ORDER BY github_full_name',
      [userId]
    );
    return rows.map(mapRepository);
  },

  async findByWorkspaceId(workspaceId: string): Promise<Repository[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM repositories WHERE workspace_id = $1',
      [workspaceId]
    );
    return rows.map(mapRepository);
  },

  async upsert(data: {
    userId: string;
    githubFullName: string;
    githubId: number;
    defaultBranch: string;
    isPrivate: boolean;
  }): Promise<Repository> {
    const { rows } = await getPool().query(
      `INSERT INTO repositories (user_id, github_full_name, github_id, default_branch, is_private)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, github_full_name) DO UPDATE SET
         github_id = EXCLUDED.github_id,
         default_branch = EXCLUDED.default_branch,
         is_private = EXCLUDED.is_private,
         updated_at = NOW()
       RETURNING *`,
      [data.userId, data.githubFullName, data.githubId, data.defaultBranch, data.isPrivate]
    );
    return mapRepository(rows[0]);
  },

  async assignToWorkspace(repoId: string, workspaceId: string): Promise<void> {
    await getPool().query(
      'UPDATE repositories SET workspace_id = $2, updated_at = NOW() WHERE id = $1',
      [repoId, workspaceId]
    );
  },

  async updateSyncStatus(
    id: string,
    status: Repository['syncStatus'],
    lastSyncedAt?: Date
  ): Promise<void> {
    await getPool().query(
      `UPDATE repositories SET
         sync_status = $2,
         last_synced_at = COALESCE($3, last_synced_at),
         updated_at = NOW()
       WHERE id = $1`,
      [id, status, lastSyncedAt]
    );
  },

  async delete(id: string): Promise<void> {
    await getPool().query('DELETE FROM repositories WHERE id = $1', [id]);
  },
};

// Row mappers
function mapUser(row: any): User {
  return {
    id: row.id,
    githubId: row.github_id,
    githubUsername: row.github_username,
    email: row.email,
    avatarUrl: row.avatar_url,
    plan: row.plan || 'free',
    onboardingCompletedAt: row.onboarding_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspaceMember(row: any): WorkspaceMember {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    invitedBy: row.invited_by,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
    user: row.github_username ? {
      githubUsername: row.github_username,
      email: row.email,
      avatarUrl: row.avatar_url,
    } : undefined,
  };
}

function mapCredential(row: any): Credential {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    scopes: row.scopes,
    providerAccountId: row.provider_account_id,
    providerAccountEmail: row.provider_account_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspace(row: any): Workspace {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    status: row.status,
    computeProvider: row.compute_provider,
    computeId: row.compute_id,
    publicUrl: row.public_url,
    customDomain: row.custom_domain,
    customDomainStatus: row.custom_domain_status,
    config: row.config,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRepository(row: any): Repository {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    githubFullName: row.github_full_name,
    githubId: row.github_id,
    defaultBranch: row.default_branch,
    isPrivate: row.is_private,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Database initialization
export async function initializeDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        github_id VARCHAR(255) UNIQUE NOT NULL,
        github_username VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        avatar_url VARCHAR(512),
        plan VARCHAR(50) NOT NULL DEFAULT 'free',
        onboarding_completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_expires_at TIMESTAMP,
        scopes TEXT[],
        provider_account_id VARCHAR(255),
        provider_account_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, provider)
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'provisioning',
        compute_provider VARCHAR(50) NOT NULL,
        compute_id VARCHAR(255),
        public_url VARCHAR(255),
        custom_domain VARCHAR(255),
        custom_domain_status VARCHAR(50),
        config JSONB NOT NULL DEFAULT '{}',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        github_full_name VARCHAR(255) NOT NULL,
        github_id BIGINT NOT NULL,
        default_branch VARCHAR(255) NOT NULL DEFAULT 'main',
        is_private BOOLEAN NOT NULL DEFAULT false,
        sync_status VARCHAR(50) NOT NULL DEFAULT 'pending',
        last_synced_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, github_full_name)
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL DEFAULT 'member',
        invited_by UUID REFERENCES users(id),
        invited_at TIMESTAMP DEFAULT NOW(),
        accepted_at TIMESTAMP,
        UNIQUE(workspace_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_custom_domain ON workspaces(custom_domain) WHERE custom_domain IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_repositories_user_id ON repositories(user_id);
      CREATE INDEX IF NOT EXISTS idx_repositories_workspace_id ON repositories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);
    `);
  } finally {
    client.release();
  }
}

// Export db object for convenience
export const db = {
  users,
  credentials,
  workspaces,
  workspaceMembers,
  repositories,
  initialize: initializeDatabase,
  getPool,
};
