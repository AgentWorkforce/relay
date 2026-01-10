/**
 * Agent Relay Cloud - Drizzle Database Client
 *
 * Type-safe database access using Drizzle ORM.
 * Use this instead of the raw pg client for new code.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, and, sql, desc, lt, gt, isNull, isNotNull, count } from 'drizzle-orm';
import * as schema from './schema.js';
import { getConfig } from '../config.js';

// Types
export type {
  User,
  NewUser,
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

function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
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
// ============================================================================

export interface CredentialQueries {
  findByUserId(userId: string): Promise<schema.Credential[]>;
  findByUserAndProvider(userId: string, provider: string): Promise<schema.Credential | null>;
  upsert(data: schema.NewCredential): Promise<schema.Credential>;
  delete(userId: string, provider: string): Promise<void>;
}

export const credentialQueries: CredentialQueries = {
  async findByUserId(userId: string): Promise<schema.Credential[]> {
    const db = getDb();
    return db.select().from(schema.credentials).where(eq(schema.credentials.userId, userId));
  },

  async findByUserAndProvider(userId: string, provider: string): Promise<schema.Credential | null> {
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
        target: [schema.credentials.userId, schema.credentials.provider],
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

  async delete(userId: string, provider: string): Promise<void> {
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
// Channel Queries
// ============================================================================

export interface ChannelQueries {
  findById(id: string): Promise<schema.Channel | null>;
  findByWorkspaceId(workspaceId: string, options?: { includeArchived?: boolean }): Promise<schema.Channel[]>;
  findByName(workspaceId: string, name: string): Promise<schema.Channel | null>;
  create(data: schema.NewChannel): Promise<schema.Channel>;
  update(id: string, data: Partial<Pick<schema.Channel, 'name' | 'description' | 'topic' | 'isPrivate' | 'isArchived'>>): Promise<void>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  incrementMemberCount(id: string): Promise<void>;
  decrementMemberCount(id: string): Promise<void>;
  updateLastActivity(id: string): Promise<void>;
}

export const channelQueries: ChannelQueries = {
  async findById(id: string): Promise<schema.Channel | null> {
    const db = getDb();
    const result = await db.select().from(schema.channels).where(eq(schema.channels.id, id));
    return result[0] ?? null;
  },

  async findByWorkspaceId(workspaceId: string, options?: { includeArchived?: boolean }): Promise<schema.Channel[]> {
    const db = getDb();
    const conditions = [eq(schema.channels.workspaceId, workspaceId)];
    if (!options?.includeArchived) {
      conditions.push(eq(schema.channels.isArchived, false));
    }
    return db
      .select()
      .from(schema.channels)
      .where(and(...conditions))
      .orderBy(schema.channels.name);
  },

  async findByName(workspaceId: string, name: string): Promise<schema.Channel | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.workspaceId, workspaceId), eq(schema.channels.name, name)));
    return result[0] ?? null;
  },

  async create(data: schema.NewChannel): Promise<schema.Channel> {
    const db = getDb();
    const result = await db.insert(schema.channels).values(data).returning();
    return result[0];
  },

  async update(id: string, data: Partial<Pick<schema.Channel, 'name' | 'description' | 'topic' | 'isPrivate' | 'isArchived'>>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async archive(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async unarchive(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ isArchived: false, updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.channels).where(eq(schema.channels.id, id));
  },

  async incrementMemberCount(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ memberCount: sql`${schema.channels.memberCount} + 1`, updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async decrementMemberCount(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ memberCount: sql`GREATEST(${schema.channels.memberCount} - 1, 0)`, updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },

  async updateLastActivity(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channels)
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.channels.id, id));
  },
};

// ============================================================================
// Channel Member Queries
// ============================================================================

export interface ChannelMemberQueries {
  findById(id: string): Promise<schema.ChannelMember | null>;
  findByChannelId(channelId: string): Promise<schema.ChannelMember[]>;
  findByMemberId(memberId: string, memberType: schema.ChannelMemberType): Promise<schema.ChannelMember[]>;
  findMembership(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<schema.ChannelMember | null>;
  addMember(data: schema.NewChannelMember): Promise<schema.ChannelMember>;
  updateRole(channelId: string, memberId: string, memberType: schema.ChannelMemberType, role: schema.ChannelMemberRole): Promise<void>;
  removeMember(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<void>;
  isMember(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<boolean>;
  isAdmin(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<boolean>;
  canPost(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<boolean>;
  countMembers(channelId: string): Promise<number>;
}

export const channelMemberQueries: ChannelMemberQueries = {
  async findById(id: string): Promise<schema.ChannelMember | null> {
    const db = getDb();
    const result = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.id, id));
    return result[0] ?? null;
  },

  async findByChannelId(channelId: string): Promise<schema.ChannelMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channelId))
      .orderBy(schema.channelMembers.joinedAt);
  },

  async findByMemberId(memberId: string, memberType: schema.ChannelMemberType): Promise<schema.ChannelMember[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.entityId, memberId), eq(schema.channelMembers.entityType, memberType)));
  },

  async findMembership(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<schema.ChannelMember | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.entityId, memberId),
          eq(schema.channelMembers.entityType, memberType)
        )
      );
    return result[0] ?? null;
  },

  async addMember(data: schema.NewChannelMember): Promise<schema.ChannelMember> {
    const db = getDb();
    const result = await db.insert(schema.channelMembers).values(data).returning();
    return result[0];
  },

  async updateRole(channelId: string, memberId: string, memberType: schema.ChannelMemberType, role: schema.ChannelMemberRole): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMembers)
      .set({ role })
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.entityId, memberId),
          eq(schema.channelMembers.entityType, memberType)
        )
      );
  },

  async removeMember(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<void> {
    const db = getDb();
    await db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.entityId, memberId),
          eq(schema.channelMembers.entityType, memberType)
        )
      );
  },

  async isMember(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.entityId, memberId),
          eq(schema.channelMembers.entityType, memberType)
        )
      );
    return result.length > 0;
  },

  async isAdmin(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.entityId, memberId),
          eq(schema.channelMembers.entityType, memberType),
          eq(schema.channelMembers.role, 'admin')
        )
      );
    return result.length > 0;
  },

  async canPost(channelId: string, memberId: string, memberType: schema.ChannelMemberType): Promise<boolean> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.entityId, memberId),
          eq(schema.channelMembers.entityType, memberType)
        )
      );
    const member = result[0];
    return !!member && member.role !== 'read_only';
  },

  async countMembers(channelId: string): Promise<number> {
    const db = getDb();
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channelId));
    return Number(result[0]?.count ?? 0);
  },
};

// ============================================================================
// Channel Message Queries
// ============================================================================

export interface SearchResult {
  message: schema.ChannelMessage;
  headline: string;
  rank: number;
}

export interface SearchOptions {
  channelId?: string;
  channelIds?: string[];
  limit?: number;
  offset?: number;
}

export interface ChannelMessageQueries {
  findById(id: string): Promise<schema.ChannelMessage | null>;
  findByChannelId(channelId: string, options?: { limit?: number; beforeId?: string }): Promise<schema.ChannelMessage[]>;
  findPinned(channelId: string): Promise<schema.ChannelMessage[]>;
  findThread(threadId: string): Promise<schema.ChannelMessage[]>;
  create(data: schema.NewChannelMessage): Promise<schema.ChannelMessage>;
  update(id: string, data: Partial<Pick<schema.ChannelMessage, 'body'>>): Promise<void>;
  pin(id: string, pinnedById: string): Promise<void>;
  unpin(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  incrementReplyCount(id: string): Promise<void>;
  decrementReplyCount(id: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchCount(query: string, options?: SearchOptions): Promise<number>;
}

export const channelMessageQueries: ChannelMessageQueries = {
  async findById(id: string): Promise<schema.ChannelMessage | null> {
    const db = getDb();
    const result = await db.select().from(schema.channelMessages).where(eq(schema.channelMessages.id, id));
    return result[0] ?? null;
  },

  async findByChannelId(channelId: string, options?: { limit?: number; beforeId?: string }): Promise<schema.ChannelMessage[]> {
    const db = getDb();
    const conditions = [
      eq(schema.channelMessages.channelId, channelId),
      isNull(schema.channelMessages.threadId),
    ];

    if (options?.beforeId) {
      const beforeMsg = await db.select().from(schema.channelMessages).where(eq(schema.channelMessages.id, options.beforeId));
      if (beforeMsg[0]) {
        conditions.push(lt(schema.channelMessages.createdAt, beforeMsg[0].createdAt));
      }
    }

    let query = db
      .select()
      .from(schema.channelMessages)
      .where(and(...conditions))
      .orderBy(desc(schema.channelMessages.createdAt));

    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }

    return query;
  },

  async findPinned(channelId: string): Promise<schema.ChannelMessage[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channelMessages)
      .where(and(eq(schema.channelMessages.channelId, channelId), eq(schema.channelMessages.isPinned, true)))
      .orderBy(desc(schema.channelMessages.pinnedAt));
  },

  async findThread(threadId: string): Promise<schema.ChannelMessage[]> {
    const db = getDb();
    return db
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.threadId, threadId))
      .orderBy(schema.channelMessages.createdAt);
  },

  async create(data: schema.NewChannelMessage): Promise<schema.ChannelMessage> {
    const db = getDb();
    const result = await db.insert(schema.channelMessages).values(data).returning();
    return result[0];
  },

  async update(id: string, data: Partial<Pick<schema.ChannelMessage, 'body'>>): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMessages)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.channelMessages.id, id));
  },

  async pin(id: string, pinnedById: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMessages)
      .set({ isPinned: true, pinnedAt: new Date(), pinnedById, updatedAt: new Date() })
      .where(eq(schema.channelMessages.id, id));
  },

  async unpin(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMessages)
      .set({ isPinned: false, pinnedAt: null, pinnedById: null, updatedAt: new Date() })
      .where(eq(schema.channelMessages.id, id));
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.channelMessages).where(eq(schema.channelMessages.id, id));
  },

  async incrementReplyCount(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMessages)
      .set({ replyCount: sql`${schema.channelMessages.replyCount} + 1`, updatedAt: new Date() })
      .where(eq(schema.channelMessages.id, id));
  },

  async decrementReplyCount(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.channelMessages)
      .set({ replyCount: sql`GREATEST(${schema.channelMessages.replyCount} - 1, 0)`, updatedAt: new Date() })
      .where(eq(schema.channelMessages.id, id));
  },

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const db = getDb();
    const limit = Math.min(options?.limit ?? 20, 100);
    const offset = options?.offset ?? 0;

    // Normalize and escape query for tsquery
    const normalizedQuery = query
      .trim()
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')  // Remove special chars
      .split(/\s+/)
      .filter(word => word.length > 0)
      .map(word => `${word}:*`)  // Prefix matching
      .join(' & ');

    if (!normalizedQuery) {
      return [];
    }

    // Build channel filter
    let channelFilter = '';
    if (options?.channelId) {
      channelFilter = `AND channel_id = '${options.channelId}'`;
    } else if (options?.channelIds && options.channelIds.length > 0) {
      const ids = options.channelIds.map(id => `'${id}'`).join(',');
      channelFilter = `AND channel_id IN (${ids})`;
    }

    const result = await db.execute(sql.raw(`
      SELECT
        m.*,
        ts_headline('english', m.body, plainto_tsquery('english', '${query.replace(/'/g, "''")}'),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=2') as headline,
        ts_rank(m.search_vector, to_tsquery('english', '${normalizedQuery}')) as rank
      FROM channel_messages m
      WHERE m.search_vector @@ to_tsquery('english', '${normalizedQuery}')
      ${channelFilter}
      ORDER BY rank DESC, m.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `));

    return (result.rows as Array<Record<string, unknown>>).map(row => ({
      message: {
        id: row.id as string,
        channelId: row.channel_id as string,
        senderId: row.sender_id as string,
        senderType: row.sender_type as schema.ChannelMemberType,
        senderName: row.sender_name as string,
        senderAvatarUrl: row.sender_avatar_url as string | null,
        body: row.body as string,
        threadId: row.thread_id as string | null,
        replyCount: Number(row.reply_count),
        isPinned: row.is_pinned as boolean,
        pinnedAt: row.pinned_at ? new Date(row.pinned_at as string) : null,
        pinnedById: row.pinned_by_id as string | null,
        mentions: row.mentions as string[] | null,
        createdAt: new Date(row.created_at as string),
        updatedAt: new Date(row.updated_at as string),
      },
      headline: row.headline as string,
      rank: Number(row.rank),
    }));
  },

  async searchCount(query: string, options?: SearchOptions): Promise<number> {
    const db = getDb();

    // Normalize and escape query for tsquery
    const normalizedQuery = query
      .trim()
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 0)
      .map(word => `${word}:*`)
      .join(' & ');

    if (!normalizedQuery) {
      return 0;
    }

    // Build channel filter
    let channelFilter = '';
    if (options?.channelId) {
      channelFilter = `AND channel_id = '${options.channelId}'`;
    } else if (options?.channelIds && options.channelIds.length > 0) {
      const ids = options.channelIds.map(id => `'${id}'`).join(',');
      channelFilter = `AND channel_id IN (${ids})`;
    }

    const result = await db.execute(sql.raw(`
      SELECT COUNT(*) as count
      FROM channel_messages m
      WHERE m.search_vector @@ to_tsquery('english', '${normalizedQuery}')
      ${channelFilter}
    `));

    return Number((result.rows[0] as Record<string, unknown>).count);
  },
};

// ============================================================================
// Channel Read State Queries
// ============================================================================

export interface ChannelReadStateQueries {
  findByChannelAndUser(channelId: string, userId: string): Promise<schema.ChannelReadState | null>;
  findByUserId(userId: string): Promise<schema.ChannelReadState[]>;
  upsert(channelId: string, userId: string, lastReadMessageId: string): Promise<schema.ChannelReadState>;
  markRead(channelId: string, userId: string): Promise<void>;
  markReadUpTo(channelId: string, userId: string, lastMessageId: string): Promise<number>;
  getUnreadCount(channelId: string, userId: string): Promise<number>;
  getUnreadCountsForUser(userId: string, channelIds: string[]): Promise<Map<string, number>>;
  deleteByChannel(channelId: string): Promise<void>;
}

export const channelReadStateQueries: ChannelReadStateQueries = {
  async findByChannelAndUser(channelId: string, userId: string): Promise<schema.ChannelReadState | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(schema.channelReadState)
      .where(and(eq(schema.channelReadState.channelId, channelId), eq(schema.channelReadState.userId, userId)));
    return result[0] ?? null;
  },

  async findByUserId(userId: string): Promise<schema.ChannelReadState[]> {
    const db = getDb();
    return db.select().from(schema.channelReadState).where(eq(schema.channelReadState.userId, userId));
  },

  async upsert(channelId: string, userId: string, lastReadMessageId: string): Promise<schema.ChannelReadState> {
    const db = getDb();
    const result = await db
      .insert(schema.channelReadState)
      .values({ channelId, userId, lastReadMessageId, lastReadAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.channelReadState.channelId, schema.channelReadState.userId],
        set: { lastReadMessageId, lastReadAt: new Date() },
      })
      .returning();
    return result[0];
  },

  async markRead(channelId: string, userId: string): Promise<void> {
    const db = getDb();
    const latestMessage = await db
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.channelId, channelId))
      .orderBy(desc(schema.channelMessages.createdAt))
      .limit(1);

    if (latestMessage[0]) {
      await db
        .insert(schema.channelReadState)
        .values({ channelId, userId, lastReadMessageId: latestMessage[0].id, lastReadAt: new Date() })
        .onConflictDoUpdate({
          target: [schema.channelReadState.channelId, schema.channelReadState.userId],
          set: { lastReadMessageId: latestMessage[0].id, lastReadAt: new Date() },
        });
    }
  },

  async markReadUpTo(channelId: string, userId: string, lastMessageId: string): Promise<number> {
    const db = getDb();

    // Get the message to verify it exists and get its timestamp
    const message = await db
      .select()
      .from(schema.channelMessages)
      .where(and(eq(schema.channelMessages.id, lastMessageId), eq(schema.channelMessages.channelId, channelId)))
      .limit(1);

    if (!message[0]) {
      return 0;
    }

    // Upsert the read state
    await db
      .insert(schema.channelReadState)
      .values({ channelId, userId, lastReadMessageId: lastMessageId, lastReadAt: message[0].createdAt })
      .onConflictDoUpdate({
        target: [schema.channelReadState.channelId, schema.channelReadState.userId],
        set: { lastReadMessageId: lastMessageId, lastReadAt: message[0].createdAt },
      });

    // Return remaining unread count (messages after this one)
    const result = await db
      .select({ count: count() })
      .from(schema.channelMessages)
      .where(
        and(eq(schema.channelMessages.channelId, channelId), gt(schema.channelMessages.createdAt, message[0].createdAt))
      );

    return Number(result[0]?.count ?? 0);
  },

  async getUnreadCount(channelId: string, userId: string): Promise<number> {
    const db = getDb();

    // Get user's read state for this channel
    const readState = await db
      .select()
      .from(schema.channelReadState)
      .where(and(eq(schema.channelReadState.channelId, channelId), eq(schema.channelReadState.userId, userId)))
      .limit(1);

    // If no read state, count all messages in channel
    if (!readState[0]) {
      const result = await db
        .select({ count: count() })
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.channelId, channelId));
      return Number(result[0]?.count ?? 0);
    }

    // Count messages after last_read_at
    const result = await db
      .select({ count: count() })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.channelId, channelId),
          gt(schema.channelMessages.createdAt, readState[0].lastReadAt)
        )
      );

    return Number(result[0]?.count ?? 0);
  },

  async getUnreadCountsForUser(userId: string, channelIds: string[]): Promise<Map<string, number>> {
    const db = getDb();
    const counts = new Map<string, number>();

    if (channelIds.length === 0) {
      return counts;
    }

    // Get all read states for this user
    const readStates = await db
      .select()
      .from(schema.channelReadState)
      .where(eq(schema.channelReadState.userId, userId));

    const readStateMap = new Map<string, Date>();
    for (const rs of readStates) {
      readStateMap.set(rs.channelId, rs.lastReadAt);
    }

    // For each channel, count unread messages
    for (const channelId of channelIds) {
      const lastReadAt = readStateMap.get(channelId);

      if (!lastReadAt) {
        // No read state - count all messages
        const result = await db
          .select({ count: count() })
          .from(schema.channelMessages)
          .where(eq(schema.channelMessages.channelId, channelId));
        counts.set(channelId, Number(result[0]?.count ?? 0));
      } else {
        // Count messages after last_read_at
        const result = await db
          .select({ count: count() })
          .from(schema.channelMessages)
          .where(and(eq(schema.channelMessages.channelId, channelId), gt(schema.channelMessages.createdAt, lastReadAt)));
        counts.set(channelId, Number(result[0]?.count ?? 0));
      }
    }

    return counts;
  },

  async deleteByChannel(channelId: string): Promise<void> {
    const db = getDb();
    await db.delete(schema.channelReadState).where(eq(schema.channelReadState.channelId, channelId));
  },
};

// ============================================================================
// Migration helper
// ============================================================================

export async function runMigrations() {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const db = getDb();
  await migrate(db, { migrationsFolder: './src/cloud/db/migrations' });
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
