/**
 * Workspaces API Routes
 *
 * One-click workspace provisioning and management.
 * Includes auto-access based on GitHub repo permissions.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.js';
import { db, Workspace } from '../db/index.js';
import { getProvisioner, getProvisioningStage } from '../provisioner/index.js';
import { checkWorkspaceLimit } from './middleware/planLimits.js';
import { getConfig } from '../config.js';
import { nangoService } from '../services/nango.js';

// ============================================================================
// Workspace Access Cache
// ============================================================================

interface CachedAccess {
  hasAccess: boolean;
  accessType: 'owner' | 'member' | 'contributor' | 'none';
  permission?: 'admin' | 'write' | 'read';
  cachedAt: number;
}

// Simple in-memory cache for workspace access checks
// Key: `${userId}:${workspaceId}`
const workspaceAccessCache = new Map<string, CachedAccess>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedAccess(userId: string, workspaceId: string): CachedAccess | null {
  const key = `${userId}:${workspaceId}`;
  const cached = workspaceAccessCache.get(key);
  if (!cached) return null;

  // Check if expired
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    workspaceAccessCache.delete(key);
    return null;
  }

  return cached;
}

function setCachedAccess(userId: string, workspaceId: string, access: Omit<CachedAccess, 'cachedAt'>): void {
  const key = `${userId}:${workspaceId}`;
  workspaceAccessCache.set(key, { ...access, cachedAt: Date.now() });
}

function _invalidateCachedAccess(userId: string, workspaceId?: string): void {
  if (workspaceId) {
    workspaceAccessCache.delete(`${userId}:${workspaceId}`);
  } else {
    // Invalidate all cache entries for this user
    for (const key of workspaceAccessCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        workspaceAccessCache.delete(key);
      }
    }
  }
}

// ============================================================================
// Workspace Access Middleware
// ============================================================================

/**
 * Check if user has access to a workspace via:
 * 1. Workspace ownership (userId matches)
 * 2. Explicit workspace_members record
 * 3. GitHub repo access (just-in-time check via Nango)
 */
export async function checkWorkspaceAccess(
  userId: string,
  workspaceId: string
): Promise<{ hasAccess: boolean; accessType: 'owner' | 'member' | 'contributor' | 'none'; permission?: 'admin' | 'write' | 'read' }> {
  // Check cache first
  const cached = getCachedAccess(userId, workspaceId);
  if (cached) {
    return { hasAccess: cached.hasAccess, accessType: cached.accessType, permission: cached.permission };
  }

  // 1. Check if user is workspace owner
  const workspace = await db.workspaces.findById(workspaceId);
  if (!workspace) {
    return { hasAccess: false, accessType: 'none' };
  }

  if (workspace.userId === userId) {
    setCachedAccess(userId, workspaceId, { hasAccess: true, accessType: 'owner', permission: 'admin' });
    return { hasAccess: true, accessType: 'owner', permission: 'admin' };
  }

  // 2. Check explicit workspace_members
  const member = await db.workspaceMembers.findMembership(workspaceId, userId);
  if (member && member.acceptedAt) {
    const permission = member.role === 'admin' ? 'admin' : member.role === 'member' ? 'write' : 'read';
    setCachedAccess(userId, workspaceId, { hasAccess: true, accessType: 'member', permission });
    return { hasAccess: true, accessType: 'member', permission };
  }

  // 3. Check GitHub repo access (just-in-time)
  const user = await db.users.findById(userId);
  if (!user?.nangoConnectionId) {
    setCachedAccess(userId, workspaceId, { hasAccess: false, accessType: 'none' });
    return { hasAccess: false, accessType: 'none' };
  }

  const repos = await db.repositories.findByWorkspaceId(workspaceId);
  if (repos.length === 0) {
    setCachedAccess(userId, workspaceId, { hasAccess: false, accessType: 'none' });
    return { hasAccess: false, accessType: 'none' };
  }

  // Check if user has access to ANY repo in this workspace
  for (const repo of repos) {
    try {
      const [owner, repoName] = repo.githubFullName.split('/');
      const accessResult = await nangoService.checkUserRepoAccess(
        user.nangoConnectionId,
        owner,
        repoName
      );

      if (accessResult.hasAccess && accessResult.permission && accessResult.permission !== 'none') {
        setCachedAccess(userId, workspaceId, {
          hasAccess: true,
          accessType: 'contributor',
          permission: accessResult.permission
        });
        return { hasAccess: true, accessType: 'contributor', permission: accessResult.permission };
      }
    } catch (err) {
      // Continue to next repo on error
      console.warn(`[workspace-access] Failed to check repo access for ${repo.githubFullName}:`, err);
    }
  }

  // No access found
  setCachedAccess(userId, workspaceId, { hasAccess: false, accessType: 'none' });
  return { hasAccess: false, accessType: 'none' };
}

/**
 * Middleware to require workspace access.
 * Checks ownership, membership, or GitHub repo access.
 */
export function requireWorkspaceAccess(req: Request, res: Response, next: NextFunction): void {
  const userId = req.session.userId;
  const workspaceId = req.params.id || req.params.workspaceId;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!workspaceId) {
    res.status(400).json({ error: 'Workspace ID required' });
    return;
  }

  checkWorkspaceAccess(userId, workspaceId)
    .then((result) => {
      if (result.hasAccess) {
        // Attach access info to request for downstream use
        (req as any).workspaceAccess = {
          accessType: result.accessType,
          permission: result.permission,
        };
        next();
      } else {
        res.status(403).json({ error: 'No access to this workspace' });
      }
    })
    .catch((err) => {
      console.error('[workspace-access] Error checking access:', err);
      res.status(500).json({ error: 'Failed to check workspace access' });
    });
}

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
workspacesRouter.post('/', checkWorkspaceLimit, async (req: Request, res: Response) => {
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
 * GET /api/workspaces/summary
 * Get summary of all user workspaces for dashboard status indicator
 * NOTE: This route MUST be before /:id to avoid being caught by parameterized route
 */
workspacesRouter.get('/summary', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const workspaces = await db.workspaces.findByUserId(userId);
    const provisioner = getProvisioner();

    // Get live status for each workspace
    const workspaceSummaries = await Promise.all(
      workspaces.map(async (w) => {
        let liveStatus = w.status;
        try {
          liveStatus = await provisioner.getStatus(w.id);
        } catch {
          // Fall back to DB status
        }

        return {
          id: w.id,
          name: w.name,
          status: liveStatus,
          publicUrl: w.publicUrl,
          isStopped: liveStatus === 'stopped',
          isRunning: liveStatus === 'running',
          isProvisioning: liveStatus === 'provisioning',
          hasError: liveStatus === 'error',
        };
      })
    );

    // Overall status for quick dashboard indicator
    const hasRunningWorkspace = workspaceSummaries.some(w => w.isRunning);
    const hasStoppedWorkspace = workspaceSummaries.some(w => w.isStopped);
    const hasProvisioningWorkspace = workspaceSummaries.some(w => w.isProvisioning);

    res.json({
      workspaces: workspaceSummaries,
      summary: {
        total: workspaceSummaries.length,
        running: workspaceSummaries.filter(w => w.isRunning).length,
        stopped: workspaceSummaries.filter(w => w.isStopped).length,
        provisioning: workspaceSummaries.filter(w => w.isProvisioning).length,
        error: workspaceSummaries.filter(w => w.hasError).length,
      },
      overallStatus: hasRunningWorkspace
        ? 'ready'
        : hasProvisioningWorkspace
          ? 'provisioning'
          : hasStoppedWorkspace
            ? 'stopped'
            : workspaceSummaries.length === 0
              ? 'none'
              : 'error',
    });
  } catch (error) {
    console.error('Error getting workspace summary:', error);
    res.status(500).json({ error: 'Failed to get workspace summary' });
  }
});

/**
 * GET /api/workspaces/primary
 * Get the user's primary workspace (first/default) with live status
 * Used by dashboard to show quick status indicator
 * NOTE: This route MUST be before /:id to avoid being caught by parameterized route
 */
workspacesRouter.get('/primary', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const workspaces = await db.workspaces.findByUserId(userId);

    if (workspaces.length === 0) {
      return res.json({
        exists: false,
        message: 'No workspace found. Connect a repository to auto-provision one.',
      });
    }

    const primary = workspaces[0];
    const provisioner = getProvisioner();

    let liveStatus = primary.status;
    try {
      liveStatus = await provisioner.getStatus(primary.id);
    } catch {
      // Fall back to DB status
    }

    res.json({
      exists: true,
      workspace: {
        id: primary.id,
        name: primary.name,
        status: liveStatus,
        publicUrl: primary.publicUrl,
        isStopped: liveStatus === 'stopped',
        isRunning: liveStatus === 'running',
        isProvisioning: liveStatus === 'provisioning',
        hasError: liveStatus === 'error',
        config: {
          providers: primary.config.providers || [],
          repositories: primary.config.repositories || [],
        },
      },
      // Quick messages for UI
      statusMessage: liveStatus === 'running'
        ? 'Workspace is running'
        : liveStatus === 'stopped'
          ? 'Workspace is idle (will start automatically when needed)'
          : liveStatus === 'provisioning'
            ? 'Workspace is being provisioned...'
            : 'Workspace has an error',
      actionNeeded: liveStatus === 'stopped'
        ? 'wakeup'
        : liveStatus === 'error'
          ? 'check_error'
          : null,
    });
  } catch (error) {
    console.error('Error getting primary workspace:', error);
    res.status(500).json({ error: 'Failed to get primary workspace' });
  }
});

/**
 * GET /api/workspaces/accessible
 * List all workspaces the user can access:
 * - Owned workspaces
 * - Workspaces where user is a member
 * - Workspaces with repos the user has GitHub access to
 * NOTE: This route MUST be before /:id to avoid being caught by parameterized route
 */
workspacesRouter.get('/accessible', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 1. Get owned workspaces
    const ownedWorkspaces = await db.workspaces.findByUserId(userId);

    // 2. Get workspaces where user is a member
    const memberships = await db.workspaceMembers.findByUserId(userId);
    const memberWorkspaceIds = memberships.map((m) => m.workspaceId);

    // Fetch member workspaces
    const memberWorkspaces: Workspace[] = [];
    for (const wsId of memberWorkspaceIds) {
      const ws = await db.workspaces.findById(wsId);
      if (ws) memberWorkspaces.push(ws);
    }

    // 3. Get workspaces via GitHub repo access (if user has Nango connection)
    const contributorWorkspaces: Array<Workspace & { accessPermission: string }> = [];

    if (user.nangoConnectionId) {
      // Get all repos user has access to via GitHub
      try {
        const reposResult = await nangoService.listUserAccessibleRepos(user.nangoConnectionId, {
          perPage: 100,
          type: 'all',
        });

        // Find workspaces that contain these repos
        const _accessibleRepoNames = new Set(reposResult.repositories.map((r) => r.fullName));

        // Get all repos in the system
        const _allRepos = await db.repositories.findByUserId(userId); // Will need to expand this

        // Actually, we need a different approach - get all workspaces with their repos
        // and check if user has access to any of them

        // For now, get all workspaces (this is expensive but works for MVP)
        // In production, we'd want a more efficient query

        // Get workspaces that aren't owned or membered
        const knownWorkspaceIds = new Set([
          ...ownedWorkspaces.map((w) => w.id),
          ...memberWorkspaceIds,
        ]);

        // Query for workspaces with repos the user can access
        // This requires checking each workspace's repos against user's accessible repos
        // For efficiency, we'll limit this to workspaces with repos that match

        // Get all repo full names from user's accessible repos
        for (const repo of reposResult.repositories) {
          // Find repos in our DB that match this full name
          const dbRepos = await db.repositories.findByGithubFullName(repo.fullName);

          for (const dbRepo of dbRepos) {
            if (dbRepo.workspaceId && !knownWorkspaceIds.has(dbRepo.workspaceId)) {
              const ws = await db.workspaces.findById(dbRepo.workspaceId);
              if (ws) {
                // Determine permission level
                const permission = repo.permissions.admin
                  ? 'admin'
                  : repo.permissions.push
                    ? 'write'
                    : 'read';

                contributorWorkspaces.push({ ...ws, accessPermission: permission });
                knownWorkspaceIds.add(ws.id);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[workspaces/accessible] Failed to check GitHub repo access:', err);
        // Continue without contributor workspaces
      }
    }

    // Format response
    const formatWorkspace = (ws: Workspace, accessType: string, permission?: string) => ({
      id: ws.id,
      name: ws.name,
      status: ws.status,
      publicUrl: ws.publicUrl,
      accessType,
      permission: permission || (accessType === 'owner' ? 'admin' : 'read'),
      createdAt: ws.createdAt,
    });

    res.json({
      workspaces: [
        ...ownedWorkspaces.map((w) => formatWorkspace(w, 'owner', 'admin')),
        ...memberWorkspaces.map((w) => {
          const membership = memberships.find((m) => m.workspaceId === w.id);
          return formatWorkspace(w, 'member', membership?.role);
        }),
        ...contributorWorkspaces.map((w) => formatWorkspace(w, 'contributor', w.accessPermission)),
      ],
      summary: {
        owned: ownedWorkspaces.length,
        member: memberWorkspaces.length,
        contributor: contributorWorkspaces.length,
        total: ownedWorkspaces.length + memberWorkspaces.length + contributorWorkspaces.length,
      },
    });
  } catch (error) {
    console.error('Error getting accessible workspaces:', error);
    res.status(500).json({ error: 'Failed to get accessible workspaces' });
  }
});

/**
 * GET /api/workspaces/:id
 * Get workspace details
 * Uses requireWorkspaceAccess middleware for auto-access via GitHub repos
 */
workspacesRouter.get('/:id', requireWorkspaceAccess, async (req: Request, res: Response) => {
  const { id } = req.params;
  const _workspaceAccess = (req as any).workspaceAccess;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
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

    // Include provisioning progress info if it exists (even after status changes to 'running')
    // This allows the frontend to see all stages including 'complete'
    const provisioningProgress = getProvisioningStage(id);

    res.json({
      status,
      provisioning: provisioningProgress ? {
        stage: provisioningProgress.stage,
        startedAt: provisioningProgress.startedAt,
        elapsedMs: Date.now() - provisioningProgress.startedAt,
      } : null,
    });
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
 * POST /api/workspaces/:id/autoscale
 * Trigger auto-scaling based on current agent count
 * Supports both user session auth and workspace token auth
 * Called by workspace container when spawning new agents
 */
workspacesRouter.post('/:id/autoscale', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { agentCount } = req.body;

  if (typeof agentCount !== 'number' || agentCount < 0) {
    return res.status(400).json({ error: 'agentCount must be a non-negative number' });
  }

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Verify auth: either user session or workspace token
    const userId = req.session?.userId;
    const authHeader = req.get('authorization');

    if (userId) {
      // User session auth
      if (workspace.userId !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
    } else if (authHeader?.startsWith('Bearer ')) {
      // Workspace token auth (for calls from within the workspace)
      const crypto = await import('crypto');
      const config = getConfig();
      const providedToken = authHeader.slice(7);
      const expectedToken = crypto.default
        .createHmac('sha256', config.sessionSecret)
        .update(`workspace:${id}`)
        .digest('hex');

      const isValid = crypto.default.timingSafeEqual(
        Buffer.from(providedToken),
        Buffer.from(expectedToken)
      );

      if (!isValid) {
        return res.status(401).json({ error: 'Invalid workspace token' });
      }
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const provisioner = getProvisioner();
    const currentTier = await provisioner.getCurrentTier(id);
    const recommendedTier = provisioner.getRecommendedTier(agentCount);

    // Check if scaling is needed
    if (recommendedTier.memoryMb <= currentTier.memoryMb) {
      return res.json({
        scaled: false,
        currentTier: currentTier.name,
        message: 'Current tier is sufficient',
      });
    }

    // Perform the scale-up (respects plan limits)
    const result = await provisioner.autoScale(id, agentCount);

    res.json({
      scaled: result.scaled,
      previousTier: result.currentTier || currentTier.name,
      newTier: result.targetTier || currentTier.name,
      reason: result.reason,
      message: result.scaled
        ? `Scaled up to ${result.targetTier} tier`
        : result.reason || 'Scaling not required',
    });
  } catch (error) {
    console.error('Error auto-scaling workspace:', error);
    res.status(500).json({ error: 'Failed to auto-scale workspace' });
  }
});

/**
 * POST /api/workspaces/:id/domain
 * Add or update custom domain (Premium feature - Team/Enterprise only)
 */
workspacesRouter.post('/:id/domain', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { domain } = req.body;

  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'Domain is required' });
  }

  // Basic domain validation
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Check if user has premium plan (Team/Enterprise)
    const user = await db.users.findById(userId);
    const hasPremium = user?.plan === 'team' || user?.plan === 'enterprise';
    if (!hasPremium) {
      return res.status(402).json({
        error: 'Custom domains require Team or Enterprise plan',
        upgrade: '/settings/billing',
      });
    }

    // Check if domain is already in use
    const existing = await db.workspaces.findByCustomDomain(domain);
    if (existing && existing.id !== id) {
      return res.status(409).json({ error: 'Domain already in use' });
    }

    // Set the custom domain (pending verification)
    await db.workspaces.setCustomDomain(id, domain, 'pending');

    // Return DNS instructions
    res.json({
      success: true,
      domain,
      status: 'pending',
      instructions: {
        type: 'CNAME',
        name: domain,
        value: workspace.publicUrl?.replace('https://', '') || `${id}.agent-relay.com`,
        ttl: 300,
      },
      verifyEndpoint: `/api/workspaces/${id}/domain/verify`,
      message: 'Add the CNAME record to your DNS, then call the verify endpoint',
    });
  } catch (error) {
    console.error('Error setting custom domain:', error);
    res.status(500).json({ error: 'Failed to set custom domain' });
  }
});

/**
 * POST /api/workspaces/:id/domain/verify
 * Verify custom domain DNS is configured correctly
 */
workspacesRouter.post('/:id/domain/verify', async (req: Request, res: Response) => {
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

    if (!workspace.customDomain) {
      return res.status(400).json({ error: 'No custom domain configured' });
    }

    // Verify DNS resolution
    const dns = await import('dns').then(m => m.promises);
    try {
      const records = await dns.resolveCname(workspace.customDomain);
      const expectedTarget = workspace.publicUrl?.replace('https://', '') || `${id}.agent-relay.com`;

      if (records.some(r => r.includes(expectedTarget) || r.includes('agentrelay'))) {
        // DNS is configured, now provision SSL cert
        await db.workspaces.updateCustomDomainStatus(id, 'verifying');

        // Trigger SSL cert provisioning on compute provider
        // For Railway/Fly, this is automatic once domain is added
        await provisionDomainSSL(workspace);

        await db.workspaces.updateCustomDomainStatus(id, 'active');

        res.json({
          success: true,
          status: 'active',
          domain: workspace.customDomain,
          message: 'Custom domain verified and SSL certificate provisioned',
        });
      } else {
        res.status(400).json({
          success: false,
          status: 'pending',
          error: 'DNS not configured correctly',
          expected: expectedTarget,
          found: records,
        });
      }
    } catch (_dnsError) {
      res.status(400).json({
        success: false,
        status: 'pending',
        error: 'Could not resolve domain. DNS may not be configured yet.',
      });
    }
  } catch (error) {
    console.error('Error verifying domain:', error);
    res.status(500).json({ error: 'Failed to verify domain' });
  }
});

/**
 * DELETE /api/workspaces/:id/domain
 * Remove custom domain
 */
workspacesRouter.delete('/:id/domain', async (req: Request, res: Response) => {
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

    // Remove from compute provider
    if (workspace.customDomain) {
      await removeDomainFromCompute(workspace);
    }

    await db.workspaces.removeCustomDomain(id);

    res.json({ success: true, message: 'Custom domain removed' });
  } catch (error) {
    console.error('Error removing domain:', error);
    res.status(500).json({ error: 'Failed to remove domain' });
  }
});

/**
 * Helper: Provision SSL for custom domain on compute provider
 */
async function provisionDomainSSL(workspace: Workspace): Promise<void> {
  const config = (await import('../config.js')).getConfig();

  if (workspace.computeProvider === 'fly' && config.compute.fly) {
    // Fly.io: Add certificate
    await fetch(`https://api.machines.dev/v1/apps/ar-${workspace.id.substring(0, 8)}/certificates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.compute.fly.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: workspace.customDomain }),
    });
  } else if (workspace.computeProvider === 'railway' && config.compute.railway) {
    // Railway: Add custom domain via GraphQL
    await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.compute.railway.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation AddCustomDomain($input: CustomDomainCreateInput!) {
            customDomainCreate(input: $input) { id }
          }
        `,
        variables: {
          input: {
            projectId: workspace.computeId,
            domain: workspace.customDomain,
          },
        },
      }),
    });
  }
  // Docker: Would need reverse proxy config (Caddy/nginx)
}

/**
 * Helper: Remove custom domain from compute provider
 */
async function removeDomainFromCompute(workspace: Workspace): Promise<void> {
  const config = (await import('../config.js')).getConfig();

  if (workspace.computeProvider === 'fly' && config.compute.fly) {
    await fetch(
      `https://api.machines.dev/v1/apps/ar-${workspace.id.substring(0, 8)}/certificates/${workspace.customDomain}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${config.compute.fly.apiToken}` },
      }
    );
  }
  // Railway and Docker: similar cleanup
}

/**
 * POST /api/workspaces/:id/proxy/*
 * Proxy API requests to the workspace container
 * This allows the dashboard to make REST calls through the cloud server
 */
workspacesRouter.all('/:id/proxy/{*proxyPath}', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  // Express 5 wildcard params return an array of path segments, not a slash-separated string
  const proxyPathParam = req.params.proxyPath;
  const proxyPath = Array.isArray(proxyPathParam) ? proxyPathParam.join('/') : proxyPathParam;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (workspace.status !== 'running' || !workspace.publicUrl) {
      return res.status(400).json({ error: 'Workspace is not running' });
    }

    // Determine the internal URL for proxying
    // When running inside Docker or Fly.io, use internal networking
    let targetBaseUrl = workspace.publicUrl;
    const runningInDocker = process.env.RUNNING_IN_DOCKER === 'true';
    const runningOnFly = !!process.env.FLY_APP_NAME;

    if (runningOnFly && targetBaseUrl.includes('.fly.dev')) {
      // Use Fly.io internal networking (.internal uses IPv6, works by default)
      // ar-583f273b.fly.dev -> http://ar-583f273b.internal:3888
      const appName = targetBaseUrl.match(/https?:\/\/([^.]+)\.fly\.dev/)?.[1];
      if (appName) {
        targetBaseUrl = `http://${appName}.internal:3888`;
      }
    } else if (runningInDocker && workspace.computeId && targetBaseUrl.includes('localhost')) {
      // Replace localhost URL with container name for Docker networking
      // workspace.computeId is the container name (e.g., "ar-abc12345")
      // The workspace port is 3888 inside the container
      targetBaseUrl = `http://${workspace.computeId}:3888`;
    }

    const targetUrl = `${targetBaseUrl}/api/${proxyPath}`;
    console.log(`[workspace-proxy] ${req.method} ${targetUrl}`);

    // Store targetUrl for error handling
    (req as any)._proxyTargetUrl = targetUrl;

    // Add timeout to prevent hanging requests
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }

    let proxyRes: globalThis.Response;
    try {
      proxyRes = await fetch(targetUrl, fetchOptions);
    } finally {
      clearTimeout(timeout);
    }
    console.log(`[workspace-proxy] Response: ${proxyRes.status} ${proxyRes.statusText}`);

    // Handle non-JSON responses gracefully
    const contentType = proxyRes.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const data = await proxyRes.json();
      res.status(proxyRes.status).json(data);
    } else {
      const text = await proxyRes.text();
      res.status(proxyRes.status).send(text);
    }
  } catch (error) {
    const targetUrl = (req as any)._proxyTargetUrl || 'unknown';
    console.error('[workspace-proxy] Error proxying to:', targetUrl);
    console.error('[workspace-proxy] Error details:', error);

    // Check for timeout/abort errors
    if (error instanceof Error && error.name === 'AbortError') {
      res.status(504).json({
        error: 'Workspace request timed out',
        details: 'The workspace did not respond within 15 seconds',
        targetUrl: targetUrl,
      });
      return;
    }

    // Check for connection refused (workspace not running)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
      res.status(503).json({
        error: 'Workspace is not reachable',
        details: 'The workspace container may not be running or accepting connections',
        targetUrl: targetUrl,
      });
      return;
    }

    res.status(500).json({
      error: 'Failed to proxy request to workspace',
      details: errorMessage,
      targetUrl: targetUrl, // Include target URL for debugging
    });
  }
});

/**
 * POST /api/workspaces/quick
 * Quick provision: one-click with defaults
 * Providers are optional - can be connected after workspace creation via CLI login
 */
workspacesRouter.post('/quick', checkWorkspaceLimit, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, repositoryFullName } = req.body;

  if (!repositoryFullName) {
    return res.status(400).json({ error: 'Repository name is required' });
  }

  try {
    // Get user's connected providers (optional now)
    const credentials = await db.credentials.findByUserId(userId);
    const providers = credentials
      .filter((c) => c.provider !== 'github')
      .map((c) => c.provider);

    // Create workspace with defaults
    const provisioner = getProvisioner();
    const workspaceName = name || `Workspace for ${repositoryFullName}`;

    const result = await provisioner.provision({
      userId,
      name: workspaceName,
      providers: providers.length > 0 ? providers : [], // Empty is OK now
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
      providersConnected: providers.length > 0,
      message: providers.length > 0
        ? 'Workspace provisioned successfully!'
        : 'Workspace provisioned! Connect an AI provider to start using agents.',
    });
  } catch (error) {
    console.error('Error quick provisioning:', error);
    res.status(500).json({ error: 'Failed to provision workspace' });
  }
});
