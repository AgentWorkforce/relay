/**
 * Cloud Policy Fetcher
 *
 * Fetches workspace agent policies from the cloud API.
 * Used by workspace containers to get their policy configuration.
 */

import type { CloudPolicyFetcher, WorkspacePolicy, AgentPolicy } from './agent-policy.js';

/**
 * Create a cloud policy fetcher for workspace containers
 */
export function createCloudPolicyFetcher(): CloudPolicyFetcher | null {
  const cloudApiUrl = process.env.CLOUD_API_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const workspaceToken = process.env.WORKSPACE_TOKEN;

  if (!cloudApiUrl || !workspaceId) {
    return null;
  }

  return {
    async getWorkspacePolicy(requestedWorkspaceId: string): Promise<WorkspacePolicy | null> {
      // Only allow fetching policy for this workspace
      if (requestedWorkspaceId !== workspaceId) {
        console.warn(`[policy-fetcher] Attempted to fetch policy for different workspace: ${requestedWorkspaceId}`);
        return null;
      }

      try {
        const url = `${cloudApiUrl}/api/policy/${workspaceId}/internal`;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // Add auth header if we have a workspace token
        if (workspaceToken) {
          headers['Authorization'] = `Bearer ${workspaceToken}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
          console.error(`[policy-fetcher] Failed to fetch policy: ${response.status} ${response.statusText}`);
          return null;
        }

        const data = await response.json() as {
          defaultPolicy?: AgentPolicy;
          agents?: AgentPolicy[];
          settings?: WorkspacePolicy['settings'];
        };

        // Convert API response to WorkspacePolicy
        const policy: WorkspacePolicy = {
          defaultPolicy: data.defaultPolicy ?? {
            name: '*',
            maxSpawns: 10,
            rateLimit: 60,
            canBeSpawned: true,
          },
          agents: data.agents ?? [],
          settings: data.settings ?? {
            requireExplicitAgents: false,
            auditEnabled: true,
            maxTotalAgents: 50,
          },
        };

        console.log(`[policy-fetcher] Fetched policy for workspace ${workspaceId}: ${policy.agents.length} agent rules`);
        return policy;
      } catch (error) {
        console.error('[policy-fetcher] Error fetching policy:', error);
        return null;
      }
    },
  };
}
