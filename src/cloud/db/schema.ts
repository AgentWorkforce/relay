/**
 * Agent Relay Cloud - Drizzle Schema
 *
 * Type-safe database schema with PostgreSQL support.
 * Generate migrations: npm run db:generate
 * Run migrations: npm run db:migrate
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  bigint,
  jsonb,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================================================
// Users
// ============================================================================

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: varchar('github_id', { length: 255 }).unique().notNull(),
  githubUsername: varchar('github_username', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  avatarUrl: varchar('avatar_url', { length: 512 }),
  plan: varchar('plan', { length: 50 }).notNull().default('free'),
  // Stripe billing
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  // Nango OAuth connections
  nangoConnectionId: varchar('nango_connection_id', { length: 255 }), // Permanent login connection
  incomingConnectionId: varchar('incoming_connection_id', { length: 255 }), // Temp polling connection
  pendingInstallationRequest: timestamp('pending_installation_request'), // Org approval wait
  onboardingCompletedAt: timestamp('onboarding_completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  nangoConnectionIdx: index('idx_users_nango_connection').on(table.nangoConnectionId),
  incomingConnectionIdx: index('idx_users_incoming_connection').on(table.incomingConnectionId),
}));

export const usersRelations = relations(users, ({ many }) => ({
  credentials: many(credentials),
  workspaces: many(workspaces),
  projectGroups: many(projectGroups),
  repositories: many(repositories),
  linkedDaemons: many(linkedDaemons),
  installedGitHubApps: many(githubInstallations),
}));

// ============================================================================
// GitHub App Installations
// ============================================================================

export const githubInstallations = pgTable('github_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: varchar('installation_id', { length: 255 }).unique().notNull(),
  accountType: varchar('account_type', { length: 50 }).notNull(), // 'user' | 'organization'
  accountLogin: varchar('account_login', { length: 255 }).notNull(),
  accountId: varchar('account_id', { length: 255 }).notNull(),
  installedById: uuid('installed_by_id').references(() => users.id, { onDelete: 'set null' }),
  // Permissions granted to the installation
  permissions: jsonb('permissions').$type<Record<string, string>>().default({}),
  // Events the installation is subscribed to
  events: text('events').array(),
  // Installation state
  suspended: boolean('suspended').notNull().default(false),
  suspendedAt: timestamp('suspended_at'),
  suspendedBy: varchar('suspended_by', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  accountLoginIdx: index('idx_github_installations_account_login').on(table.accountLogin),
  installedByIdx: index('idx_github_installations_installed_by').on(table.installedById),
}));

export const githubInstallationsRelations = relations(githubInstallations, ({ one, many }) => ({
  installedBy: one(users, {
    fields: [githubInstallations.installedById],
    references: [users.id],
  }),
  repositories: many(repositories),
}));

// ============================================================================
// Credentials (provider tokens)
// ============================================================================

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 50 }).notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  scopes: text('scopes').array(),
  providerAccountId: varchar('provider_account_id', { length: 255 }),
  providerAccountEmail: varchar('provider_account_email', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userProviderIdx: unique('credentials_user_provider_unique').on(table.userId, table.provider),
  userIdIdx: index('idx_credentials_user_id').on(table.userId),
}));

export const credentialsRelations = relations(credentials, ({ one }) => ({
  user: one(users, {
    fields: [credentials.userId],
    references: [users.id],
  }),
}));

// ============================================================================
// Workspaces
// ============================================================================

// Agent policy types for workspace-level enforcement
export interface AgentPolicyRule {
  /** Agent name pattern (supports wildcards: "Lead", "Worker*", "*") */
  name: string;
  /** Allowed tools (empty = all allowed, ["none"] = no tools) */
  allowedTools?: string[];
  /** Agents this agent can spawn (empty = can spawn any) */
  canSpawn?: string[];
  /** Agents this agent can message (empty = can message any) */
  canMessage?: string[];
  /** Maximum concurrent spawns allowed */
  maxSpawns?: number;
  /** Rate limit: messages per minute */
  rateLimit?: number;
  /** Whether this agent can be spawned by others */
  canBeSpawned?: boolean;
}

export interface WorkspaceAgentPolicy {
  /** Default policy for agents without explicit config */
  defaultPolicy?: AgentPolicyRule;
  /** Named agent policies */
  agents?: AgentPolicyRule[];
  /** Global settings */
  settings?: {
    /** Require explicit agent definitions (reject unknown agents) */
    requireExplicitAgents?: boolean;
    /** Enable audit logging */
    auditEnabled?: boolean;
    /** Maximum total agents */
    maxTotalAgents?: number;
  };
}

// Workspace configuration type
export interface WorkspaceConfig {
  providers?: string[];
  repositories?: string[];
  supervisorEnabled?: boolean;
  maxAgents?: number;
  resourceTier?: 'small' | 'medium' | 'large' | 'xlarge';
  /** Agent policy for this workspace (enforced when repos don't have agents.md) */
  agentPolicy?: WorkspaceAgentPolicy;
}

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('provisioning'),
  computeProvider: varchar('compute_provider', { length: 50 }).notNull(),
  computeId: varchar('compute_id', { length: 255 }),
  publicUrl: varchar('public_url', { length: 255 }),
  customDomain: varchar('custom_domain', { length: 255 }),
  customDomainStatus: varchar('custom_domain_status', { length: 50 }),
  config: jsonb('config').$type<WorkspaceConfig>().notNull().default({}),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_workspaces_user_id').on(table.userId),
  customDomainIdx: index('idx_workspaces_custom_domain').on(table.customDomain),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  user: one(users, {
    fields: [workspaces.userId],
    references: [users.id],
  }),
  members: many(workspaceMembers),
  repositories: many(repositories),
}));

// ============================================================================
// Workspace Members
// ============================================================================

export const workspaceMembers = pgTable('workspace_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 50 }).notNull().default('member'),
  invitedBy: uuid('invited_by').references(() => users.id),
  invitedAt: timestamp('invited_at').defaultNow(),
  acceptedAt: timestamp('accepted_at'),
}, (table) => ({
  workspaceUserIdx: unique('workspace_members_workspace_user_unique').on(table.workspaceId, table.userId),
  workspaceIdIdx: index('idx_workspace_members_workspace_id').on(table.workspaceId),
  userIdIdx: index('idx_workspace_members_user_id').on(table.userId),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMembers.userId],
    references: [users.id],
  }),
  inviter: one(users, {
    fields: [workspaceMembers.invitedBy],
    references: [users.id],
  }),
}));

// ============================================================================
// Project Groups (grouping of related repositories)
// ============================================================================

export const projectGroups = pgTable('project_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  color: varchar('color', { length: 7 }), // Hex color for UI (e.g., "#3B82F6")
  icon: varchar('icon', { length: 50 }), // Icon name for UI
  // Coordinator agent configuration - this agent oversees all repos in the group
  coordinatorAgent: jsonb('coordinator_agent').$type<{
    enabled: boolean;
    name?: string; // Agent name (e.g., "PRPM Lead")
    model?: string; // AI model to use
    systemPrompt?: string; // Custom instructions for coordinator
    capabilities?: string[]; // What the coordinator can do
  }>().default({ enabled: false }),
  // Display order for user's groups
  sortOrder: bigint('sort_order', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_project_groups_user_id').on(table.userId),
  userNameIdx: unique('project_groups_user_name_unique').on(table.userId, table.name),
}));

export const projectGroupsRelations = relations(projectGroups, ({ one, many }) => ({
  user: one(users, {
    fields: [projectGroups.userId],
    references: [users.id],
  }),
  repositories: many(repositories),
}));

// ============================================================================
// Repositories
// ============================================================================

export const repositories = pgTable('repositories', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  projectGroupId: uuid('project_group_id').references(() => projectGroups.id, { onDelete: 'set null' }),
  // GitHub App installation that provides access to this repo
  installationId: uuid('installation_id').references(() => githubInstallations.id, { onDelete: 'set null' }),
  nangoConnectionId: varchar('nango_connection_id', { length: 255 }),
  githubFullName: varchar('github_full_name', { length: 255 }).notNull(),
  githubId: bigint('github_id', { mode: 'number' }).notNull(),
  defaultBranch: varchar('default_branch', { length: 255 }).notNull().default('main'),
  isPrivate: boolean('is_private').notNull().default(false),
  syncStatus: varchar('sync_status', { length: 50 }).notNull().default('pending'),
  lastSyncedAt: timestamp('last_synced_at'),
  // Project-level agent configuration (optional)
  projectAgent: jsonb('project_agent').$type<{
    enabled: boolean;
    name?: string; // Agent name (e.g., "beads-agent")
    model?: string;
    systemPrompt?: string;
  }>().default({ enabled: false }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userGithubIdx: unique('repositories_user_github_unique').on(table.userId, table.githubFullName),
  userIdIdx: index('idx_repositories_user_id').on(table.userId),
  workspaceIdIdx: index('idx_repositories_workspace_id').on(table.workspaceId),
  projectGroupIdIdx: index('idx_repositories_project_group_id').on(table.projectGroupId),
  installationIdIdx: index('idx_repositories_installation_id').on(table.installationId),
  nangoConnectionIdx: index('idx_repositories_nango_connection').on(table.nangoConnectionId),
}));

export const repositoriesRelations = relations(repositories, ({ one }) => ({
  user: one(users, {
    fields: [repositories.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [repositories.workspaceId],
    references: [workspaces.id],
  }),
  projectGroup: one(projectGroups, {
    fields: [repositories.projectGroupId],
    references: [projectGroups.id],
  }),
  installation: one(githubInstallations, {
    fields: [repositories.installationId],
    references: [githubInstallations.id],
  }),
}));

// ============================================================================
// Linked Daemons (local agent-relay instances)
// ============================================================================

export const linkedDaemons = pgTable('linked_daemons', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  machineId: varchar('machine_id', { length: 255 }).notNull(),
  apiKeyHash: varchar('api_key_hash', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('offline'),
  lastSeenAt: timestamp('last_seen_at'),
  metadata: jsonb('metadata').notNull().default({}),
  pendingUpdates: jsonb('pending_updates').notNull().default([]),
  messageQueue: jsonb('message_queue').notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userMachineIdx: unique('linked_daemons_user_machine_unique').on(table.userId, table.machineId),
  userIdIdx: index('idx_linked_daemons_user_id').on(table.userId),
  apiKeyHashIdx: index('idx_linked_daemons_api_key_hash').on(table.apiKeyHash),
  statusIdx: index('idx_linked_daemons_status').on(table.status),
}));

export const linkedDaemonsRelations = relations(linkedDaemons, ({ one }) => ({
  user: one(users, {
    fields: [linkedDaemons.userId],
    references: [users.id],
  }),
}));

// ============================================================================
// Subscriptions (billing)
// ============================================================================

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }).unique(),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  plan: varchar('plan', { length: 50 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('active'),
  currentPeriodStart: timestamp('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================================================
// Usage Records
// ============================================================================

export const usageRecords = pgTable('usage_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  metric: varchar('metric', { length: 100 }).notNull(),
  value: bigint('value', { mode: 'number' }).notNull(),
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_usage_records_user_id').on(table.userId),
  recordedAtIdx: index('idx_usage_records_recorded_at').on(table.recordedAt),
}));

// ============================================================================
// Agent Sessions (cloud persistence for PtyWrapper agents)
// ============================================================================

export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('active'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  endMarker: jsonb('end_marker').$type<{
    summary?: string;
    completedTasks?: string[];
  }>(),
  metadata: jsonb('metadata').notNull().default({}),
}, (table) => ({
  workspaceIdIdx: index('idx_agent_sessions_workspace_id').on(table.workspaceId),
  agentNameIdx: index('idx_agent_sessions_agent_name').on(table.agentName),
  statusIdx: index('idx_agent_sessions_status').on(table.status),
}));

// ============================================================================
// Agent Summaries (cloud persistence for [[SUMMARY]] blocks)
// ============================================================================

export const agentSummaries = pgTable('agent_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  summary: jsonb('summary').$type<{
    currentTask?: string;
    completedTasks?: string[];
    decisions?: string[];
    context?: string;
    files?: string[];
  }>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  sessionIdIdx: index('idx_agent_summaries_session_id').on(table.sessionId),
  agentNameIdx: index('idx_agent_summaries_agent_name').on(table.agentName),
}));

// ============================================================================
// Type exports
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type ProjectGroup = typeof projectGroups.$inferSelect;
export type NewProjectGroup = typeof projectGroups.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type LinkedDaemon = typeof linkedDaemons.$inferSelect;
export type NewLinkedDaemon = typeof linkedDaemons.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type AgentSummary = typeof agentSummaries.$inferSelect;
export type NewAgentSummary = typeof agentSummaries.$inferInsert;

// Agent configuration types
export type CoordinatorAgentConfig = NonNullable<ProjectGroup['coordinatorAgent']>;
export type ProjectAgentConfig = NonNullable<Repository['projectAgent']>;

// ============================================================================
// Agent Metrics (memory monitoring and crash insights)
// ============================================================================

export interface AgentMemoryMetricsData {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  cpuPercent: number;
  trend: 'growing' | 'stable' | 'shrinking' | 'unknown';
  trendRatePerMinute: number;
  alertLevel: 'normal' | 'warning' | 'critical' | 'oom_imminent';
  highWatermark: number;
  averageRss: number;
}

export interface CrashInsightData {
  likelyCause: 'oom' | 'memory_leak' | 'sudden_spike' | 'signal' | 'error' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  details: string[];
  recommendations: string[];
  peakMemory: number;
  lastKnownMemory: number | null;
}

export const agentMetrics = pgTable('agent_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  daemonId: uuid('daemon_id').notNull().references(() => linkedDaemons.id, { onDelete: 'cascade' }),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  pid: bigint('pid', { mode: 'number' }),
  status: varchar('status', { length: 50 }).notNull().default('unknown'),
  // Current memory snapshot
  rssBytes: bigint('rss_bytes', { mode: 'number' }),
  heapUsedBytes: bigint('heap_used_bytes', { mode: 'number' }),
  cpuPercent: bigint('cpu_percent', { mode: 'number' }),
  // Trend data
  trend: varchar('trend', { length: 20 }),
  trendRatePerMinute: bigint('trend_rate_per_minute', { mode: 'number' }),
  alertLevel: varchar('alert_level', { length: 20 }).default('normal'),
  // Watermarks
  highWatermark: bigint('high_watermark', { mode: 'number' }),
  averageRss: bigint('average_rss', { mode: 'number' }),
  // Full metrics JSON for detailed data
  metricsData: jsonb('metrics_data').$type<AgentMemoryMetricsData>(),
  // Timestamps
  uptimeMs: bigint('uptime_ms', { mode: 'number' }),
  startedAt: timestamp('started_at'),
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),
}, (table) => ({
  daemonIdIdx: index('idx_agent_metrics_daemon_id').on(table.daemonId),
  agentNameIdx: index('idx_agent_metrics_agent_name').on(table.agentName),
  recordedAtIdx: index('idx_agent_metrics_recorded_at').on(table.recordedAt),
  alertLevelIdx: index('idx_agent_metrics_alert_level').on(table.alertLevel),
}));

export const agentMetricsRelations = relations(agentMetrics, ({ one }) => ({
  daemon: one(linkedDaemons, {
    fields: [agentMetrics.daemonId],
    references: [linkedDaemons.id],
  }),
}));

// ============================================================================
// Agent Crashes (crash history with insights)
// ============================================================================

export const agentCrashes = pgTable('agent_crashes', {
  id: uuid('id').primaryKey().defaultRandom(),
  daemonId: uuid('daemon_id').notNull().references(() => linkedDaemons.id, { onDelete: 'cascade' }),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  pid: bigint('pid', { mode: 'number' }),
  exitCode: bigint('exit_code', { mode: 'number' }),
  signal: varchar('signal', { length: 50 }),
  reason: text('reason'),
  // Crash analysis
  likelyCause: varchar('likely_cause', { length: 50 }),
  confidence: varchar('confidence', { length: 20 }),
  summary: text('summary'),
  // Memory state at crash
  peakMemory: bigint('peak_memory', { mode: 'number' }),
  lastKnownMemory: bigint('last_known_memory', { mode: 'number' }),
  memoryTrend: varchar('memory_trend', { length: 20 }),
  // Full insight data
  insightData: jsonb('insight_data').$type<CrashInsightData>(),
  // Last output (truncated)
  lastOutput: text('last_output'),
  crashedAt: timestamp('crashed_at').defaultNow().notNull(),
}, (table) => ({
  daemonIdIdx: index('idx_agent_crashes_daemon_id').on(table.daemonId),
  agentNameIdx: index('idx_agent_crashes_agent_name').on(table.agentName),
  crashedAtIdx: index('idx_agent_crashes_crashed_at').on(table.crashedAt),
  likelyCauseIdx: index('idx_agent_crashes_likely_cause').on(table.likelyCause),
}));

export const agentCrashesRelations = relations(agentCrashes, ({ one }) => ({
  daemon: one(linkedDaemons, {
    fields: [agentCrashes.daemonId],
    references: [linkedDaemons.id],
  }),
}));

// ============================================================================
// Memory Alerts (proactive alerting history)
// ============================================================================

export const memoryAlerts = pgTable('memory_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  daemonId: uuid('daemon_id').notNull().references(() => linkedDaemons.id, { onDelete: 'cascade' }),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  alertType: varchar('alert_type', { length: 50 }).notNull(), // warning, critical, oom_imminent, trend_warning, recovered
  currentRss: bigint('current_rss', { mode: 'number' }),
  threshold: bigint('threshold', { mode: 'number' }),
  message: text('message'),
  recommendation: text('recommendation'),
  acknowledged: boolean('acknowledged').default(false),
  acknowledgedAt: timestamp('acknowledged_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  daemonIdIdx: index('idx_memory_alerts_daemon_id').on(table.daemonId),
  agentNameIdx: index('idx_memory_alerts_agent_name').on(table.agentName),
  alertTypeIdx: index('idx_memory_alerts_alert_type').on(table.alertType),
  createdAtIdx: index('idx_memory_alerts_created_at').on(table.createdAt),
}));

export const memoryAlertsRelations = relations(memoryAlerts, ({ one }) => ({
  daemon: one(linkedDaemons, {
    fields: [memoryAlerts.daemonId],
    references: [linkedDaemons.id],
  }),
}));

// Type exports for new tables
export type AgentMetric = typeof agentMetrics.$inferSelect;
export type NewAgentMetric = typeof agentMetrics.$inferInsert;
export type AgentCrash = typeof agentCrashes.$inferSelect;
export type NewAgentCrash = typeof agentCrashes.$inferInsert;
export type MemoryAlert = typeof memoryAlerts.$inferSelect;
export type NewMemoryAlert = typeof memoryAlerts.$inferInsert;

// ============================================================================
// CI Failure Events (GitHub CI check failures)
// ============================================================================

export interface CIAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: string;
  message: string;
}

export const ciFailureEvents = pgTable('ci_failure_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
  repository: varchar('repository', { length: 255 }).notNull(), // org/repo format
  prNumber: bigint('pr_number', { mode: 'number' }),
  branch: varchar('branch', { length: 255 }),
  commitSha: varchar('commit_sha', { length: 40 }),
  checkName: varchar('check_name', { length: 255 }).notNull(),
  checkId: bigint('check_id', { mode: 'number' }).notNull(),
  conclusion: varchar('conclusion', { length: 50 }).notNull(), // failure, cancelled, timed_out, etc.
  failureTitle: text('failure_title'),
  failureSummary: text('failure_summary'),
  failureDetails: text('failure_details'),
  annotations: jsonb('annotations').$type<CIAnnotation[]>().default([]),
  workflowName: varchar('workflow_name', { length: 255 }),
  workflowRunId: bigint('workflow_run_id', { mode: 'number' }),
  // Processing state
  processedAt: timestamp('processed_at'),
  agentSpawned: boolean('agent_spawned').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  repositoryIdx: index('idx_ci_failure_events_repository').on(table.repository),
  prNumberIdx: index('idx_ci_failure_events_pr_number').on(table.prNumber),
  checkNameIdx: index('idx_ci_failure_events_check_name').on(table.checkName),
  createdAtIdx: index('idx_ci_failure_events_created_at').on(table.createdAt),
  repoPrIdx: index('idx_ci_failure_events_repo_pr').on(table.repository, table.prNumber),
}));

export const ciFailureEventsRelations = relations(ciFailureEvents, ({ one, many }) => ({
  repositoryRef: one(repositories, {
    fields: [ciFailureEvents.repositoryId],
    references: [repositories.id],
  }),
  fixAttempts: many(ciFixAttempts),
}));

// ============================================================================
// CI Fix Attempts (agent responses to failures)
// ============================================================================

export const ciFixAttempts = pgTable('ci_fix_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  failureEventId: uuid('failure_event_id').notNull().references(() => ciFailureEvents.id, { onDelete: 'cascade' }),
  agentId: varchar('agent_id', { length: 255 }).notNull(),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('pending'), // pending, in_progress, success, failed
  commitSha: varchar('commit_sha', { length: 40 }),
  errorMessage: text('error_message'),
  // Timing
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  failureEventIdx: index('idx_ci_fix_attempts_failure_event').on(table.failureEventId),
  statusIdx: index('idx_ci_fix_attempts_status').on(table.status),
  agentIdIdx: index('idx_ci_fix_attempts_agent_id').on(table.agentId),
}));

export const ciFixAttemptsRelations = relations(ciFixAttempts, ({ one }) => ({
  failureEvent: one(ciFailureEvents, {
    fields: [ciFixAttempts.failureEventId],
    references: [ciFailureEvents.id],
  }),
}));

// ============================================================================
// CI Webhook Configuration (per-repository settings)
// ============================================================================

export interface CICheckStrategy {
  autoFix: boolean;
  command?: string;
  agentProfile?: string;
  notifyOnly?: boolean;
}

export interface CIWebhookConfig {
  enabled: boolean;
  autoFix?: {
    lint?: boolean;
    typecheck?: boolean;
    test?: boolean;
    build?: boolean;
  };
  notifyExistingAgent?: boolean;
  spawnNewAgent?: boolean;
  maxConcurrentAgents?: number;
  cooldownMinutes?: number;
  checkStrategies?: Record<string, CICheckStrategy>;
}

// Type exports for CI tables
export type CIFailureEvent = typeof ciFailureEvents.$inferSelect;
export type NewCIFailureEvent = typeof ciFailureEvents.$inferInsert;
export type CIFixAttempt = typeof ciFixAttempts.$inferSelect;
export type NewCIFixAttempt = typeof ciFixAttempts.$inferInsert;

// ============================================================================
// GitHub Issue Assignments (agent handling of issues)
// ============================================================================

export const issueAssignments = pgTable('issue_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
  repository: varchar('repository', { length: 255 }).notNull(), // org/repo format
  issueNumber: bigint('issue_number', { mode: 'number' }).notNull(),
  issueTitle: text('issue_title').notNull(),
  issueBody: text('issue_body'),
  issueUrl: varchar('issue_url', { length: 512 }),
  // Assignment details
  agentId: varchar('agent_id', { length: 255 }),
  agentName: varchar('agent_name', { length: 255 }),
  assignedAt: timestamp('assigned_at'),
  // Status tracking
  status: varchar('status', { length: 50 }).notNull().default('pending'), // pending, assigned, in_progress, resolved, closed
  resolution: text('resolution'),
  // PR created to fix the issue
  linkedPrNumber: bigint('linked_pr_number', { mode: 'number' }),
  // Metadata
  labels: text('labels').array(),
  priority: varchar('priority', { length: 20 }), // low, medium, high, critical
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  repositoryIdx: index('idx_issue_assignments_repository').on(table.repository),
  issueNumberIdx: index('idx_issue_assignments_issue_number').on(table.issueNumber),
  statusIdx: index('idx_issue_assignments_status').on(table.status),
  agentIdIdx: index('idx_issue_assignments_agent_id').on(table.agentId),
  repoIssueIdx: unique('issue_assignments_repo_issue_unique').on(table.repository, table.issueNumber),
}));

export const issueAssignmentsRelations = relations(issueAssignments, ({ one }) => ({
  repositoryRef: one(repositories, {
    fields: [issueAssignments.repositoryId],
    references: [repositories.id],
  }),
}));

// ============================================================================
// Comment Mentions (tracking @mentions to agents)
// ============================================================================

export const commentMentions = pgTable('comment_mentions', {
  id: uuid('id').primaryKey().defaultRandom(),
  repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
  repository: varchar('repository', { length: 255 }).notNull(),
  // Source of the mention
  sourceType: varchar('source_type', { length: 50 }).notNull(), // issue_comment, pr_comment, pr_review
  sourceId: bigint('source_id', { mode: 'number' }).notNull(), // GitHub comment ID
  issueOrPrNumber: bigint('issue_or_pr_number', { mode: 'number' }).notNull(),
  // Comment details
  commentBody: text('comment_body').notNull(),
  commentUrl: varchar('comment_url', { length: 512 }),
  authorLogin: varchar('author_login', { length: 255 }).notNull(),
  authorId: bigint('author_id', { mode: 'number' }),
  // Mention details
  mentionedAgent: varchar('mentioned_agent', { length: 255 }).notNull(), // e.g., "agent-relay", "ci-fix", "lead"
  mentionContext: text('mention_context'), // Text surrounding the mention
  // Response tracking
  agentId: varchar('agent_id', { length: 255 }),
  agentName: varchar('agent_name', { length: 255 }),
  status: varchar('status', { length: 50 }).notNull().default('pending'), // pending, processing, responded, ignored
  responseCommentId: bigint('response_comment_id', { mode: 'number' }),
  responseBody: text('response_body'),
  respondedAt: timestamp('responded_at'),
  // Metadata
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  repositoryIdx: index('idx_comment_mentions_repository').on(table.repository),
  sourceIdx: index('idx_comment_mentions_source').on(table.sourceType, table.sourceId),
  statusIdx: index('idx_comment_mentions_status').on(table.status),
  mentionedAgentIdx: index('idx_comment_mentions_mentioned_agent').on(table.mentionedAgent),
}));

export const commentMentionsRelations = relations(commentMentions, ({ one }) => ({
  repositoryRef: one(repositories, {
    fields: [commentMentions.repositoryId],
    references: [repositories.id],
  }),
}));

// ============================================================================
// Agent Webhook Configuration (per-repo settings for agent triggers)
// ============================================================================

export interface AgentTriggerConfig {
  // Which agents can be mentioned
  mentionableAgents?: string[]; // e.g., ["lead", "ci-fix", "reviewer"]
  // Default agent for issue handling
  defaultIssueAgent?: string;
  // Labels that trigger agent assignment
  autoAssignLabels?: Record<string, string>; // e.g., { "bug": "debugger", "enhancement": "developer" }
  // Whether to auto-respond to mentions
  autoRespondToMentions?: boolean;
  // Rate limiting
  maxResponsesPerHour?: number;
  // Who can trigger agents
  allowedTriggerUsers?: string[]; // Empty = everyone, list = only these users
}

// Type exports for issue/comment tables
export type IssueAssignment = typeof issueAssignments.$inferSelect;
export type NewIssueAssignment = typeof issueAssignments.$inferInsert;
export type CommentMention = typeof commentMentions.$inferSelect;
export type NewCommentMention = typeof commentMentions.$inferInsert;
