/**
 * Credential Router Service
 *
 * Routes AI provider API calls through the appropriate user's credentials
 * to ensure ToS compliance in team workspaces.
 *
 * Credential Priority:
 * 1. Requesting user's own credentials (preferred)
 * 2. Workspace owner's credentials (with disclosure, if allowed)
 * 3. Error requiring user to connect their own account
 */

import { db } from '../db/index.js';
import type { WorkspaceCredentialPolicy, WorkspaceConfig } from '../db/schema.js';

// Re-export the policy type for consumers
export type { WorkspaceCredentialPolicy };

// ============================================================================
// Types
// ============================================================================

export type CredentialSource = 'user' | 'workspace_owner' | 'organization';

export interface CredentialRouteResult {
  /** The credentials to use for the API call */
  credentials: {
    provider: string;
    userId: string;
    workspaceId: string;
  } | null;
  /** Source of the credentials */
  source: CredentialSource | null;
  /** User ID of the credential owner */
  credentialOwnerId: string | null;
  /** Whether fallback was used (team member using owner's credentials) */
  usedFallback: boolean;
  /** Warning message if fallback was used */
  warning?: string;
}

export interface CredentialRouteContext {
  /** Workspace ID where the action is taking place */
  workspaceId: string;
  /** User ID of who is requesting the action (e.g., sending a message) */
  requestingUserId: string;
  /** AI provider being used */
  provider: string;
  /** Action being performed (for audit logging) */
  action: 'agent_message' | 'agent_spawn' | 'tool_call' | 'completion';
}

export interface CredentialUsageLog {
  timestamp: Date;
  workspaceId: string;
  requestingUserId: string;
  credentialOwnerId: string;
  provider: string;
  action: string;
  credentialSource: CredentialSource;
}

// Resolved policy with defaults applied
export interface ResolvedCredentialPolicy {
  allowCredentialFallback: boolean;
  requirePerUserAuth: string[];
  auditCredentialUsage: boolean;
}

// ============================================================================
// Default Policy
// ============================================================================

const DEFAULT_CREDENTIAL_POLICY: ResolvedCredentialPolicy = {
  allowCredentialFallback: false, // Strict by default for compliance
  requirePerUserAuth: ['anthropic', 'openai', 'google'], // Major AI providers
  auditCredentialUsage: true,
};

// ============================================================================
// Credential Router
// ============================================================================

/**
 * Get the appropriate credentials for an AI provider API call.
 *
 * This ensures ToS compliance by:
 * 1. Preferring the requesting user's own credentials
 * 2. Only falling back to owner credentials if explicitly allowed
 * 3. Logging credential usage for audit purposes
 */
export async function routeCredentials(
  context: CredentialRouteContext
): Promise<CredentialRouteResult> {
  const { workspaceId, requestingUserId, provider, action } = context;

  // Get workspace and its credential policy
  const workspace = await db.workspaces.findById(workspaceId);
  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const policy = getCredentialPolicy(workspace);

  // Priority 1: Try requesting user's own credentials
  const userCredentials = await db.credentials.findByUserAndWorkspace(
    requestingUserId,
    workspaceId
  );

  const userProviderCred = userCredentials.find((c) => c.provider === provider);

  if (userProviderCred) {
    // User has their own credentials - use them (compliant)
    const result: CredentialRouteResult = {
      credentials: {
        provider,
        userId: requestingUserId,
        workspaceId,
      },
      source: 'user',
      credentialOwnerId: requestingUserId,
      usedFallback: false,
    };

    if (policy.auditCredentialUsage) {
      await logCredentialUsage({
        timestamp: new Date(),
        workspaceId,
        requestingUserId,
        credentialOwnerId: requestingUserId,
        provider,
        action,
        credentialSource: 'user',
      });
    }

    return result;
  }

  // Priority 2: Check if fallback to workspace owner is allowed
  if (
    policy.allowCredentialFallback &&
    !policy.requirePerUserAuth.includes(provider)
  ) {
    const ownerCredentials = await db.credentials.findByUserAndWorkspace(
      workspace.userId,
      workspaceId
    );

    const ownerProviderCred = ownerCredentials.find((c) => c.provider === provider);

    if (ownerProviderCred) {
      // Fallback to owner's credentials (with warning)
      const result: CredentialRouteResult = {
        credentials: {
          provider,
          userId: workspace.userId,
          workspaceId,
        },
        source: 'workspace_owner',
        credentialOwnerId: workspace.userId,
        usedFallback: true,
        warning: `Using workspace owner's ${provider} credentials. For ToS compliance, consider connecting your own ${provider} account.`,
      };

      if (policy.auditCredentialUsage) {
        await logCredentialUsage({
          timestamp: new Date(),
          workspaceId,
          requestingUserId,
          credentialOwnerId: workspace.userId,
          provider,
          action,
          credentialSource: 'workspace_owner',
        });
      }

      return result;
    }
  }

  // Priority 3: No credentials available - require user to connect
  return {
    credentials: null,
    source: null,
    credentialOwnerId: null,
    usedFallback: false,
    warning: `Please connect your ${provider} account to interact with AI agents. Visit Settings > Providers to connect.`,
  };
}

/**
 * Check if a user has the required credentials for a provider in a workspace.
 */
export async function hasRequiredCredentials(
  userId: string,
  workspaceId: string,
  provider: string
): Promise<boolean> {
  const credentials = await db.credentials.findByUserAndWorkspace(userId, workspaceId);
  return credentials.some((c) => c.provider === provider);
}

/**
 * Get all providers a user is missing credentials for in a workspace.
 */
export async function getMissingProviders(
  userId: string,
  workspaceId: string
): Promise<string[]> {
  const workspace = await db.workspaces.findById(workspaceId);
  if (!workspace) return [];

  const policy = getCredentialPolicy(workspace);
  const userCredentials = await db.credentials.findByUserAndWorkspace(userId, workspaceId);
  const connectedProviders = new Set(userCredentials.map((c) => c.provider));

  return policy.requirePerUserAuth.filter((p) => !connectedProviders.has(p));
}

/**
 * Get credential policy for a workspace.
 */
export function getCredentialPolicy(
  workspace: { config?: WorkspaceConfig | null }
): ResolvedCredentialPolicy {
  const workspacePolicy = workspace.config?.credentialPolicy;

  return {
    allowCredentialFallback: workspacePolicy?.allowCredentialFallback ?? DEFAULT_CREDENTIAL_POLICY.allowCredentialFallback,
    requirePerUserAuth: workspacePolicy?.requirePerUserAuth ?? DEFAULT_CREDENTIAL_POLICY.requirePerUserAuth,
    auditCredentialUsage: workspacePolicy?.auditCredentialUsage ?? DEFAULT_CREDENTIAL_POLICY.auditCredentialUsage,
  };
}

// ============================================================================
// Credential Compliance Checks
// ============================================================================

export interface ComplianceCheckResult {
  compliant: boolean;
  issues: string[];
  recommendations: string[];
}

/**
 * Check if a workspace's credential setup is compliant with provider ToS.
 */
export async function checkWorkspaceCompliance(
  workspaceId: string
): Promise<ComplianceCheckResult> {
  const workspace = await db.workspaces.findById(workspaceId);
  if (!workspace) {
    return {
      compliant: false,
      issues: ['Workspace not found'],
      recommendations: [],
    };
  }

  const issues: string[] = [];
  const recommendations: string[] = [];

  // Get all workspace members
  const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);

  // Check each member's credential status
  for (const member of members) {
    if (member.role === 'owner') continue; // Owner always has their own credentials

    const missingProviders = await getMissingProviders(member.userId, workspaceId);

    if (missingProviders.length > 0) {
      const user = await db.users.findById(member.userId);
      const username = user?.githubUsername || member.userId;

      issues.push(
        `Team member "${username}" is missing credentials for: ${missingProviders.join(', ')}`
      );
      recommendations.push(
        `Invite "${username}" to connect their own AI provider accounts for full ToS compliance`
      );
    }
  }

  // Check workspace policy
  const policy = getCredentialPolicy(workspace);

  if (policy.allowCredentialFallback) {
    recommendations.push(
      'Consider disabling credential fallback (allowCredentialFallback: false) for stricter ToS compliance'
    );
  }

  if (!policy.auditCredentialUsage) {
    recommendations.push(
      'Enable audit logging (auditCredentialUsage: true) for compliance tracking'
    );
  }

  return {
    compliant: issues.length === 0,
    issues,
    recommendations,
  };
}

// ============================================================================
// Audit Logging
// ============================================================================

const usageLogs: CredentialUsageLog[] = [];
const MAX_IN_MEMORY_LOGS = 1000;

/**
 * Log credential usage for compliance auditing.
 * In production, this should write to a database table.
 */
async function logCredentialUsage(log: CredentialUsageLog): Promise<void> {
  // In-memory logging for now (should be persisted to database in production)
  usageLogs.push(log);

  // Prevent memory leak
  if (usageLogs.length > MAX_IN_MEMORY_LOGS) {
    usageLogs.shift();
  }

  // Log to console for visibility
  if (log.requestingUserId !== log.credentialOwnerId) {
    console.log(
      `[credential-router] AUDIT: User ${log.requestingUserId} used ${log.credentialSource} credentials ` +
        `(owner: ${log.credentialOwnerId}) for ${log.action} with ${log.provider}`
    );
  }
}

/**
 * Get credential usage logs for a workspace.
 */
export function getUsageLogs(workspaceId: string): CredentialUsageLog[] {
  return usageLogs.filter((log) => log.workspaceId === workspaceId);
}

/**
 * Get credential usage summary for compliance reporting.
 */
export function getUsageSummary(workspaceId: string): {
  totalCalls: number;
  bySource: Record<CredentialSource, number>;
  fallbackUsage: number;
  uniqueUsers: number;
} {
  const logs = getUsageLogs(workspaceId);

  const bySource: Record<CredentialSource, number> = {
    user: 0,
    workspace_owner: 0,
    organization: 0,
  };

  const uniqueUserIds = new Set<string>();
  let fallbackUsage = 0;

  for (const log of logs) {
    bySource[log.credentialSource]++;
    uniqueUserIds.add(log.requestingUserId);

    if (log.requestingUserId !== log.credentialOwnerId) {
      fallbackUsage++;
    }
  }

  return {
    totalCalls: logs.length,
    bySource,
    fallbackUsage,
    uniqueUsers: uniqueUserIds.size,
  };
}
