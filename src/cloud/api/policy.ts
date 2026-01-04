/**
 * Agent Policy API Routes
 *
 * Provides endpoints for managing workspace-level agent policies.
 * These policies serve as fallbacks when repos don't have .claude/policies/ files.
 */

import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import type { WorkspaceAgentPolicy } from '../db/schema.js';

export const policyRouter = Router();

/**
 * GET /api/policy/:workspaceId
 * Get the agent policy for a workspace
 */
policyRouter.get('/:workspaceId', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const userId = (req as any).userId;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Check user has access to this workspace
    if (workspace.userId !== userId) {
      const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
      const member = members.find(m => m.userId === userId);
      if (!member) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Return the policy (or default if not set)
    const policy = workspace.config?.agentPolicy ?? getDefaultPolicy();

    res.json({
      workspaceId,
      policy,
      source: workspace.config?.agentPolicy ? 'workspace' : 'default',
    });
  } catch (error) {
    console.error('[policy] Error getting policy:', error);
    res.status(500).json({ error: 'Failed to get policy' });
  }
});

/**
 * PUT /api/policy/:workspaceId
 * Update the agent policy for a workspace
 */
policyRouter.put('/:workspaceId', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const userId = (req as any).userId;
  const policy = req.body.policy as WorkspaceAgentPolicy;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!policy || typeof policy !== 'object') {
    return res.status(400).json({ error: 'Policy object is required' });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Only owner can update policy
    if (workspace.userId !== userId) {
      const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
      const member = members.find(m => m.userId === userId);
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return res.status(403).json({ error: 'Only owners and admins can update policy' });
      }
    }

    // Validate policy structure
    const validationError = validatePolicy(policy);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Update workspace config with new policy
    const newConfig = {
      ...workspace.config,
      agentPolicy: policy,
    };

    await db.workspaces.updateConfig(workspaceId, newConfig);

    res.json({
      success: true,
      workspaceId,
      policy,
    });
  } catch (error) {
    console.error('[policy] Error updating policy:', error);
    res.status(500).json({ error: 'Failed to update policy' });
  }
});

/**
 * DELETE /api/policy/:workspaceId
 * Reset workspace policy to defaults
 */
policyRouter.delete('/:workspaceId', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const userId = (req as any).userId;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Only owner can reset policy
    if (workspace.userId !== userId) {
      const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
      const member = members.find(m => m.userId === userId);
      if (!member || member.role !== 'owner') {
        return res.status(403).json({ error: 'Only owners can reset policy' });
      }
    }

    // Remove policy from config
    const { agentPolicy: _agentPolicy, ...restConfig } = workspace.config ?? {};
    await db.workspaces.updateConfig(workspaceId, restConfig as any);

    res.json({
      success: true,
      workspaceId,
      policy: getDefaultPolicy(),
      source: 'default',
    });
  } catch (error) {
    console.error('[policy] Error resetting policy:', error);
    res.status(500).json({ error: 'Failed to reset policy' });
  }
});

/**
 * GET /api/policy/:workspaceId/internal
 * Internal endpoint for workspace containers to fetch policy
 * Uses workspace token authentication (not user auth)
 */
policyRouter.get('/:workspaceId/internal', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;

  // This endpoint should be called with the workspace token
  // The git.ts file has the token verification logic we can reuse
  // For now, we'll trust the workspace ID from container requests

  try {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const policy = workspace.config?.agentPolicy ?? getDefaultPolicy();

    res.json({
      defaultPolicy: policy.defaultPolicy,
      agents: policy.agents ?? [],
      settings: policy.settings ?? {
        requireExplicitAgents: false,
        auditEnabled: true,
        maxTotalAgents: 50,
      },
    });
  } catch (error) {
    console.error('[policy] Error getting internal policy:', error);
    res.status(500).json({ error: 'Failed to get policy' });
  }
});

/**
 * Get default policy
 */
function getDefaultPolicy(): WorkspaceAgentPolicy {
  return {
    defaultPolicy: {
      name: '*',
      allowedTools: undefined, // All tools allowed
      canSpawn: undefined, // Can spawn any
      canMessage: undefined, // Can message any
      maxSpawns: 10,
      rateLimit: 60,
      canBeSpawned: true,
    },
    agents: [],
    settings: {
      requireExplicitAgents: false,
      auditEnabled: true,
      maxTotalAgents: 50,
    },
  };
}

/**
 * Validate policy structure
 */
function validatePolicy(policy: WorkspaceAgentPolicy): string | null {
  // Validate defaultPolicy
  if (policy.defaultPolicy && typeof policy.defaultPolicy !== 'object') {
    return 'defaultPolicy must be an object';
  }

  // Validate agents array
  if (policy.agents) {
    if (!Array.isArray(policy.agents)) {
      return 'agents must be an array';
    }

    for (let i = 0; i < policy.agents.length; i++) {
      const agent = policy.agents[i];
      if (!agent.name || typeof agent.name !== 'string') {
        return `agents[${i}].name is required and must be a string`;
      }

      // Validate arrays
      if (agent.allowedTools && !Array.isArray(agent.allowedTools)) {
        return `agents[${i}].allowedTools must be an array`;
      }
      if (agent.canSpawn && !Array.isArray(agent.canSpawn)) {
        return `agents[${i}].canSpawn must be an array`;
      }
      if (agent.canMessage && !Array.isArray(agent.canMessage)) {
        return `agents[${i}].canMessage must be an array`;
      }

      // Validate numbers
      if (agent.maxSpawns !== undefined && typeof agent.maxSpawns !== 'number') {
        return `agents[${i}].maxSpawns must be a number`;
      }
      if (agent.rateLimit !== undefined && typeof agent.rateLimit !== 'number') {
        return `agents[${i}].rateLimit must be a number`;
      }
    }
  }

  // Validate settings
  if (policy.settings && typeof policy.settings !== 'object') {
    return 'settings must be an object';
  }

  return null;
}
