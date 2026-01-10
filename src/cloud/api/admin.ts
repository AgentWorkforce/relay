/**
 * Admin API Routes
 *
 * Administrative endpoints for managing workspaces at scale.
 * Protected by admin secret (ADMIN_API_SECRET environment variable).
 */

import { Router, Request, Response } from 'express';
import { getConfig } from '../config.js';
import { getProvisioner, WorkspaceProvisioner } from '../provisioner/index.js';

export const adminRouter = Router();

/**
 * Middleware to authenticate admin requests
 * Requires ADMIN_API_SECRET header to match environment variable
 */
async function requireAdminAuth(
  req: Request,
  res: Response,
  next: () => void
): Promise<void> {
  const authHeader = req.headers['x-admin-secret'] || req.headers.authorization;
  const adminSecret = process.env.ADMIN_API_SECRET;

  if (!adminSecret) {
    res.status(503).json({ error: 'Admin API not configured' });
    return;
  }

  // Support both x-admin-secret header and Bearer token
  const providedSecret = authHeader?.toString().replace('Bearer ', '');

  if (!providedSecret || providedSecret !== adminSecret) {
    res.status(401).json({ error: 'Invalid admin credentials' });
    return;
  }

  next();
}

// Apply admin auth to all routes
adminRouter.use(requireAdminAuth);

/**
 * POST /api/admin/workspaces/update-image
 *
 * Gracefully update workspace images across all or specific workspaces.
 *
 * Request body:
 * - image: New Docker image to deploy (required)
 * - workspaceIds?: Array of specific workspace IDs to update
 * - userIds?: Array of user IDs whose workspaces to update
 * - force?: Force update even if agents are active (default: false)
 * - skipRestart?: Update config without restarting (default: false)
 * - batchSize?: Number of concurrent updates (default: 5)
 *
 * Response:
 * - summary: { total, updated, pendingRestart, skippedActiveAgents, skippedVerificationFailed, skippedNotRunning, errors }
 * - results: Array of per-workspace results
 */
adminRouter.post('/workspaces/update-image', async (req: Request, res: Response) => {
  const {
    image,
    workspaceIds,
    userIds,
    force = false,
    skipRestart = false,
    batchSize = 5,
  } = req.body as {
    image: string;
    workspaceIds?: string[];
    userIds?: string[];
    force?: boolean;
    skipRestart?: boolean;
    batchSize?: number;
  };

  if (!image) {
    res.status(400).json({ error: 'image is required' });
    return;
  }

  console.log(`[admin] Starting workspace image update to ${image}`, {
    workspaceIds: workspaceIds?.length ?? 'all',
    userIds: userIds?.length ?? 'all',
    force,
    skipRestart,
    batchSize,
  });

  try {
    const provisioner = getProvisioner();
    const result = await provisioner.gracefulUpdateAllImages(image, {
      workspaceIds,
      userIds,
      force,
      skipRestart,
      batchSize,
    });

    res.json(result);
  } catch (error) {
    console.error('[admin] Error updating workspace images:', error);
    res.status(500).json({
      error: 'Failed to update workspace images',
      details: (error as Error).message,
    });
  }
});

/**
 * POST /api/admin/workspaces/:id/update-image
 *
 * Gracefully update a single workspace's image.
 *
 * Request body:
 * - image: New Docker image to deploy (required)
 * - force?: Force update even if agents are active (default: false)
 * - skipRestart?: Update config without restarting (default: false)
 *
 * Response:
 * - result: Update result code
 * - workspaceId: Workspace ID
 * - machineState?: Current machine state
 * - agentCount?: Number of active agents (if applicable)
 * - error?: Error message (if applicable)
 */
adminRouter.post('/workspaces/:id/update-image', async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    image,
    force = false,
    skipRestart = false,
  } = req.body as {
    image: string;
    force?: boolean;
    skipRestart?: boolean;
  };

  if (!image) {
    res.status(400).json({ error: 'image is required' });
    return;
  }

  console.log(`[admin] Updating workspace ${id} image to ${image}`, { force, skipRestart });

  try {
    const provisioner = getProvisioner();
    const result = await provisioner.gracefulUpdateImage(id, image, {
      force,
      skipRestart,
    });

    // Return appropriate status code based on result
    if (result.result === WorkspaceProvisioner.UpdateResult.ERROR) {
      res.status(500).json(result);
    } else if (result.result === WorkspaceProvisioner.UpdateResult.NOT_SUPPORTED) {
      res.status(400).json(result);
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error(`[admin] Error updating workspace ${id}:`, error);
    res.status(500).json({
      error: 'Failed to update workspace image',
      details: (error as Error).message,
    });
  }
});

/**
 * GET /api/admin/workspaces/:id/agents
 *
 * Check active agents in a workspace.
 * Useful for pre-flight checks before updates.
 *
 * Response:
 * - hasActiveAgents: boolean
 * - agentCount: number
 * - agents: Array of { name, status }
 */
adminRouter.get('/workspaces/:id/agents', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    // Query workspace directly from DB and check agents via daemon API
    const workspace = await (await import('../db/index.js')).db.workspaces.findById(id);

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    if (workspace.computeProvider !== 'fly') {
      res.status(400).json({ error: 'Only Fly.io workspaces support agent checking' });
      return;
    }

    // Query the workspace daemon directly
    const baseUrl = workspace.publicUrl;
    if (!baseUrl) {
      res.json({ hasActiveAgents: false, agentCount: 0, agents: [] });
      return;
    }

    try {
      // Use /api/data endpoint which returns { agents: [...], ... }
      // Note: /api/agents doesn't exist on the workspace dashboard-server
      const response = await fetch(`${baseUrl}/api/data`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        res.json({ hasActiveAgents: false, agentCount: 0, agents: [], error: `Daemon returned ${response.status}` });
        return;
      }

      const data = await response.json() as {
        agents: Array<{ name: string; status: string; activityState?: string }>;
      };

      const agents = data.agents || [];
      const activeAgents = agents.filter(a =>
        a.status === 'running' || a.activityState === 'active' || a.activityState === 'idle'
      );

      res.json({
        hasActiveAgents: activeAgents.length > 0,
        agentCount: activeAgents.length,
        agents: agents.map(a => ({ name: a.name, status: a.status || a.activityState || 'unknown' })),
      });
    } catch (error) {
      // Workspace might be stopped
      res.json({
        hasActiveAgents: false,
        agentCount: 0,
        agents: [],
        error: `Could not reach workspace: ${(error as Error).message}`,
      });
    }
  } catch (error) {
    console.error(`[admin] Error checking agents for workspace ${id}:`, error);
    res.status(500).json({
      error: 'Failed to check workspace agents',
      details: (error as Error).message,
    });
  }
});

/**
 * GET /api/admin/health
 *
 * Health check for admin API.
 */
adminRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      computeProvider: getConfig().compute.provider,
    },
  });
});
