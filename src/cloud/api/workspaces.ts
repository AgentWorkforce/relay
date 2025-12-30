/**
 * Workspaces API Routes
 *
 * One-click workspace provisioning and management.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth';
import { db } from '../db';
import { getProvisioner, ProvisionConfig } from '../provisioner';

export const workspacesRouter = Router();

// All routes require authentication
workspacesRouter.use(requireAuth);

/**
 * GET /api/workspaces
 * List user's workspaces
 */
workspacesRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const workspaces = await db.workspaces.findByUserId(userId);

    res.json({
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        publicUrl: w.publicUrl,
        providers: w.config.providers,
        repositories: w.config.repositories,
        createdAt: w.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing workspaces:', error);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

/**
 * POST /api/workspaces
 * Create (provision) a new workspace
 */
workspacesRouter.post('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, providers, repositories, supervisorEnabled, maxAgents } = req.body;

  // Validation
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (!providers || !Array.isArray(providers) || providers.length === 0) {
    return res.status(400).json({ error: 'At least one provider is required' });
  }

  if (!repositories || !Array.isArray(repositories)) {
    return res.status(400).json({ error: 'Repositories array is required' });
  }

  // Verify user has credentials for all providers
  const credentials = await db.credentials.findByUserId(userId);
  const connectedProviders = new Set(credentials.map((c) => c.provider));

  for (const provider of providers) {
    if (!connectedProviders.has(provider)) {
      return res.status(400).json({
        error: `Provider ${provider} not connected. Please connect it first.`,
      });
    }
  }

  try {
    const provisioner = getProvisioner();
    const result = await provisioner.provision({
      userId,
      name,
      providers,
      repositories,
      supervisorEnabled,
      maxAgents,
    });

    if (result.status === 'error') {
      return res.status(500).json({
        error: 'Failed to provision workspace',
        details: result.error,
      });
    }

    res.status(201).json({
      workspaceId: result.workspaceId,
      status: result.status,
      publicUrl: result.publicUrl,
    });
  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

/**
 * GET /api/workspaces/:id
 * Get workspace details
 */
workspacesRouter.get('/:id', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Get repositories assigned to this workspace
    const repositories = await db.repositories.findByWorkspaceId(id);

    res.json({
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
      publicUrl: workspace.publicUrl,
      computeProvider: workspace.computeProvider,
      config: workspace.config,
      errorMessage: workspace.errorMessage,
      repositories: repositories.map((r) => ({
        id: r.id,
        fullName: r.githubFullName,
        syncStatus: r.syncStatus,
        lastSyncedAt: r.lastSyncedAt,
      })),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  } catch (error) {
    console.error('Error getting workspace:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

/**
 * GET /api/workspaces/:id/status
 * Get current workspace status (polls compute provider)
 */
workspacesRouter.get('/:id/status', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    const status = await provisioner.getStatus(id);

    res.json({ status });
  } catch (error) {
    console.error('Error getting workspace status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /api/workspaces/:id/restart
 * Restart a workspace
 */
workspacesRouter.post('/:id/restart', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    await provisioner.restart(id);

    res.json({ success: true, message: 'Workspace restarting' });
  } catch (error) {
    console.error('Error restarting workspace:', error);
    res.status(500).json({ error: 'Failed to restart workspace' });
  }
});

/**
 * POST /api/workspaces/:id/stop
 * Stop a workspace
 */
workspacesRouter.post('/:id/stop', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    await provisioner.stop(id);

    res.json({ success: true, message: 'Workspace stopped' });
  } catch (error) {
    console.error('Error stopping workspace:', error);
    res.status(500).json({ error: 'Failed to stop workspace' });
  }
});

/**
 * DELETE /api/workspaces/:id
 * Delete (deprovision) a workspace
 */
workspacesRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    await provisioner.deprovision(id);

    res.json({ success: true, message: 'Workspace deleted' });
  } catch (error) {
    console.error('Error deleting workspace:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

/**
 * POST /api/workspaces/:id/repos
 * Add repositories to a workspace
 */
workspacesRouter.post('/:id/repos', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { repositoryIds } = req.body;

  if (!repositoryIds || !Array.isArray(repositoryIds)) {
    return res.status(400).json({ error: 'repositoryIds array is required' });
  }

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Assign repositories to workspace
    for (const repoId of repositoryIds) {
      await db.repositories.assignToWorkspace(repoId, id);
    }

    res.json({ success: true, message: 'Repositories added' });
  } catch (error) {
    console.error('Error adding repos to workspace:', error);
    res.status(500).json({ error: 'Failed to add repositories' });
  }
});

/**
 * POST /api/workspaces/quick
 * Quick provision: one-click with defaults
 */
workspacesRouter.post('/quick', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, repositoryFullName } = req.body;

  if (!repositoryFullName) {
    return res.status(400).json({ error: 'Repository name is required' });
  }

  try {
    // Get user's connected providers
    const credentials = await db.credentials.findByUserId(userId);
    const providers = credentials
      .filter((c) => c.provider !== 'github')
      .map((c) => c.provider);

    if (providers.length === 0) {
      return res.status(400).json({
        error: 'No AI providers connected. Please connect at least one provider.',
      });
    }

    // Create workspace with defaults
    const provisioner = getProvisioner();
    const workspaceName = name || `Workspace for ${repositoryFullName}`;

    const result = await provisioner.provision({
      userId,
      name: workspaceName,
      providers,
      repositories: [repositoryFullName],
      supervisorEnabled: true,
      maxAgents: 10,
    });

    if (result.status === 'error') {
      return res.status(500).json({
        error: 'Failed to provision workspace',
        details: result.error,
      });
    }

    res.status(201).json({
      workspaceId: result.workspaceId,
      status: result.status,
      publicUrl: result.publicUrl,
      message: 'Workspace provisioned successfully!',
    });
  } catch (error) {
    console.error('Error quick provisioning:', error);
    res.status(500).json({ error: 'Failed to provision workspace' });
  }
});
