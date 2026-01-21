/**
 * Compliance API Routes
 *
 * Endpoints for checking and managing ToS compliance
 * for AI provider credentials in team workspaces.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import {
  checkWorkspaceCompliance,
  getMissingProviders,
  getUsageSummary,
  getCredentialPolicy,
  type ResolvedCredentialPolicy,
} from '../services/credential-router.js';
import type { WorkspaceCredentialPolicy } from '../db/schema.js';

export const complianceRouter = Router();

// All routes require authentication
complianceRouter.use(requireAuth);

/**
 * GET /api/compliance/workspace/:workspaceId
 * Get compliance status for a workspace
 */
complianceRouter.get('/workspace/:workspaceId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;

  try {
    // Check user has access to workspace
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Must be owner or admin to view compliance
    if (workspace.userId !== userId) {
      const member = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const compliance = await checkWorkspaceCompliance(workspaceId);
    const policy = getCredentialPolicy(workspace);
    const usageSummary = getUsageSummary(workspaceId);

    res.json({
      workspaceId,
      compliance,
      policy,
      usage: usageSummary,
    });
  } catch (error) {
    console.error('Error checking compliance:', error);
    res.status(500).json({ error: 'Failed to check compliance' });
  }
});

/**
 * GET /api/compliance/workspace/:workspaceId/members
 * Get credential status for all workspace members
 */
complianceRouter.get('/workspace/:workspaceId/members', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;

  try {
    // Check user has access to workspace
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Must be owner or admin to view member credentials
    if (workspace.userId !== userId) {
      const member = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
    const policy = getCredentialPolicy(workspace);

    const memberStatuses = await Promise.all(
      members.map(async (member) => {
        const user = await db.users.findById(member.userId);
        const missingProviders = await getMissingProviders(member.userId, workspaceId);
        const credentials = await db.credentials.findByUserAndWorkspace(member.userId, workspaceId);

        return {
          userId: member.userId,
          githubUsername: user?.githubUsername || 'unknown',
          role: member.role,
          connectedProviders: credentials.map((c) => c.provider),
          missingProviders,
          compliant: missingProviders.length === 0,
          requiresAction: missingProviders.some((p) => policy.requirePerUserAuth.includes(p)),
        };
      })
    );

    res.json({
      workspaceId,
      requiredProviders: policy.requirePerUserAuth,
      members: memberStatuses,
    });
  } catch (error) {
    console.error('Error getting member credentials:', error);
    res.status(500).json({ error: 'Failed to get member credentials' });
  }
});

/**
 * GET /api/compliance/me
 * Get current user's credential compliance status across all workspaces
 */
complianceRouter.get('/me', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    // Get all workspaces user is a member of
    const memberships = await db.workspaceMembers.findByUserId(userId);

    const workspaceStatuses = await Promise.all(
      memberships.map(async (membership) => {
        const workspace = await db.workspaces.findById(membership.workspaceId);
        if (!workspace) return null;

        const missingProviders = await getMissingProviders(userId, membership.workspaceId);
        const credentials = await db.credentials.findByUserAndWorkspace(userId, membership.workspaceId);

        return {
          workspaceId: membership.workspaceId,
          workspaceName: workspace.name,
          role: membership.role,
          connectedProviders: credentials.map((c) => c.provider),
          missingProviders,
          compliant: missingProviders.length === 0,
        };
      })
    );

    res.json({
      userId,
      workspaces: workspaceStatuses.filter(Boolean),
    });
  } catch (error) {
    console.error('Error getting user compliance:', error);
    res.status(500).json({ error: 'Failed to get compliance status' });
  }
});

/**
 * PATCH /api/compliance/workspace/:workspaceId/policy
 * Update workspace credential policy
 */
complianceRouter.patch('/workspace/:workspaceId/policy', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;
  const policyUpdate = req.body as Partial<WorkspaceCredentialPolicy>;

  try {
    // Check user owns the workspace
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Only workspace owner can update credential policy' });
    }

    // Validate policy fields
    const allowedFields = ['allowCredentialFallback', 'requirePerUserAuth', 'auditCredentialUsage'];
    const invalidFields = Object.keys(policyUpdate).filter((k) => !allowedFields.includes(k));
    if (invalidFields.length > 0) {
      return res.status(400).json({ error: `Invalid policy fields: ${invalidFields.join(', ')}` });
    }

    // Update workspace config
    const currentConfig = (workspace.config || {}) as Record<string, unknown>;
    const currentPolicy = (currentConfig.credentialPolicy || {}) as Partial<WorkspaceCredentialPolicy>;

    const newPolicy: Partial<WorkspaceCredentialPolicy> = {
      ...currentPolicy,
      ...policyUpdate,
    };

    await db.workspaces.update(workspaceId, {
      config: {
        ...currentConfig,
        credentialPolicy: newPolicy,
      },
    });

    res.json({
      success: true,
      policy: getCredentialPolicy({ config: { credentialPolicy: newPolicy } }),
    });
  } catch (error) {
    console.error('Error updating credential policy:', error);
    res.status(500).json({ error: 'Failed to update policy' });
  }
});

/**
 * POST /api/compliance/workspace/:workspaceId/notify
 * Send notification to team members about missing credentials
 */
complianceRouter.post('/workspace/:workspaceId/notify', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;
  const { memberIds } = req.body as { memberIds?: string[] };

  try {
    // Check user owns the workspace
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      const member = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!member || member.role !== 'admin') {
        return res.status(403).json({ error: 'Only owners and admins can send notifications' });
      }
    }

    // Get members to notify
    const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
    const targetMembers = memberIds
      ? members.filter((m) => memberIds.includes(m.userId))
      : members.filter((m) => m.role !== 'owner');

    const notifications: { userId: string; missingProviders: string[] }[] = [];

    for (const member of targetMembers) {
      const missingProviders = await getMissingProviders(member.userId, workspaceId);
      if (missingProviders.length > 0) {
        notifications.push({
          userId: member.userId,
          missingProviders,
        });

        // TODO: Send actual notification (email, in-app, etc.)
        console.log(
          `[compliance] Would notify user ${member.userId} about missing providers: ${missingProviders.join(', ')}`
        );
      }
    }

    res.json({
      success: true,
      notified: notifications.length,
      details: notifications,
      note: 'Email notifications are not yet implemented',
    });
  } catch (error) {
    console.error('Error sending notifications:', error);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});
