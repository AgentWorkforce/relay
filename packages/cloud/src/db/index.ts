/**
 * Agent Relay Cloud - Database Layer
 *
 * Re-exports Drizzle ORM queries and types.
 * All database access should go through Drizzle for type safety.
 *
 * Generate migrations: npm run db:generate
 * Run migrations: npm run db:migrate
 */

// Re-export all types from schema
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
  WorkspaceAgentPolicy,
  AgentPolicyRule,
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
  // CI failure types
  CIAnnotation,
  CIFailureEvent,
  NewCIFailureEvent,
  CIFixAttempt,
  NewCIFixAttempt,
  CICheckStrategy,
  CIWebhookConfig,
  // Issue and comment types
  IssueAssignment,
  NewIssueAssignment,
  CommentMention,
  NewCommentMention,
  AgentTriggerConfig,
  // Channel types
  Channel,
  NewChannel,
  ChannelMember,
  NewChannelMember,
} from './schema.js';

// Re-export schema tables for direct access if needed
export {
  users as usersTable,
  userEmails as userEmailsTable,
  githubInstallations as githubInstallationsTable,
  credentials as credentialsTable,
  workspaces as workspacesTable,
  workspaceMembers as workspaceMembersTable,
  projectGroups as projectGroupsTable,
  repositories as repositoriesTable,
  linkedDaemons as linkedDaemonsTable,
  subscriptions as subscriptionsTable,
  usageRecords as usageRecordsTable,
  ciFailureEvents as ciFailureEventsTable,
  ciFixAttempts as ciFixAttemptsTable,
  issueAssignments as issueAssignmentsTable,
  commentMentions as commentMentionsTable,
  channels as channelsTable,
  channelMembers as channelMembersTable,
} from './schema.js';

// Import query modules
import {
  getDb,
  closeDb,
  runMigrations,
  getRawPool,
  userQueries,
  userEmailQueries,
  githubInstallationQueries,
  credentialQueries,
  workspaceQueries,
  workspaceMemberQueries,
  linkedDaemonQueries,
  projectGroupQueries,
  repositoryQueries,
  ciFailureEventQueries,
  ciFixAttemptQueries,
  issueAssignmentQueries,
  commentMentionQueries,
  channelQueries,
  channelMemberQueries,
} from './drizzle.js';

// Bulk ingest utilities for high-volume message sync to cloud
import {
  bulkInsertMessages,
  streamingBulkInsert,
  optimizedBulkInsert,
  getPoolStats,
  checkPoolHealth,
  type BulkInsertResult,
} from './bulk-ingest.js';

// Legacy type aliases for backwards compatibility
export type PlanType = 'free' | 'pro' | 'team' | 'enterprise';
export type WorkspaceMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

// Export the db object with all query namespaces
export const db = {
  // User operations
  users: userQueries,
  // User email operations (for GitHub-linked emails and account reconciliation)
  userEmails: userEmailQueries,
  // GitHub App installation operations
  githubInstallations: githubInstallationQueries,
  // Credential operations
  credentials: credentialQueries,
  // Workspace operations
  workspaces: workspaceQueries,
  // Workspace member operations
  workspaceMembers: workspaceMemberQueries,
  // Project group operations (for grouping repositories)
  projectGroups: projectGroupQueries,
  // Repository operations
  repositories: repositoryQueries,
  // Linked daemon operations (for local agent-relay instances)
  linkedDaemons: linkedDaemonQueries,
  // CI failure tracking
  ciFailureEvents: ciFailureEventQueries,
  ciFixAttempts: ciFixAttemptQueries,
  // Issue and comment tracking
  issueAssignments: issueAssignmentQueries,
  commentMentions: commentMentionQueries,
  // Channel operations (workspace-scoped messaging)
  channels: channelQueries,
  channelMembers: channelMemberQueries,
  // Bulk ingest utilities for high-volume message sync
  bulk: {
    insertMessages: bulkInsertMessages,
    streamingInsert: streamingBulkInsert,
    optimizedInsert: optimizedBulkInsert,
    getPoolStats: () => getPoolStats(getRawPool()),
    checkHealth: () => checkPoolHealth(getRawPool()),
  },
  // Database utilities
  getDb,
  getRawPool,
  close: closeDb,
  runMigrations,
};

// Export query objects for direct import
export {
  userQueries,
  userEmailQueries,
  githubInstallationQueries,
  credentialQueries,
  workspaceQueries,
  workspaceMemberQueries,
  projectGroupQueries,
  repositoryQueries,
  linkedDaemonQueries,
  ciFailureEventQueries,
  ciFixAttemptQueries,
  issueAssignmentQueries,
  commentMentionQueries,
};

// Export database utilities
export { getDb, closeDb, runMigrations, getRawPool };

// Bulk ingest utilities for direct import
export {
  bulkInsertMessages,
  streamingBulkInsert,
  optimizedBulkInsert,
  getPoolStats,
  checkPoolHealth,
  type BulkInsertResult,
};

// Legacy function - use runMigrations instead
export async function initializeDatabase(): Promise<void> {
  console.warn('initializeDatabase() is deprecated. Use runMigrations() instead.');
  await runMigrations();
}
