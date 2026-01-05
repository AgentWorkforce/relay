/**
 * Repos API Routes
 *
 * GitHub repository management - list, import, sync.
 * Includes Nango-based GitHub permission checking for dashboard access control.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import { nangoService } from '../services/nango.js';

export const reposRouter = Router();

// All routes require authentication
reposRouter.use(requireAuth);

/**
 * GET /api/repos
 * List user's imported repositories
 */
reposRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const repositories = await db.repositories.findByUserId(userId);

    res.json({
      repositories: repositories.map((r) => ({
        id: r.id,
        fullName: r.githubFullName,
        defaultBranch: r.defaultBranch,
        isPrivate: r.isPrivate,
        syncStatus: r.syncStatus,
        lastSyncedAt: r.lastSyncedAt,
        workspaceId: r.workspaceId,
      })),
    });
  } catch (error) {
    console.error('Error listing repos:', error);
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

/**
 * GET /api/repos/github
 * List available GitHub repos for the authenticated user
 */
reposRouter.get('/github', async (req: Request, res: Response) => {
  const githubToken = req.session.githubToken;

  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub not connected' });
  }

  const { page = '1', per_page = '30', type = 'all' } = req.query;

  try {
    // Fetch repos from GitHub API
    const response = await fetch(
      `https://api.github.com/user/repos?page=${page}&per_page=${per_page}&type=${type}&sort=updated`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${error}`);
    }

    const repos = await response.json() as Array<{
      id: number;
      full_name: string;
      name: string;
      owner: { login: string };
      description: string | null;
      default_branch: string;
      private: boolean;
      language: string | null;
      updated_at: string;
      html_url: string;
    }>;

    // Get link header for pagination
    const linkHeader = response.headers.get('link');
    const hasMore = linkHeader?.includes('rel="next"') || false;

    res.json({
      repositories: repos.map((r) => ({
        githubId: r.id,
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        description: r.description,
        defaultBranch: r.default_branch,
        isPrivate: r.private,
        language: r.language,
        updatedAt: r.updated_at,
        htmlUrl: r.html_url,
      })),
      pagination: {
        page: parseInt(page as string, 10),
        perPage: parseInt(per_page as string, 10),
        hasMore,
      },
    });
  } catch (error) {
    console.error('Error fetching GitHub repos:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub repositories' });
  }
});

/**
 * POST /api/repos
 * Import a GitHub repository
 */
reposRouter.post('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const githubToken = req.session.githubToken;
  const { fullName } = req.body;

  if (!fullName || typeof fullName !== 'string') {
    return res.status(400).json({ error: 'Repository full name is required (owner/repo)' });
  }

  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub not connected' });
  }

  try {
    // Verify repo exists and user has access
    const repoResponse = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!repoResponse.ok) {
      if (repoResponse.status === 404) {
        return res.status(404).json({ error: 'Repository not found or no access' });
      }
      throw new Error('Failed to verify repository');
    }

    const repoData = await repoResponse.json() as {
      id: number;
      full_name: string;
      default_branch: string;
      private: boolean;
    };

    // Import repo
    const repository = await db.repositories.upsert({
      userId,
      githubFullName: repoData.full_name,
      githubId: repoData.id,
      defaultBranch: repoData.default_branch,
      isPrivate: repoData.private,
    });

    res.status(201).json({
      repository: {
        id: repository.id,
        fullName: repository.githubFullName,
        defaultBranch: repository.defaultBranch,
        isPrivate: repository.isPrivate,
        syncStatus: repository.syncStatus,
      },
    });
  } catch (error) {
    console.error('Error importing repo:', error);
    res.status(500).json({ error: 'Failed to import repository' });
  }
});

/**
 * POST /api/repos/bulk
 * Import multiple repositories at once
 */
reposRouter.post('/bulk', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const githubToken = req.session.githubToken;
  const { repositories } = req.body;

  if (!repositories || !Array.isArray(repositories)) {
    return res.status(400).json({ error: 'repositories array is required' });
  }

  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub not connected' });
  }

  const results: { fullName: string; success: boolean; error?: string }[] = [];

  for (const repo of repositories) {
    const fullName = typeof repo === 'string' ? repo : repo.fullName;

    try {
      // Verify and fetch repo info
      const repoResponse = await fetch(`https://api.github.com/repos/${fullName}`, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!repoResponse.ok) {
        results.push({ fullName, success: false, error: 'Not found or no access' });
        continue;
      }

      const repoData = await repoResponse.json() as {
        id: number;
        full_name: string;
        default_branch: string;
        private: boolean;
      };

      await db.repositories.upsert({
        userId,
        githubFullName: repoData.full_name,
        githubId: repoData.id,
        defaultBranch: repoData.default_branch,
        isPrivate: repoData.private,
      });

      results.push({ fullName, success: true });
    } catch (_error) {
      results.push({ fullName, success: false, error: 'Import failed' });
    }
  }

  const imported = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  res.json({
    message: `Imported ${imported} repositories, ${failed} failed`,
    results,
  });
});

/**
 * GET /api/repos/accessible
 * List all GitHub repositories the authenticated user has access to.
 * Uses Nango proxy with user's GitHub OAuth token.
 */
reposRouter.get('/accessible', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { page, perPage, type, sort } = req.query;

  try {
    // Get user's Nango connection ID
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.nangoConnectionId) {
      return res.status(400).json({
        error: 'GitHub not connected via Nango',
        code: 'NANGO_NOT_CONNECTED',
        message: 'Please reconnect your GitHub account',
      });
    }

    // List accessible repos via Nango proxy
    const result = await nangoService.listUserAccessibleRepos(user.nangoConnectionId, {
      page: page ? parseInt(page as string, 10) : undefined,
      perPage: perPage ? Math.min(parseInt(perPage as string, 10), 100) : undefined,
      type: type as 'all' | 'owner' | 'public' | 'private' | 'member' | undefined,
      sort: sort as 'created' | 'updated' | 'pushed' | 'full_name' | undefined,
    });

    res.json({
      repositories: result.repositories,
      pagination: {
        page: page ? parseInt(page as string, 10) : 1,
        perPage: perPage ? Math.min(parseInt(perPage as string, 10), 100) : 100,
        hasMore: result.hasMore,
      },
      checkedBy: {
        userId: user.id,
        githubUsername: user.githubUsername,
      },
    });
  } catch (error) {
    console.error('Error listing accessible repos:', error);
    res.status(500).json({ error: 'Failed to list accessible repositories' });
  }
});

/**
 * GET /api/repos/search
 * Search GitHub repos by name
 */
reposRouter.get('/search', async (req: Request, res: Response) => {
  const githubToken = req.session.githubToken;
  const { q } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Search query (q) is required' });
  }

  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub not connected' });
  }

  try {
    // Search user's repos
    const response = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+user:@me&sort=updated&per_page=20`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      throw new Error('GitHub search failed');
    }

    const data = await response.json() as {
      items: Array<{
        id: number;
        full_name: string;
        name: string;
        owner: { login: string };
        description: string | null;
        default_branch: string;
        private: boolean;
        language: string | null;
      }>;
      total_count: number;
    };

    res.json({
      repositories: data.items.map((r) => ({
        githubId: r.id,
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        description: r.description,
        defaultBranch: r.default_branch,
        isPrivate: r.private,
        language: r.language,
      })),
      total: data.total_count,
    });
  } catch (error) {
    console.error('Error searching repos:', error);
    res.status(500).json({ error: 'Failed to search repositories' });
  }
});

// ============================================================================
// WILDCARD ROUTES BELOW - All specific routes must be defined ABOVE this line
// ============================================================================

/**
 * GET /api/repos/:id
 * Get repository details
 */
reposRouter.get('/:id', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const repositories = await db.repositories.findByUserId(userId);
    const repo = repositories.find((r) => r.id === id);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    res.json({
      id: repo.id,
      fullName: repo.githubFullName,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
      syncStatus: repo.syncStatus,
      lastSyncedAt: repo.lastSyncedAt,
      workspaceId: repo.workspaceId,
      createdAt: repo.createdAt,
    });
  } catch (error) {
    console.error('Error getting repo:', error);
    res.status(500).json({ error: 'Failed to get repository' });
  }
});

/**
 * POST /api/repos/:id/sync
 * Trigger repository sync (clone/pull to workspace)
 */
reposRouter.post('/:id/sync', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const repositories = await db.repositories.findByUserId(userId);
    const repo = repositories.find((r) => r.id === id);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    if (!repo.workspaceId) {
      return res.status(400).json({ error: 'Repository not assigned to a workspace' });
    }

    // Update sync status
    await db.repositories.updateSyncStatus(id, 'syncing');

    // In production, this would trigger the workspace to pull the repo
    // For now, simulate success after a short delay
    setTimeout(async () => {
      await db.repositories.updateSyncStatus(id, 'synced', new Date());
    }, 2000);

    res.json({ message: 'Sync started', syncStatus: 'syncing' });
  } catch (error) {
    console.error('Error syncing repo:', error);
    res.status(500).json({ error: 'Failed to sync repository' });
  }
});

/**
 * DELETE /api/repos/:id
 * Remove a repository
 */
reposRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const repositories = await db.repositories.findByUserId(userId);
    const repo = repositories.find((r) => r.id === id);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    await db.repositories.delete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting repo:', error);
    res.status(500).json({ error: 'Failed to delete repository' });
  }
});

// ============================================================================
// Nango-based GitHub Permission APIs (for dashboard access control)
// ============================================================================

/**
 * GET /api/repos/check-access/:owner/:repo
 * Check if authenticated user has access to a specific GitHub repository.
 * Uses Nango proxy with user's GitHub OAuth token.
 *
 * Response:
 * - hasAccess: boolean - Whether user can access this repo
 * - permission: 'admin' | 'write' | 'read' | 'none' - User's permission level
 * - repository: Repository details if user has access
 *
 * Use this for dashboard access control - grant access if hasAccess is true.
 */
reposRouter.get('/check-access/:owner/:repo', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { owner, repo } = req.params;

  if (!owner || !repo) {
    return res.status(400).json({ error: 'Owner and repo parameters are required' });
  }

  try {
    // Get user's Nango connection ID
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.nangoConnectionId) {
      return res.status(400).json({
        error: 'GitHub not connected via Nango',
        code: 'NANGO_NOT_CONNECTED',
        message: 'Please reconnect your GitHub account',
      });
    }

    // Check access via Nango proxy
    const accessResult = await nangoService.checkUserRepoAccess(
      user.nangoConnectionId,
      owner,
      repo
    );

    res.json({
      hasAccess: accessResult.hasAccess,
      permission: accessResult.permission,
      repository: accessResult.repository,
      // Include user info for dashboard context
      checkedBy: {
        userId: user.id,
        githubUsername: user.githubUsername,
      },
    });
  } catch (error) {
    console.error('Error checking repo access:', error);
    res.status(500).json({ error: 'Failed to check repository access' });
  }
});

/**
 * POST /api/repos/check-access-bulk
 * Check access to multiple repositories at once.
 * Useful for determining which workspaces a user can view.
 *
 * Body:
 * - repositories: Array of "owner/repo" strings
 *
 * Response:
 * - results: Array of { fullName, hasAccess, permission }
 */
reposRouter.post('/check-access-bulk', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { repositories } = req.body;

  if (!repositories || !Array.isArray(repositories)) {
    return res.status(400).json({ error: 'repositories array is required' });
  }

  if (repositories.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 repositories per request' });
  }

  try {
    // Get user's Nango connection ID
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.nangoConnectionId) {
      return res.status(400).json({
        error: 'GitHub not connected via Nango',
        code: 'NANGO_NOT_CONNECTED',
        message: 'Please reconnect your GitHub account',
      });
    }

    // Check access for each repo (in parallel with concurrency limit)
    const results: Array<{
      fullName: string;
      hasAccess: boolean;
      permission?: string;
      error?: string;
    }> = [];

    // Process in batches of 10 to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < repositories.length; i += batchSize) {
      const batch = repositories.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (fullName: string) => {
          try {
            const [owner, repo] = fullName.split('/');
            if (!owner || !repo) {
              return { fullName, hasAccess: false, error: 'Invalid repository format' };
            }

            const accessResult = await nangoService.checkUserRepoAccess(
              user.nangoConnectionId!,
              owner,
              repo
            );

            return {
              fullName,
              hasAccess: accessResult.hasAccess,
              permission: accessResult.permission,
            };
          } catch (_err) {
            return { fullName, hasAccess: false, error: 'Check failed' };
          }
        })
      );
      results.push(...batchResults);
    }

    const accessibleCount = results.filter(r => r.hasAccess).length;

    res.json({
      results,
      summary: {
        total: repositories.length,
        accessible: accessibleCount,
        denied: repositories.length - accessibleCount,
      },
      checkedBy: {
        userId: user.id,
        githubUsername: user.githubUsername,
      },
    });
  } catch (error) {
    console.error('Error checking bulk repo access:', error);
    res.status(500).json({ error: 'Failed to check repository access' });
  }
});
