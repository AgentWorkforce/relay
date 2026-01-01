/**
 * Coordinator Agent API Routes
 *
 * Manage coordinator agents for project groups.
 * Coordinators oversee and orchestrate work across repositories in a group.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { checkCoordinatorAccess } from './middleware/planLimits.js';
import { db, CoordinatorAgentConfig } from '../db/index.js';
import {
  getCoordinatorService,
  sendToWorkspace,
  broadcastToGroup,
  routeToCoordinator,
  getActiveCoordinators,
} from '../services/coordinator.js';

export const coordinatorsRouter = Router();

// All routes require authentication
coordinatorsRouter.use(requireAuth);

// Coordinator modification routes require Pro plan or higher
const coordinatorWriteRoutes = [
  '/:groupId/coordinator/enable',
  '/:groupId/coordinator/disable',
];
coordinatorWriteRoutes.forEach(route => {
  coordinatorsRouter.use(route, checkCoordinatorAccess);
});

/**
 * GET /api/project-groups/:groupId/coordinator
 * Get coordinator agent configuration
 */
coordinatorsRouter.get('/:groupId/coordinator', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json({
      groupId: group.id,
      groupName: group.name,
      coordinator: group.coordinatorAgent || { enabled: false },
    });
  } catch (error) {
    console.error('Error getting coordinator config:', error);
    res.status(500).json({ error: 'Failed to get coordinator configuration' });
  }
});

/**
 * PUT /api/project-groups/:groupId/coordinator
 * Update coordinator agent configuration
 */
coordinatorsRouter.put('/:groupId/coordinator', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;
  const { name, model, systemPrompt, capabilities } = req.body;

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Build updated config, preserving enabled state
    const currentConfig = group.coordinatorAgent || { enabled: false };
    const updatedConfig: CoordinatorAgentConfig = {
      enabled: currentConfig.enabled,
      name: name !== undefined ? name : currentConfig.name,
      model: model !== undefined ? model : currentConfig.model,
      systemPrompt: systemPrompt !== undefined ? systemPrompt : currentConfig.systemPrompt,
      capabilities: capabilities !== undefined ? capabilities : currentConfig.capabilities,
    };

    await db.projectGroups.updateCoordinatorAgent(groupId, updatedConfig);

    // If coordinator is currently enabled, restart it with new config
    if (updatedConfig.enabled) {
      const coordinatorService = getCoordinatorService();
      await coordinatorService.restart(groupId);
    }

    res.json({
      success: true,
      coordinator: updatedConfig,
    });
  } catch (error) {
    console.error('Error updating coordinator config:', error);
    res.status(500).json({ error: 'Failed to update coordinator configuration' });
  }
});

/**
 * POST /api/project-groups/:groupId/coordinator/enable
 * Enable coordinator agent for a project group
 */
coordinatorsRouter.post('/:groupId/coordinator/enable', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Plan check is handled by checkCoordinatorAccess middleware

    // Get repositories in the group
    const repositories = await db.repositories.findByProjectGroupId(groupId);

    if (repositories.length === 0) {
      return res.status(400).json({
        error: 'Cannot enable coordinator for empty group',
        message: 'Add at least one repository to this group first',
      });
    }

    // Enable coordinator
    const currentConfig = group.coordinatorAgent || { enabled: false };
    const updatedConfig: CoordinatorAgentConfig = {
      ...currentConfig,
      enabled: true,
      name: currentConfig.name || `${group.name} Coordinator`,
    };

    await db.projectGroups.updateCoordinatorAgent(groupId, updatedConfig);

    // Start the coordinator agent
    const coordinatorService = getCoordinatorService();
    await coordinatorService.start(groupId);

    res.json({
      success: true,
      message: 'Coordinator agent enabled',
      coordinator: updatedConfig,
    });
  } catch (error) {
    console.error('Error enabling coordinator:', error);
    res.status(500).json({ error: 'Failed to enable coordinator agent' });
  }
});

/**
 * POST /api/project-groups/:groupId/coordinator/disable
 * Disable coordinator agent for a project group
 */
coordinatorsRouter.post('/:groupId/coordinator/disable', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Disable coordinator
    const currentConfig = group.coordinatorAgent || { enabled: false };
    const updatedConfig: CoordinatorAgentConfig = {
      ...currentConfig,
      enabled: false,
    };

    await db.projectGroups.updateCoordinatorAgent(groupId, updatedConfig);

    // Stop the coordinator agent
    const coordinatorService = getCoordinatorService();
    await coordinatorService.stop(groupId);

    res.json({
      success: true,
      message: 'Coordinator agent disabled',
      coordinator: updatedConfig,
    });
  } catch (error) {
    console.error('Error disabling coordinator:', error);
    res.status(500).json({ error: 'Failed to disable coordinator agent' });
  }
});

/**
 * GET /api/project-groups/coordinators/active
 * List all active coordinators for the user
 */
coordinatorsRouter.get('/coordinators/active', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    // Get all coordinators
    const activeCoordinators = await getActiveCoordinators();

    // Filter to only user's project groups
    const userGroups = await db.projectGroups.findByUserId(userId);
    const userGroupIds = new Set(userGroups.map((g) => g.id));

    const userCoordinators = activeCoordinators.filter((c) =>
      userGroupIds.has(c.groupId)
    );

    res.json({
      coordinators: userCoordinators,
    });
  } catch (error) {
    console.error('Error listing active coordinators:', error);
    res.status(500).json({ error: 'Failed to list coordinators' });
  }
});

/**
 * POST /api/project-groups/:groupId/coordinator/message
 * Send a message from coordinator to a specific workspace/agent
 */
coordinatorsRouter.post('/:groupId/coordinator/message', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;
  const { workspaceId, agentName, message, thread } = req.body;

  if (!workspaceId || !agentName || !message) {
    return res.status(400).json({
      error: 'workspaceId, agentName, and message are required',
    });
  }

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!group.coordinatorAgent?.enabled) {
      return res.status(400).json({ error: 'Coordinator is not enabled' });
    }

    await sendToWorkspace(groupId, workspaceId, agentName, message, thread);

    res.json({
      success: true,
      message: 'Message sent',
    });
  } catch (error) {
    console.error('Error sending coordinator message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/project-groups/:groupId/coordinator/broadcast
 * Broadcast a message from coordinator to all workspaces in the group
 */
coordinatorsRouter.post('/:groupId/coordinator/broadcast', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;
  const { message, thread } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!group.coordinatorAgent?.enabled) {
      return res.status(400).json({ error: 'Coordinator is not enabled' });
    }

    await broadcastToGroup(groupId, message, thread);

    res.json({
      success: true,
      message: 'Broadcast sent',
    });
  } catch (error) {
    console.error('Error broadcasting coordinator message:', error);
    res.status(500).json({ error: 'Failed to broadcast message' });
  }
});

/**
 * POST /api/project-groups/coordinator/route
 * Route a message from a workspace to its coordinator
 * (Called by workspace daemons)
 */
coordinatorsRouter.post('/coordinator/route', async (req: Request, res: Response) => {
  const { workspaceId, agentName, message, thread } = req.body;

  if (!workspaceId || !agentName || !message) {
    return res.status(400).json({
      error: 'workspaceId, agentName, and message are required',
    });
  }

  try {
    // Verify workspace exists and get its owner
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    await routeToCoordinator(workspaceId, agentName, message, thread);

    res.json({
      success: true,
      message: 'Message routed to coordinator',
    });
  } catch (error) {
    console.error('Error routing to coordinator:', error);
    res.status(500).json({ error: 'Failed to route message' });
  }
});

/**
 * GET /api/project-groups/:groupId/coordinator/status
 * Get detailed coordinator status including connected workspaces
 */
coordinatorsRouter.get('/:groupId/coordinator/status', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { groupId } = req.params;

  try {
    const group = await db.projectGroups.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: 'Project group not found' });
    }

    if (group.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const coordinatorService = getCoordinatorService();
    const status = await coordinatorService.getStatus(groupId);

    // Get connected workspaces info
    const repositories = await db.repositories.findByProjectGroupId(groupId);
    const workspaceIds = new Set<string>();
    for (const repo of repositories) {
      if (repo.workspaceId) {
        workspaceIds.add(repo.workspaceId);
      }
    }

    const workspaces = await Promise.all(
      Array.from(workspaceIds).map(async (id) => {
        const ws = await db.workspaces.findById(id);
        return ws
          ? {
              id: ws.id,
              name: ws.name,
              status: ws.status,
              publicUrl: ws.publicUrl,
            }
          : null;
      })
    );

    res.json({
      groupId,
      groupName: group.name,
      coordinator: {
        enabled: group.coordinatorAgent?.enabled || false,
        name: group.coordinatorAgent?.name,
        model: group.coordinatorAgent?.model,
        status: status?.status || 'stopped',
        startedAt: status?.startedAt,
        error: status?.error,
      },
      workspaces: workspaces.filter(Boolean),
      repositoryCount: repositories.length,
    });
  } catch (error) {
    console.error('Error getting coordinator status:', error);
    res.status(500).json({ error: 'Failed to get coordinator status' });
  }
});
