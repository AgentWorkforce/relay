/**
 * Agent Relay Cloud - Drizzle Database Client
 *
 * Type-safe database access using Drizzle ORM.
 * Use this instead of the raw pg client for new code.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, and, or, sql, desc, lt, isNull, isNotNull, inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import { getConfig } from '../config.js';
import { DEFAULT_POOL_CONFIG } from './bulk-ingest.js';

// Types
export type {
  User,
  NewUser,
  UserEmail,
  NewUserEmail,
  GitHubInstallation,
  NewGitHubInstallation,
  Credential,
  NewCredential,
  Workspace,
  NewWorkspace,
  WorkspaceConfig,
  WorkspaceMember,
  NewWorkspaceMember,
  ProjectGroup,
  NewProjectGroup,
  CoordinatorAgentConfig,
  ProjectAgentConfig,
  Repository,
  NewRepository,
  LinkedDaemon,
  NewLinkedDaemon,
  Subscription,
  NewSubscription,
  UsageRecord,
  NewUsageRecord,
  AgentSession,
  NewAgentSession,
  AgentSummary,
  NewAgentSummary,
} from './schema.js';

// Re-export schema for direct table access
export * from './schema.js';

// Initialize pool and drizzle lazily
let pool: Pool | null = null;
let drizzleDb: ReturnType<typeof drizzle> | null = null;

/**
 * Get or create the connection pool with optimized settings.
 * Pool configuration:
 * - max: 20 connections (up from default 10)
 * - idleTimeoutMillis: 30s (close idle connections)
 * - connectionTimeoutMillis: 10s (fail fast on connection issues)
 */
function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.databaseUrl,
      ...DEFAULT_POOL_CONFIG,
      // Allow SSL for cloud databases
      ssl: config.databaseUrl?.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
    });

    // Log pool errors (connection issues, etc.)
    pool.on('error', (err) => {
      console.error('[db] Pool error:', err.message);
    });
  }
  return pool;
}

/**
 * Get the raw connection pool for bulk operations.
 * Use this for optimized bulk inserts that bypass the ORM.
 */
export function getRawPool(): Pool {
  return getPool();
}

export function getDb() {
  if (!drizzleDb) {
    drizzleDb = drizzle(getPool(), { schema });
  }
  return drizzleDb;
}

// ============================================================================
// User Queries
// ============================================================================

export interface UserQueries {
  findById(id: string): Promise<schema.User | null>;
  findByGithubId(githubId: string): Promise<schema.User | null>;
  findByGithubUsername(username: string): Promise<schema.User | null>;
  findByEmail(email: string): Promise<schema.User | null>;
  findByNangoConnectionId(connectionId: string): Promise<schema.User | null>;
  findByIncomingConnectionId(connectionId: string): Promise<schema.User | null>;
  findByPlan(plan: string): Promise<schema.User[]>;
  upsert(data: schema.NewUser): Promise<schema.User>;
  update(id: string, data: Partial<Omit<schema.User, 'id' | 'createdAt'>>): Promise<void>;
  completeOnboarding(userId: string): Promise<void>;
  clearIncomingConnectionId(userId: string): Promise<void>;
  setPendingInstallationRequest(userId: string): Promise<void>;
  clearPendingInstallationRequest(userId: string): Promise<void>;
  // Email authentication methods
  createEmailUser(data: { email: string; passwordHash: string; displayName?: string }): Promise<schema.User>;
  verifyEmail(userId: string): Promise<void>;
  setEmailVerificationToken(userId: string, token: string, expires: Date): Promise<void>;
  findByEmailVerificationToken(token: string): Promise<schema.User | null>;
  updatePassword(userId: string, passwordHash: string): Promise<void>;
}

export const userQueries: UserQueries = {
  async findById(id: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db.select().from(schema.users).where(eq(schema.users.id, id));
    return result[0] ?? null;
  },

  async findByGithubId(githubId: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db.select().from(schema.users).where(eq(schema.users.githubId, githubId));
    return result[0] ?? null;
  },

  async findByGithubUsername(username: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db.select().from(schema.users).where(eq(schema.users.githubUsername, username));
    return result[0] ?? null;
  },

  async findByEmail(email: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db.select().from(schema.users).where(eq(schema.users.email, email));
    return result[0] ?? null;
  },

  async findByNangoConnectionId(connectionId: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.nangoConnectionId, connectionId));
    return result[0] ?? null;
  },

  async findByIncomingConnectionId(connectionId: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db.select().from(schema.users).where(eq(schema.users.incomingConnectionId, connectionId));
    return result[0] ?? null;
  },

  async findByPlan(plan: string): Promise<schema.User[]> {
    const db = getDb();
    const result = await db.select().from(schema.users).where(eq(schema.users.plan, plan));
    return result;
  },

  async upsert(data: schema.NewUser): Promise<schema.User> {
    const db = getDb();
    const result = await db
      .insert(schema.users)
      .values(data)
      .onConflictDoUpdate({
        target: schema.users.githubId,
        set: {
          githubUsername: data.githubUsername,
          email: data.email,
          avatarUrl: data.avatarUrl,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async completeOnboarding(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  },

  async update(id: string, data: Partial<Omit<schema.User, 'id' | 'createdAt'>>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.users.id, id));
  },

  async clearIncomingConnectionId(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ incomingConnectionId: null, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  },

  async setPendingInstallationRequest(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ pendingInstallationRequest: new Date(), updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  },

  async clearPendingInstallationRequest(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ pendingInstallationRequest: null, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  },

  async createEmailUser(data: { email: string; passwordHash: string; displayName?: string }): Promise<schema.User> {
    const db = getDb();
    const result = await db
      .insert(schema.users)
      .values({
        email: data.email,
        passwordHash: data.passwordHash,
        displayName: data.displayName || null,
        emailVerified: false,
      })
      .returning();
    return result[0];
  },

  async verifyEmail(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId));
  },

  async setEmailVerificationToken(userId: string, token: string, expires: Date): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({
        emailVerificationToken: token,
        emailVerificationExpires: expires,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId));
  },

  async findByEmailVerificationToken(token: string): Promise<schema.User | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.emailVerificationToken, token));
    return result[0] ?? null;
  },

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  },
};

// ============================================================================
// User Email Queries (GitHub-linked emails for account reconciliation)
// ============================================================================

export interface UserEmailQueries {
  /** Find all emails for a user */
  findByUserId(userId: string): Promise<schema.UserEmail[]>;
  /** Find a user by any of their linked emails (for login reconciliation) */
  findUserByEmail(email: string): Promise<schema.User | null>;
  /** Add or update an email for a user */
  upsert(data: { userId: string; email: string; verified: boolean; primary: boolean; source?: string }): Promise<schema.UserEmail>;
  /** Sync all emails from GitHub for a user (replaces GitHub-sourced emails) */
  syncFromGitHub(userId: string, emails: Array<{ email: string; verified: boolean; primary: boolean }>): Promise<void>;
  /** Delete a specific email for a user */
  delete(userId: string, email: string): Promise<void>;
  /** Check if an email is already linked to another user */
  isEmailLinkedToOtherUser(email: string, excludeUserId: string): Promise<boolean>;
}

export const userEmailQueries: UserEmailQueries = {
  async findByUserId(userId: string): Promise<schema.UserEmail[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.userEmails)
      .where(eq(schema.userEmails.userId, userId));
  },

  async findUserByEmail(email: string): Promise<schema.User | null> {
    const db = getDb();
    // First check user_emails table for linked emails
    const linkedEmail = await db
      .select({ userId: schema.userEmails.userId })
      .from(schema.userEmails)
      .where(eq(schema.userEmails.email, email.toLowerCase()))
      .limit(1);

    if (linkedEmail[0]) {
      const user = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, linkedEmail[0].userId));
      return user[0] ?? null;
    }

    // Fall back to checking users.email directly
    const user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email.toLowerCase()));
    return user[0] ?? null;
  },

  async upsert(data: { userId: string; email: string; verified: boolean; primary: boolean; source?: string }): Promise<schema.UserEmail> {
    const db = getDb();
    const result = await db
      .insert(schema.userEmails)
      .values({
        userId: data.userId,
        email: data.email.toLowerCase(),
        verified: data.verified,
        primary: data.primary,
        source: data.source ?? 'github',
      })
      .onConflictDoUpdate({
        target: [schema.userEmails.userId, schema.userEmails.email],
        set: {
          verified: data.verified,
          primary: data.primary,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async syncFromGitHub(userId: string, emails: Array<{ email: string; verified: boolean; primary: boolean }>): Promise<void> {
    const db = getDb();

    // Delete existing GitHub-sourced emails for this user
    await db
      .delete(schema.userEmails)
      .where(and(
        eq(schema.userEmails.userId, userId),
        eq(schema.userEmails.source, 'github')
      ));

    // Insert all new emails
    if (emails.length > 0) {
      await db.insert(schema.userEmails).values(
        emails.map(e => ({
          userId,
          email: e.email.toLowerCase(),
          verified: e.verified,
          primary: e.primary,
          source: 'github' as const,
        }))
      );
    }
  },

  async delete(userId: string, email: string): Promise<void> {
    const db = getDb();
    await db
      .delete(schema.userEmails)
      .where(and(
        eq(schema.userEmails.userId, userId),
        eq(schema.userEmails.email, email.toLowerCase())
      ));
  },

  async isEmailLinkedToOtherUser(email: string, excludeUserId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select({ userId: schema.userEmails.userId })
      .from(schema.userEmails)
      .where(and(
        eq(schema.userEmails.email, email.toLowerCase()),
        sql`${schema.userEmails.userId} != ${excludeUserId}`
      ))
      .limit(1);
    return result.length > 0;
  },
};

// ============================================================================
// GitHub Installation Queries
// ============================================================================

export interface GitHubInstallationQueries {
  findById(id: string): Promise<schema.GitHubInstallation | null>;
  findByInstallationId(installationId: string): Promise<schema.GitHubInstallation | null>;
  findByAccountLogin(accountLogin: string): Promise<schema.GitHubInstallation | null>;
  findByInstalledBy(userId: string): Promise<schema.GitHubInstallation[]>;
  findAll(): Promise<schema.GitHubInstallation[]>;
  upsert(data: schema.NewGitHubInstallation): Promise<schema.GitHubInstallation>;
  updatePermissions(installationId: string, permissions: Record<string, string>, events: string[]): Promise<void>;
  suspend(installationId: string, suspendedBy: string): Promise<void>;
  unsuspend(installationId: string): Promise<void>;
  delete(installationId: string): Promise<void>;
}

export const githubInstallationQueries: GitHubInstallationQueries = {
  async findById(id: string): Promise<schema.GitHubInstallation | null> {
    const db = getDb();
    const result = await db.select().from(schema.githubInstallations).where(eq(schema.githubInstallations.id, id));
    return result[0] ?? null;
  },

  async findByInstallationId(installationId: string): Promise<schema.GitHubInstallation | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, installationId));
    return result[0] ?? null;
  },

  async findByAccountLogin(accountLogin: string): Promise<schema.GitHubInstallation | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.accountLogin, accountLogin));
    return result[0] ?? null;
  },

  async findByInstalledBy(userId: string): Promise<schema.GitHubInstallation[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installedById, userId));
  },

  async findAll(): Promise<schema.GitHubInstallation[]> {
    const db = getDb();
    return db.select().from(schema.githubInstallations).orderBy(schema.githubInstallations.accountLogin);
  },

  async upsert(data: schema.NewGitHubInstallation): Promise<schema.GitHubInstallation> {
    const db = getDb();
    const result = await db
      .insert(schema.githubInstallations)
      .values(data)
      .onConflictDoUpdate({
        target: schema.githubInstallations.installationId,
        set: {
          accountType: data.accountType,
          accountLogin: data.accountLogin,
          accountId: data.accountId,
          permissions: data.permissions,
          events: data.events,
          installedById: data.installedById,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async updatePermissions(installationId: string, permissions: Record<string, string>, events: string[]): Promise<void> {
    const db = getDb();
    await db
      .update(schema.githubInstallations)
      .set({ permissions, events, updatedAt: new Date() })
      .where(eq(schema.githubInstallations.installationId, installationId));
  },

  async suspend(installationId: string, suspendedBy: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.githubInstallations)
      .set({ suspended: true, suspendedAt: new Date(), suspendedBy, updatedAt: new Date() })
      .where(eq(schema.githubInstallations.installationId, installationId));
  },

  async unsuspend(installationId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.githubInstallations)
      .set({ suspended: false, suspendedAt: null, suspendedBy: null, updatedAt: new Date() })
      .where(eq(schema.githubInstallations.installationId, installationId));
  },

  async delete(installationId: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.githubInstallations).where(eq(schema.githubInstallations.installationId, installationId));
  },
};

// ============================================================================
// Credential Queries (connected provider registry - no token storage)
// Credentials are workspace-scoped: tokens are stored on workspace daemons
// ============================================================================

export interface CredentialQueries {
  /** Get all credentials for a user (across all workspaces) */
  findByUserId(userId: string): Promise<schema.Credential[]>;
  /** Get all credentials for a user in a specific workspace */
  findByUserAndWorkspace(userId: string, workspaceId: string): Promise<schema.Credential[]>;
  /** Get a specific provider credential for a user in a workspace */
  findByUserWorkspaceAndProvider(userId: string, workspaceId: string, provider: string): Promise<schema.Credential | null>;
  /** @deprecated Use findByUserWorkspaceAndProvider for workspace-scoped queries */
  findByUserAndProvider(userId: string, provider: string): Promise<schema.Credential | null>;
  /** Upsert credential (unique on userId + provider + workspaceId) */
  upsert(data: schema.NewCredential): Promise<schema.Credential>;
  /** Delete credential for a specific workspace */
  deleteForWorkspace(userId: string, workspaceId: string, provider: string): Promise<void>;
  /** @deprecated Use deleteForWorkspace for workspace-scoped deletions */
  delete(userId: string, provider: string): Promise<void>;
}

export const credentialQueries: CredentialQueries = {
  async findByUserId(userId: string): Promise<schema.Credential[]> {
    const db = getDb();
    return db.select().from(schema.credentials).where(eq(schema.credentials.userId, userId));
  },

  async findByUserAndWorkspace(userId: string, workspaceId: string): Promise<schema.Credential[]> {
    const db = getDb();
    // Return credentials for this workspace OR legacy credentials (NULL workspace_id)
    // This ensures backward compatibility with existing credentials
    return db
      .select()
      .from(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, userId),
        or(
          eq(schema.credentials.workspaceId, workspaceId),
          isNull(schema.credentials.workspaceId)
        )
      ));
  },

  async findByUserWorkspaceAndProvider(userId: string, workspaceId: string, provider: string): Promise<schema.Credential | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.workspaceId, workspaceId),
        eq(schema.credentials.provider, provider)
      ));
    return result[0] ?? null;
  },

  async findByUserAndProvider(userId: string, provider: string): Promise<schema.Credential | null> {
    // Legacy: returns first match (any workspace) - use findByUserWorkspaceAndProvider instead
    const db = getDb();
    const result = await db
      .select()
      .from(schema.credentials)
      .where(and(eq(schema.credentials.userId, userId), eq(schema.credentials.provider, provider)));
    return result[0] ?? null;
  },

  async upsert(data: schema.NewCredential): Promise<schema.Credential> {
    const db = getDb();
    const result = await db
      .insert(schema.credentials)
      .values(data)
      .onConflictDoUpdate({
        target: [schema.credentials.userId, schema.credentials.provider, schema.credentials.workspaceId],
        set: {
          scopes: data.scopes,
          providerAccountId: data.providerAccountId,
          providerAccountEmail: data.providerAccountEmail,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async deleteForWorkspace(userId: string, workspaceId: string, provider: string): Promise<void> {
    const db = getDb();
    await db
      .delete(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.workspaceId, workspaceId),
        eq(schema.credentials.provider, provider)
      ));
  },

  async delete(userId: string, provider: string): Promise<void> {
    // Legacy: deletes all workspace credentials for this provider
    const db = getDb();
    await db
      .delete(schema.credentials)
      .where(and(eq(schema.credentials.userId, userId), eq(schema.credentials.provider, provider)));
  },
};

// ============================================================================
// Workspace Queries
// ============================================================================

export interface WorkspaceQueries {
  findById(id: string): Promise<schema.Workspace | null>;
  findByUserId(userId: string): Promise<schema.Workspace[]>;
  findByCustomDomain(domain: string): Promise<schema.Workspace | null>;
  findByRepoFullName(repoFullName: string): Promise<schema.Workspace | null>;
  findAll(): Promise<schema.Workspace[]>;
  create(data: schema.NewWorkspace): Promise<schema.Workspace>;
  update(id: string, data: Partial<Pick<schema.Workspace, 'name' | 'config'>>): Promise<void>;
  updateStatus(
    id: string,
    status: string,
    options?: {
      computeId?: string;
      publicUrl?: string;
      errorMessage?: string;
    }
  ): Promise<void>;
  updateConfig(id: string, config: schema.WorkspaceConfig): Promise<void>;
  setCustomDomain(id: string, customDomain: string, status?: string): Promise<void>;
  updateCustomDomainStatus(id: string, status: string): Promise<void>;
  removeCustomDomain(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export const workspaceQueries: WorkspaceQueries = {
  async findById(id: string): Promise<schema.Workspace | null> {
    const db = getDb();
    const result = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    return result[0] ?? null;
  },

  async findByUserId(userId: string): Promise<schema.Workspace[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.userId, userId))
      .orderBy(desc(schema.workspaces.createdAt));
  },

  async findByCustomDomain(domain: string): Promise<schema.Workspace | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.customDomain, domain));
    return result[0] ?? null;
  },

  async findByRepoFullName(repoFullName: string): Promise<schema.Workspace | null> {
    const db = getDb();
    // Find repository by full name (case-insensitive), then get its workspace
    const result = await db
      .select({ workspace: schema.workspaces })
      .from(schema.repositories)
      .innerJoin(schema.workspaces, eq(schema.repositories.workspaceId, schema.workspaces.id))
      .where(sql`LOWER(${schema.repositories.githubFullName}) = LOWER(${repoFullName})`)
      .limit(1);
    return result[0]?.workspace ?? null;
  },

  async findAll(): Promise<schema.Workspace[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.workspaces)
      .orderBy(desc(schema.workspaces.createdAt));
  },

  async create(data: schema.NewWorkspace): Promise<schema.Workspace> {
    const db = getDb();
    const result = await db.insert(schema.workspaces).values(data).returning();
    return result[0];
  },

  async update(id: string, data: Partial<Pick<schema.Workspace, 'name' | 'config'>>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaces)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.workspaces.id, id));
  },

  async updateStatus(
    id: string,
    status: string,
    options?: {
      computeId?: string;
      publicUrl?: string;
      errorMessage?: string;
    }
  ): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaces)
      .set({
        status,
        computeId: options?.computeId,
        publicUrl: options?.publicUrl,
        errorMessage: options?.errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(schema.workspaces.id, id));
  },

  async updateConfig(id: string, config: schema.WorkspaceConfig): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaces)
      .set({
        config,
        updatedAt: new Date(),
      })
      .where(eq(schema.workspaces.id, id));
  },

  async setCustomDomain(id: string, customDomain: string, status = 'pending'): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaces)
      .set({ customDomain, customDomainStatus: status, updatedAt: new Date() })
      .where(eq(schema.workspaces.id, id));
  },

  async updateCustomDomainStatus(id: string, status: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaces)
      .set({ customDomainStatus: status, updatedAt: new Date() })
      .where(eq(schema.workspaces.id, id));
  },

  async removeCustomDomain(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaces)
      .set({ customDomain: null, customDomainStatus: null, updatedAt: new Date() })
      .where(eq(schema.workspaces.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
  },
};

// ============================================================================
// Workspace Member Queries
// ============================================================================

export interface WorkspaceMemberQueries {
  findByWorkspaceId(workspaceId: string): Promise<schema.WorkspaceMember[]>;
  findByUserId(userId: string): Promise<schema.WorkspaceMember[]>;
  findMembership(workspaceId: string, userId: string): Promise<schema.WorkspaceMember | null>;
  addMember(data: { workspaceId: string; userId: string; role: string; invitedBy: string }): Promise<schema.WorkspaceMember>;
  acceptInvite(workspaceId: string, userId: string): Promise<void>;
  updateRole(workspaceId: string, userId: string, role: string): Promise<void>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  getPendingInvites(userId: string): Promise<schema.WorkspaceMember[]>;
  isOwner(workspaceId: string, userId: string): Promise<boolean>;
  canEdit(workspaceId: string, userId: string): Promise<boolean>;
  canView(workspaceId: string, userId: string): Promise<boolean>;
}

export const workspaceMemberQueries: WorkspaceMemberQueries = {
  async findByWorkspaceId(workspaceId: string): Promise<schema.WorkspaceMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  },

  async findByUserId(userId: string): Promise<schema.WorkspaceMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, userId), isNotNull(schema.workspaceMembers.acceptedAt)));
  },

  async findMembership(workspaceId: string, userId: string): Promise<schema.WorkspaceMember | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
    return result[0] ?? null;
  },

  async addMember(data: { workspaceId: string; userId: string; role: string; invitedBy: string }): Promise<schema.WorkspaceMember> {
    const db = getDb();
    const result = await db
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: data.workspaceId,
        userId: data.userId,
        role: data.role,
        invitedBy: data.invitedBy,
      })
      .returning();
    return result[0];
  },

  async acceptInvite(workspaceId: string, userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaceMembers)
      .set({ acceptedAt: new Date() })
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  },

  async updateRole(workspaceId: string, userId: string, role: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.workspaceMembers)
      .set({ role })
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  },

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const db = getDb();
    await db
      .delete(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  },

  async getPendingInvites(userId: string): Promise<schema.WorkspaceMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, userId), isNull(schema.workspaceMembers.acceptedAt)));
  },

  async isOwner(workspaceId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.role, 'owner')
        )
      );
    return result.length > 0;
  },

  async canEdit(workspaceId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
          isNotNull(schema.workspaceMembers.acceptedAt)
        )
      );
    const member = result[0];
    return !!member && ['owner', 'admin', 'member'].includes(member.role);
  },

  async canView(workspaceId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, userId),
          isNotNull(schema.workspaceMembers.acceptedAt)
        )
      );
    return result.length > 0;
  },
};

// ============================================================================
// Linked Daemon Queries
// ============================================================================

export interface DaemonAgentInfo {
  daemonId: string;
  daemonName: string;
  machineId: string;
  agents: Array<{ name: string; status: string }>;
}

export interface DaemonUpdate {
  type: string;
  payload: unknown;
}

export interface LinkedDaemonQueries {
  findById(id: string): Promise<schema.LinkedDaemon | null>;
  findByUserId(userId: string): Promise<schema.LinkedDaemon[]>;
  findByWorkspaceId(workspaceId: string): Promise<schema.LinkedDaemon[]>;
  findByMachineId(userId: string, machineId: string): Promise<schema.LinkedDaemon | null>;
  findByApiKeyHash(apiKeyHash: string): Promise<schema.LinkedDaemon | null>;
  create(data: schema.NewLinkedDaemon): Promise<schema.LinkedDaemon>;
  update(id: string, data: Partial<schema.LinkedDaemon>): Promise<void>;
  updateLastSeen(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  markStale(): Promise<number>;
  getAllAgentsForUser(userId: string): Promise<DaemonAgentInfo[]>;
  getPendingUpdates(id: string): Promise<DaemonUpdate[]>;
  queueUpdate(id: string, update: DaemonUpdate): Promise<void>;
  queueMessage(id: string, message: Record<string, unknown>): Promise<void>;
  getQueuedMessages(id: string): Promise<Array<Record<string, unknown>>>;
  clearMessageQueue(id: string): Promise<void>;
}

export const linkedDaemonQueries: LinkedDaemonQueries = {
  async findById(id: string): Promise<schema.LinkedDaemon | null> {
    const db = getDb();
    const result = await db.select().from(schema.linkedDaemons).where(eq(schema.linkedDaemons.id, id));
    return result[0] ?? null;
  },

  async findByUserId(userId: string): Promise<schema.LinkedDaemon[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.linkedDaemons)
      .where(eq(schema.linkedDaemons.userId, userId))
      .orderBy(desc(schema.linkedDaemons.lastSeenAt));
  },

  async findByWorkspaceId(workspaceId: string): Promise<schema.LinkedDaemon[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.linkedDaemons)
      .where(eq(schema.linkedDaemons.workspaceId, workspaceId))
      .orderBy(desc(schema.linkedDaemons.lastSeenAt));
  },

  async findByMachineId(userId: string, machineId: string): Promise<schema.LinkedDaemon | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.linkedDaemons)
      .where(
        and(eq(schema.linkedDaemons.userId, userId), eq(schema.linkedDaemons.machineId, machineId))
      );
    return result[0] ?? null;
  },

  async findByApiKeyHash(apiKeyHash: string): Promise<schema.LinkedDaemon | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.linkedDaemons)
      .where(eq(schema.linkedDaemons.apiKeyHash, apiKeyHash));
    return result[0] ?? null;
  },

  async create(data: schema.NewLinkedDaemon): Promise<schema.LinkedDaemon> {
    const db = getDb();
    const result = await db
      .insert(schema.linkedDaemons)
      .values({ ...data, lastSeenAt: new Date() })
      .returning();
    return result[0];
  },

  async update(id: string, data: Partial<schema.LinkedDaemon>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.linkedDaemons)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.linkedDaemons.id, id));
  },

  async updateLastSeen(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.linkedDaemons)
      .set({ lastSeenAt: new Date(), status: 'online', updatedAt: new Date() })
      .where(eq(schema.linkedDaemons.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.linkedDaemons).where(eq(schema.linkedDaemons.id, id));
  },

  async markStale(): Promise<number> {
    const db = getDb();
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const result = await db
      .update(schema.linkedDaemons)
      .set({ status: 'offline' })
      .where(
        and(
          eq(schema.linkedDaemons.status, 'online'),
          lt(schema.linkedDaemons.lastSeenAt, twoMinutesAgo)
        )
      );
    return result.rowCount ?? 0;
  },

  async getAllAgentsForUser(userId: string): Promise<DaemonAgentInfo[]> {
    const db = getDb();
    const daemons = await db
      .select()
      .from(schema.linkedDaemons)
      .where(eq(schema.linkedDaemons.userId, userId));

    return daemons.map((d) => ({
      daemonId: d.id,
      daemonName: d.name,
      machineId: d.machineId,
      agents: ((d.metadata as Record<string, unknown>)?.agents as Array<{ name: string; status: string }>) || [],
    }));
  },

  async getPendingUpdates(id: string): Promise<DaemonUpdate[]> {
    const db = getDb();
    const result = await db.select().from(schema.linkedDaemons).where(eq(schema.linkedDaemons.id, id));
    const daemon = result[0];
    if (!daemon) return [];
    const updates = (daemon.pendingUpdates as DaemonUpdate[]) || [];
    // Clear after reading
    if (updates.length > 0) {
      await db
        .update(schema.linkedDaemons)
        .set({ pendingUpdates: [] })
        .where(eq(schema.linkedDaemons.id, id));
    }
    return updates;
  },

  async queueUpdate(id: string, update: DaemonUpdate): Promise<void> {
    const db = getDb();
    const result = await db.select().from(schema.linkedDaemons).where(eq(schema.linkedDaemons.id, id));
    const daemon = result[0];
    if (!daemon) return;
    const existing = (daemon.pendingUpdates as DaemonUpdate[]) || [];
    await db
      .update(schema.linkedDaemons)
      .set({ pendingUpdates: [...existing, update], updatedAt: new Date() })
      .where(eq(schema.linkedDaemons.id, id));
  },

  async queueMessage(id: string, message: Record<string, unknown>): Promise<void> {
    const db = getDb();
    const result = await db.select().from(schema.linkedDaemons).where(eq(schema.linkedDaemons.id, id));
    const daemon = result[0];
    if (!daemon) return;
    const existing = (daemon.messageQueue as Array<Record<string, unknown>>) || [];
    await db
      .update(schema.linkedDaemons)
      .set({ messageQueue: [...existing, message], updatedAt: new Date() })
      .where(eq(schema.linkedDaemons.id, id));
  },

  async getQueuedMessages(id: string): Promise<Array<Record<string, unknown>>> {
    const db = getDb();
    const result = await db.select().from(schema.linkedDaemons).where(eq(schema.linkedDaemons.id, id));
    const daemon = result[0];
    return (daemon?.messageQueue as Array<Record<string, unknown>>) || [];
  },

  async clearMessageQueue(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.linkedDaemons)
      .set({ messageQueue: [] })
      .where(eq(schema.linkedDaemons.id, id));
  },
};

// ============================================================================
// Project Group Queries
// ============================================================================

export interface ProjectGroupWithRepositories extends schema.ProjectGroup {
  repositories: schema.Repository[];
}

export interface AllGroupsResult {
  groups: ProjectGroupWithRepositories[];
  ungroupedRepositories: schema.Repository[];
}

export interface ProjectGroupQueries {
  findById(id: string): Promise<schema.ProjectGroup | null>;
  findByUserId(userId: string): Promise<schema.ProjectGroup[]>;
  findByName(userId: string, name: string): Promise<schema.ProjectGroup | null>;
  create(data: schema.NewProjectGroup): Promise<schema.ProjectGroup>;
  update(id: string, data: Partial<Omit<schema.ProjectGroup, 'id' | 'userId' | 'createdAt'>>): Promise<void>;
  delete(id: string): Promise<void>;
  findWithRepositories(id: string): Promise<ProjectGroupWithRepositories | null>;
  findAllWithRepositories(userId: string): Promise<AllGroupsResult>;
  updateCoordinatorAgent(id: string, config: schema.CoordinatorAgentConfig): Promise<void>;
  reorder(userId: string, orderedIds: string[]): Promise<void>;
}

export const projectGroupQueries: ProjectGroupQueries = {
  async findById(id: string): Promise<schema.ProjectGroup | null> {
    const db = getDb();
    const result = await db.select().from(schema.projectGroups).where(eq(schema.projectGroups.id, id));
    return result[0] ?? null;
  },

  async findByUserId(userId: string): Promise<schema.ProjectGroup[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.projectGroups)
      .where(eq(schema.projectGroups.userId, userId))
      .orderBy(schema.projectGroups.sortOrder, schema.projectGroups.name);
  },

  async findByName(userId: string, name: string): Promise<schema.ProjectGroup | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.projectGroups)
      .where(and(eq(schema.projectGroups.userId, userId), eq(schema.projectGroups.name, name)));
    return result[0] ?? null;
  },

  async create(data: schema.NewProjectGroup): Promise<schema.ProjectGroup> {
    const db = getDb();
    const result = await db.insert(schema.projectGroups).values(data).returning();
    return result[0];
  },

  async update(id: string, data: Partial<Omit<schema.ProjectGroup, 'id' | 'userId' | 'createdAt'>>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.projectGroups)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.projectGroups.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    // Repositories in this group will have projectGroupId set to null (ON DELETE SET NULL)
    await db.delete(schema.projectGroups).where(eq(schema.projectGroups.id, id));
  },

  async findWithRepositories(id: string): Promise<ProjectGroupWithRepositories | null> {
    const db = getDb();
    const group = await db.select().from(schema.projectGroups).where(eq(schema.projectGroups.id, id));
    if (!group[0]) return null;

    const repos = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.projectGroupId, id))
      .orderBy(schema.repositories.githubFullName);

    return { ...group[0], repositories: repos };
  },

  async findAllWithRepositories(userId: string): Promise<AllGroupsResult> {
    const db = getDb();
    const groups = await db
      .select()
      .from(schema.projectGroups)
      .where(eq(schema.projectGroups.userId, userId))
      .orderBy(schema.projectGroups.sortOrder, schema.projectGroups.name);

    // Get repositories for each group
    const result = await Promise.all(
      groups.map(async (group) => {
        const repos = await db
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.projectGroupId, group.id))
          .orderBy(schema.repositories.githubFullName);
        return { ...group, repositories: repos };
      })
    );

    // Also get ungrouped repositories
    const ungroupedRepos = await db
      .select()
      .from(schema.repositories)
      .where(and(eq(schema.repositories.userId, userId), isNull(schema.repositories.projectGroupId)))
      .orderBy(schema.repositories.githubFullName);

    return { groups: result, ungroupedRepositories: ungroupedRepos };
  },

  async updateCoordinatorAgent(id: string, config: schema.CoordinatorAgentConfig): Promise<void> {
    const db = getDb();
    await db
      .update(schema.projectGroups)
      .set({ coordinatorAgent: config, updatedAt: new Date() })
      .where(eq(schema.projectGroups.id, id));
  },

  async reorder(userId: string, orderedIds: string[]): Promise<void> {
    const db = getDb();
    // Update sort_order for each group
    await Promise.all(
      orderedIds.map((id, index) =>
        db
          .update(schema.projectGroups)
          .set({ sortOrder: index, updatedAt: new Date() })
          .where(and(eq(schema.projectGroups.id, id), eq(schema.projectGroups.userId, userId)))
      )
    );
  },
};

// ============================================================================
// Repository Queries
// ============================================================================

export interface RepositoryQueries {
  findById(id: string): Promise<schema.Repository | null>;
  findByFullName(fullName: string): Promise<schema.Repository | null>;
  findByGithubFullName(fullName: string): Promise<schema.Repository[]>;
  findByUserId(userId: string): Promise<schema.Repository[]>;
  findByWorkspaceId(workspaceId: string): Promise<schema.Repository[]>;
  findByProjectGroupId(projectGroupId: string): Promise<schema.Repository[]>;
  upsert(data: schema.NewRepository): Promise<schema.Repository>;
  assignToWorkspace(repoId: string, workspaceId: string | null): Promise<void>;
  assignToGroup(repoId: string, projectGroupId: string | null): Promise<void>;
  updateProjectAgent(id: string, config: schema.ProjectAgentConfig): Promise<void>;
  updateSyncStatus(id: string, status: string, lastSyncedAt?: Date): Promise<void>;
  delete(id: string): Promise<void>;
}

export const repositoryQueries: RepositoryQueries = {
  async findById(id: string): Promise<schema.Repository | null> {
    const db = getDb();
    const result = await db.select().from(schema.repositories).where(eq(schema.repositories.id, id));
    return result[0] ?? null;
  },

  async findByFullName(fullName: string): Promise<schema.Repository | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.githubFullName, fullName));
    return result[0] ?? null;
  },

  async findByGithubFullName(fullName: string): Promise<schema.Repository[]> {
    const db = getDb();
    // Use case-insensitive match since GitHub repo names are case-insensitive
    return db
      .select()
      .from(schema.repositories)
      .where(sql`LOWER(${schema.repositories.githubFullName}) = LOWER(${fullName})`);
  },

  async findByUserId(userId: string): Promise<schema.Repository[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.userId, userId))
      .orderBy(schema.repositories.githubFullName);
  },

  async findByWorkspaceId(workspaceId: string): Promise<schema.Repository[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.workspaceId, workspaceId));
  },

  async findByProjectGroupId(projectGroupId: string): Promise<schema.Repository[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.projectGroupId, projectGroupId))
      .orderBy(schema.repositories.githubFullName);
  },

  async upsert(data: schema.NewRepository): Promise<schema.Repository> {
    const db = getDb();
    const result = await db
      .insert(schema.repositories)
      .values(data)
      .onConflictDoUpdate({
        target: [schema.repositories.userId, schema.repositories.githubFullName],
        set: {
          githubId: data.githubId,
          defaultBranch: data.defaultBranch,
          isPrivate: data.isPrivate,
          syncStatus: data.syncStatus,
          nangoConnectionId: data.nangoConnectionId,
          installationId: data.installationId,
          lastSyncedAt: data.lastSyncedAt,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  async assignToWorkspace(repoId: string, workspaceId: string | null): Promise<void> {
    const db = getDb();
    await db
      .update(schema.repositories)
      .set({ workspaceId, updatedAt: new Date() })
      .where(eq(schema.repositories.id, repoId));
  },

  async assignToGroup(repoId: string, projectGroupId: string | null): Promise<void> {
    const db = getDb();
    await db
      .update(schema.repositories)
      .set({ projectGroupId, updatedAt: new Date() })
      .where(eq(schema.repositories.id, repoId));
  },

  async updateProjectAgent(id: string, config: schema.ProjectAgentConfig): Promise<void> {
    const db = getDb();
    await db
      .update(schema.repositories)
      .set({ projectAgent: config, updatedAt: new Date() })
      .where(eq(schema.repositories.id, id));
  },

  async updateSyncStatus(id: string, status: string, lastSyncedAt?: Date): Promise<void> {
    const db = getDb();
    const updates: Record<string, unknown> = { syncStatus: status, updatedAt: new Date() };
    if (lastSyncedAt) {
      updates.lastSyncedAt = lastSyncedAt;
    }
    await db
      .update(schema.repositories)
      .set(updates)
      .where(eq(schema.repositories.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.repositories).where(eq(schema.repositories.id, id));
  },
};

// ============================================================================
// Agent Session Queries (cloud persistence for PtyWrapper)
// ============================================================================

export interface AgentSessionQueries {
  findById(id: string): Promise<schema.AgentSession | null>;
  findByWorkspaceId(workspaceId: string): Promise<schema.AgentSession[]>;
  findActiveByWorkspace(workspaceId: string): Promise<schema.AgentSession[]>;
  create(data: schema.NewAgentSession): Promise<schema.AgentSession>;
  endSession(id: string, endMarker?: { summary?: string; completedTasks?: string[] }): Promise<void>;
  delete(id: string): Promise<void>;
}

export const agentSessionQueries: AgentSessionQueries = {
  async findById(id: string): Promise<schema.AgentSession | null> {
    const db = getDb();
    const result = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id));
    return result[0] ?? null;
  },

  async findByWorkspaceId(workspaceId: string): Promise<schema.AgentSession[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.workspaceId, workspaceId))
      .orderBy(desc(schema.agentSessions.startedAt));
  },

  async findActiveByWorkspace(workspaceId: string): Promise<schema.AgentSession[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.workspaceId, workspaceId),
        eq(schema.agentSessions.status, 'active')
      ));
  },

  async create(data: schema.NewAgentSession): Promise<schema.AgentSession> {
    const db = getDb();
    const result = await db.insert(schema.agentSessions).values(data).returning();
    return result[0];
  },

  async endSession(id: string, endMarker?: { summary?: string; completedTasks?: string[] }): Promise<void> {
    const db = getDb();
    await db
      .update(schema.agentSessions)
      .set({
        status: 'ended',
        endedAt: new Date(),
        endMarker: endMarker ?? null,
      })
      .where(eq(schema.agentSessions.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, id));
  },
};

// ============================================================================
// Agent Summary Queries (cloud persistence for [[SUMMARY]] blocks)
// ============================================================================

export interface AgentSummaryQueries {
  findBySessionId(sessionId: string): Promise<schema.AgentSummary[]>;
  findLatestByAgent(agentName: string): Promise<schema.AgentSummary | null>;
  create(data: schema.NewAgentSummary): Promise<schema.AgentSummary>;
  deleteBySession(sessionId: string): Promise<void>;
}

export const agentSummaryQueries: AgentSummaryQueries = {
  async findBySessionId(sessionId: string): Promise<schema.AgentSummary[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.agentSummaries)
      .where(eq(schema.agentSummaries.sessionId, sessionId))
      .orderBy(schema.agentSummaries.createdAt);
  },

  async findLatestByAgent(agentName: string): Promise<schema.AgentSummary | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.agentSummaries)
      .where(eq(schema.agentSummaries.agentName, agentName))
      .orderBy(desc(schema.agentSummaries.createdAt))
      .limit(1);
    return result[0] ?? null;
  },

  async create(data: schema.NewAgentSummary): Promise<schema.AgentSummary> {
    const db = getDb();
    const result = await db.insert(schema.agentSummaries).values(data).returning();
    return result[0];
  },

  async deleteBySession(sessionId: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.agentSummaries).where(eq(schema.agentSummaries.sessionId, sessionId));
  },
};

// ============================================================================
// CI Failure Event Queries
// ============================================================================

export interface CIFailureEventQueries {
  findById(id: string): Promise<schema.CIFailureEvent | null>;
  findByRepository(repository: string, limit?: number): Promise<schema.CIFailureEvent[]>;
  findByPR(repository: string, prNumber: number): Promise<schema.CIFailureEvent[]>;
  findRecentUnprocessed(limit?: number): Promise<schema.CIFailureEvent[]>;
  create(data: schema.NewCIFailureEvent): Promise<schema.CIFailureEvent>;
  markProcessed(id: string, agentSpawned: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

export const ciFailureEventQueries: CIFailureEventQueries = {
  async findById(id: string): Promise<schema.CIFailureEvent | null> {
    const db = getDb();
    const result = await db.select().from(schema.ciFailureEvents).where(eq(schema.ciFailureEvents.id, id));
    return result[0] ?? null;
  },

  async findByRepository(repository: string, limit = 50): Promise<schema.CIFailureEvent[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.ciFailureEvents)
      .where(eq(schema.ciFailureEvents.repository, repository))
      .orderBy(desc(schema.ciFailureEvents.createdAt))
      .limit(limit);
  },

  async findByPR(repository: string, prNumber: number): Promise<schema.CIFailureEvent[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.ciFailureEvents)
      .where(
        and(
          eq(schema.ciFailureEvents.repository, repository),
          eq(schema.ciFailureEvents.prNumber, prNumber)
        )
      )
      .orderBy(desc(schema.ciFailureEvents.createdAt));
  },

  async findRecentUnprocessed(limit = 100): Promise<schema.CIFailureEvent[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.ciFailureEvents)
      .where(isNull(schema.ciFailureEvents.processedAt))
      .orderBy(schema.ciFailureEvents.createdAt)
      .limit(limit);
  },

  async create(data: schema.NewCIFailureEvent): Promise<schema.CIFailureEvent> {
    const db = getDb();
    const result = await db.insert(schema.ciFailureEvents).values(data).returning();
    return result[0];
  },

  async markProcessed(id: string, agentSpawned: boolean): Promise<void> {
    const db = getDb();
    await db
      .update(schema.ciFailureEvents)
      .set({ processedAt: new Date(), agentSpawned })
      .where(eq(schema.ciFailureEvents.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.ciFailureEvents).where(eq(schema.ciFailureEvents.id, id));
  },
};

// ============================================================================
// CI Fix Attempt Queries
// ============================================================================

export interface CIFixAttemptQueries {
  findById(id: string): Promise<schema.CIFixAttempt | null>;
  findByFailureEvent(failureEventId: string): Promise<schema.CIFixAttempt[]>;
  findActiveByRepository(repository: string): Promise<schema.CIFixAttempt[]>;
  create(data: schema.NewCIFixAttempt): Promise<schema.CIFixAttempt>;
  updateStatus(id: string, status: string, errorMessage?: string): Promise<void>;
  complete(id: string, status: 'success' | 'failed', commitSha?: string, errorMessage?: string): Promise<void>;
}

export const ciFixAttemptQueries: CIFixAttemptQueries = {
  async findById(id: string): Promise<schema.CIFixAttempt | null> {
    const db = getDb();
    const result = await db.select().from(schema.ciFixAttempts).where(eq(schema.ciFixAttempts.id, id));
    return result[0] ?? null;
  },

  async findByFailureEvent(failureEventId: string): Promise<schema.CIFixAttempt[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.ciFixAttempts)
      .where(eq(schema.ciFixAttempts.failureEventId, failureEventId))
      .orderBy(desc(schema.ciFixAttempts.startedAt));
  },

  async findActiveByRepository(repository: string): Promise<schema.CIFixAttempt[]> {
    const db = getDb();
    // Find active fix attempts by joining with failure events
    return db
      .select({
        id: schema.ciFixAttempts.id,
        failureEventId: schema.ciFixAttempts.failureEventId,
        agentId: schema.ciFixAttempts.agentId,
        agentName: schema.ciFixAttempts.agentName,
        status: schema.ciFixAttempts.status,
        commitSha: schema.ciFixAttempts.commitSha,
        errorMessage: schema.ciFixAttempts.errorMessage,
        startedAt: schema.ciFixAttempts.startedAt,
        completedAt: schema.ciFixAttempts.completedAt,
      })
      .from(schema.ciFixAttempts)
      .innerJoin(schema.ciFailureEvents, eq(schema.ciFixAttempts.failureEventId, schema.ciFailureEvents.id))
      .where(
        and(
          eq(schema.ciFailureEvents.repository, repository),
          sql`${schema.ciFixAttempts.status} IN ('pending', 'in_progress')`
        )
      );
  },

  async create(data: schema.NewCIFixAttempt): Promise<schema.CIFixAttempt> {
    const db = getDb();
    const result = await db.insert(schema.ciFixAttempts).values(data).returning();
    return result[0];
  },

  async updateStatus(id: string, status: string, errorMessage?: string): Promise<void> {
    const db = getDb();
    const updates: Record<string, unknown> = { status };
    if (errorMessage) {
      updates.errorMessage = errorMessage;
    }
    await db
      .update(schema.ciFixAttempts)
      .set(updates)
      .where(eq(schema.ciFixAttempts.id, id));
  },

  async complete(
    id: string,
    status: 'success' | 'failed',
    commitSha?: string,
    errorMessage?: string
  ): Promise<void> {
    const db = getDb();
    await db
      .update(schema.ciFixAttempts)
      .set({
        status,
        completedAt: new Date(),
        commitSha: commitSha ?? null,
        errorMessage: errorMessage ?? null,
      })
      .where(eq(schema.ciFixAttempts.id, id));
  },
};

// ============================================================================
// Issue Assignment Queries
// ============================================================================

export interface IssueAssignmentQueries {
  findById(id: string): Promise<schema.IssueAssignment | null>;
  findByRepository(repository: string, limit?: number): Promise<schema.IssueAssignment[]>;
  findByIssue(repository: string, issueNumber: number): Promise<schema.IssueAssignment | null>;
  findByAgent(agentId: string): Promise<schema.IssueAssignment[]>;
  findPending(limit?: number): Promise<schema.IssueAssignment[]>;
  create(data: schema.NewIssueAssignment): Promise<schema.IssueAssignment>;
  assignAgent(id: string, agentId: string, agentName: string): Promise<void>;
  updateStatus(id: string, status: string, resolution?: string): Promise<void>;
  linkPR(id: string, prNumber: number): Promise<void>;
}

export const issueAssignmentQueries: IssueAssignmentQueries = {
  async findById(id: string): Promise<schema.IssueAssignment | null> {
    const db = getDb();
    const result = await db.select().from(schema.issueAssignments).where(eq(schema.issueAssignments.id, id));
    return result[0] ?? null;
  },

  async findByRepository(repository: string, limit = 50): Promise<schema.IssueAssignment[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.issueAssignments)
      .where(eq(schema.issueAssignments.repository, repository))
      .orderBy(desc(schema.issueAssignments.createdAt))
      .limit(limit);
  },

  async findByIssue(repository: string, issueNumber: number): Promise<schema.IssueAssignment | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.issueAssignments)
      .where(
        and(
          eq(schema.issueAssignments.repository, repository),
          eq(schema.issueAssignments.issueNumber, issueNumber)
        )
      );
    return result[0] ?? null;
  },

  async findByAgent(agentId: string): Promise<schema.IssueAssignment[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.issueAssignments)
      .where(eq(schema.issueAssignments.agentId, agentId))
      .orderBy(desc(schema.issueAssignments.createdAt));
  },

  async findPending(limit = 100): Promise<schema.IssueAssignment[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.issueAssignments)
      .where(eq(schema.issueAssignments.status, 'pending'))
      .orderBy(schema.issueAssignments.createdAt)
      .limit(limit);
  },

  async create(data: schema.NewIssueAssignment): Promise<schema.IssueAssignment> {
    const db = getDb();
    const result = await db.insert(schema.issueAssignments).values(data).returning();
    return result[0];
  },

  async assignAgent(id: string, agentId: string, agentName: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.issueAssignments)
      .set({
        agentId,
        agentName,
        assignedAt: new Date(),
        status: 'assigned',
        updatedAt: new Date(),
      })
      .where(eq(schema.issueAssignments.id, id));
  },

  async updateStatus(id: string, status: string, resolution?: string): Promise<void> {
    const db = getDb();
    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (resolution) {
      updates.resolution = resolution;
    }
    await db
      .update(schema.issueAssignments)
      .set(updates)
      .where(eq(schema.issueAssignments.id, id));
  },

  async linkPR(id: string, prNumber: number): Promise<void> {
    const db = getDb();
    await db
      .update(schema.issueAssignments)
      .set({ linkedPrNumber: prNumber, updatedAt: new Date() })
      .where(eq(schema.issueAssignments.id, id));
  },
};

// ============================================================================
// Comment Mention Queries
// ============================================================================

export interface CommentMentionQueries {
  findById(id: string): Promise<schema.CommentMention | null>;
  findByRepository(repository: string, limit?: number): Promise<schema.CommentMention[]>;
  findBySource(sourceType: string, sourceId: number): Promise<schema.CommentMention | null>;
  findPending(limit?: number): Promise<schema.CommentMention[]>;
  findByMentionedAgent(mentionedAgent: string, limit?: number): Promise<schema.CommentMention[]>;
  create(data: schema.NewCommentMention): Promise<schema.CommentMention>;
  markProcessing(id: string, agentId: string, agentName: string): Promise<void>;
  markResponded(id: string, responseCommentId: number, responseBody: string): Promise<void>;
  markIgnored(id: string): Promise<void>;
}

export const commentMentionQueries: CommentMentionQueries = {
  async findById(id: string): Promise<schema.CommentMention | null> {
    const db = getDb();
    const result = await db.select().from(schema.commentMentions).where(eq(schema.commentMentions.id, id));
    return result[0] ?? null;
  },

  async findByRepository(repository: string, limit = 50): Promise<schema.CommentMention[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.commentMentions)
      .where(eq(schema.commentMentions.repository, repository))
      .orderBy(desc(schema.commentMentions.createdAt))
      .limit(limit);
  },

  async findBySource(sourceType: string, sourceId: number): Promise<schema.CommentMention | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.commentMentions)
      .where(
        and(
          eq(schema.commentMentions.sourceType, sourceType),
          eq(schema.commentMentions.sourceId, sourceId)
        )
      );
    return result[0] ?? null;
  },

  async findPending(limit = 100): Promise<schema.CommentMention[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.commentMentions)
      .where(eq(schema.commentMentions.status, 'pending'))
      .orderBy(schema.commentMentions.createdAt)
      .limit(limit);
  },

  async findByMentionedAgent(mentionedAgent: string, limit = 50): Promise<schema.CommentMention[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.commentMentions)
      .where(eq(schema.commentMentions.mentionedAgent, mentionedAgent))
      .orderBy(desc(schema.commentMentions.createdAt))
      .limit(limit);
  },

  async create(data: schema.NewCommentMention): Promise<schema.CommentMention> {
    const db = getDb();
    const result = await db.insert(schema.commentMentions).values(data).returning();
    return result[0];
  },

  async markProcessing(id: string, agentId: string, agentName: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.commentMentions)
      .set({ status: 'processing', agentId, agentName })
      .where(eq(schema.commentMentions.id, id));
  },

  async markResponded(id: string, responseCommentId: number, responseBody: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.commentMentions)
      .set({
        status: 'responded',
        responseCommentId,
        responseBody,
        respondedAt: new Date(),
      })
      .where(eq(schema.commentMentions.id, id));
  },

  async markIgnored(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.commentMentions)
      .set({ status: 'ignored' })
      .where(eq(schema.commentMentions.id, id));
  },
};

// ============================================================================
// Channel queries
// ============================================================================

export interface ChannelQueries {
  findById(id: string): Promise<schema.Channel | null>;
  findByWorkspaceId(workspaceId: string): Promise<schema.Channel[]>;
  findByWorkspaceAndChannelId(workspaceId: string, channelId: string): Promise<schema.Channel | null>;
  create(channel: schema.NewChannel): Promise<schema.Channel>;
  update(id: string, updates: Partial<schema.NewChannel>): Promise<void>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export const channelQueries: ChannelQueries = {
  async findById(id: string): Promise<schema.Channel | null> {
    const db = getDb();
    const result = await db.select().from(schema.channels).where(eq(schema.channels.id, id));
    return result[0] ?? null;
  },

  async findByWorkspaceId(workspaceId: string): Promise<schema.Channel[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.workspaceId, workspaceId))
      .orderBy(desc(schema.channels.lastActivityAt));
  },

  async findByWorkspaceAndChannelId(workspaceId: string, channelId: string): Promise<schema.Channel | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channels)
      .where(and(
        eq(schema.channels.workspaceId, workspaceId),
        eq(schema.channels.channelId, channelId)
      ));
    return result[0] ?? null;
  },

  async create(channel: schema.NewChannel): Promise<schema.Channel> {
    const db = getDb();
    const result = await db.insert(schema.channels).values(channel).returning();
    return result[0];
  },

  async update(id: string, updates: Partial<schema.NewChannel>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async archive(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async unarchive(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.channels).where(eq(schema.channels.id, id));
  },
};

// ============================================================================
// Channel Member queries
// ============================================================================

export interface ChannelMemberQueries {
  findByChannelId(channelId: string): Promise<schema.ChannelMember[]>;
  findByMemberId(memberId: string): Promise<schema.ChannelMember[]>;
  findMembership(channelId: string, memberId: string): Promise<schema.ChannelMember | null>;
  addMember(member: schema.NewChannelMember): Promise<schema.ChannelMember>;
  removeMember(channelId: string, memberId: string): Promise<void>;
  updateRole(channelId: string, memberId: string, role: string): Promise<void>;
  countByChannelIds(channelIds: string[]): Promise<Map<string, number>>;
}

export const channelMemberQueries: ChannelMemberQueries = {
  async findByChannelId(channelId: string): Promise<schema.ChannelMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channelId));
  },

  async findByMemberId(memberId: string): Promise<schema.ChannelMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.memberId, memberId));
  },

  async findMembership(channelId: string, memberId: string): Promise<schema.ChannelMember | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channelMembers)
      .where(and(
        eq(schema.channelMembers.channelId, channelId),
        eq(schema.channelMembers.memberId, memberId)
      ));
    return result[0] ?? null;
  },

  async addMember(member: schema.NewChannelMember): Promise<schema.ChannelMember> {
    const db = getDb();
    const result = await db.insert(schema.channelMembers).values(member).returning();
    return result[0];
  },

  async removeMember(channelId: string, memberId: string): Promise<void> {
    const db = getDb();
    await db
      .delete(schema.channelMembers)
      .where(and(
        eq(schema.channelMembers.channelId, channelId),
        eq(schema.channelMembers.memberId, memberId)
      ));
  },

  async updateRole(channelId: string, memberId: string, role: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMembers)
      .set({ role })
      .where(and(
        eq(schema.channelMembers.channelId, channelId),
        eq(schema.channelMembers.memberId, memberId)
      ));
  },

  async countByChannelIds(channelIds: string[]): Promise<Map<string, number>> {
    if (channelIds.length === 0) {
      return new Map();
    }
    const db = getDb();
    const results = await db
      .select({
        channelId: schema.channelMembers.channelId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.channelMembers)
      .where(inArray(schema.channelMembers.channelId, channelIds))
      .groupBy(schema.channelMembers.channelId);

    const countMap = new Map<string, number>();
    for (const row of results) {
      countMap.set(row.channelId, row.count);
    }
    return countMap;
  },
};

// ============================================================================
// Migration helper
// ============================================================================

export async function runMigrations() {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  // Get migrations folder relative to this file (works in both dev and Docker)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // In dist: packages/cloud/dist/db/drizzle.js -> need to go to packages/cloud/src/db/migrations
  // The migrations are in src/db/migrations, not dist/db/migrations
  const migrationsFolder = join(__dirname, '..', '..', 'src', 'db', 'migrations');

  const db = getDb();
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete');
}

// ============================================================================
// Close connections
// ============================================================================

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    drizzleDb = null;
  }
}
