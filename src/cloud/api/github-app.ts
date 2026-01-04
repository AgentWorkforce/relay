/**
 * GitHub App API Routes
 *
 * Repo operations via Nango's github-app-oauth connection:
 * - Get clone token for repositories
 * - Create issues, PRs, and comments
 *
 * Auth flow is handled by nango-auth.ts
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import { nangoService, NANGO_INTEGRATIONS } from '../services/nango.js';

export const githubAppRouter = Router();

// All routes require authentication
githubAppRouter.use(requireAuth);

/**
 * GET /api/github-app/status
 * Check if Nango GitHub App OAuth is configured
 */
githubAppRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    configured: true,
    integrations: NANGO_INTEGRATIONS,
    connectUrl: '/connect-repos',
  });
});

/**
 * GET /api/github-app/repos
 * List repositories the user has connected via Nango
 */
githubAppRouter.get('/repos', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const repos = await db.repositories.findByUserId(userId);

    res.json({
      repositories: repos.map((r) => ({
        id: r.id,
        fullName: r.githubFullName,
        isPrivate: r.isPrivate,
        defaultBranch: r.defaultBranch,
        syncStatus: r.syncStatus,
        hasNangoConnection: !!r.nangoConnectionId,
        lastSyncedAt: r.lastSyncedAt,
      })),
    });
  } catch (error) {
    console.error('Error listing repos:', error);
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

/**
 * GET /api/github-app/clone-token
 * Get a clone token for a repository
 * Used by workspace provisioner to clone private repos
 */
githubAppRouter.get('/clone-token', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { repo } = req.query;

  if (!repo || typeof repo !== 'string') {
    return res.status(400).json({ error: 'Repository name is required (owner/repo)' });
  }

  try {
    // Find the repository in our database
    const userRepos = await db.repositories.findByUserId(userId);
    const repository = userRepos.find((r) => r.githubFullName === repo);

    if (!repository) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    if (!repository.nangoConnectionId) {
      return res.status(400).json({
        error: 'Repository not connected via Nango',
        hint: 'Connect your GitHub repos through the Nango flow first',
      });
    }

    // Get token from Nango connection
    const token = await nangoService.getGithubAppToken(repository.nangoConnectionId);
    const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

    res.json({
      token,
      cloneUrl,
      expiresIn: '1 hour',
    });
  } catch (error) {
    console.error('Error getting clone token:', error);
    res.status(500).json({ error: 'Failed to get clone token' });
  }
});

/**
 * POST /api/github-app/repos/:id/issues
 * Create an issue on a repository
 */
githubAppRouter.post('/repos/:id/issues', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { title, body, labels } = req.body;

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Issue title is required' });
  }

  try {
    // Find the repository
    const repository = await db.repositories.findById(id);
    if (!repository || repository.userId !== userId) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    if (!repository.nangoConnectionId) {
      return res.status(400).json({ error: 'Repository not connected via Nango' });
    }

    // Create issue via Nango Proxy (handles token injection automatically)
    const [owner, repo] = repository.githubFullName.split('/');
    const issue = await nangoService.createGithubIssue(
      repository.nangoConnectionId,
      owner,
      repo,
      { title, body: body || '', labels }
    );

    res.json({
      number: issue.number,
      url: issue.html_url,
    });
  } catch (error) {
    console.error('Error creating issue:', error);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

/**
 * POST /api/github-app/repos/:id/pulls
 * Create a pull request on a repository
 */
githubAppRouter.post('/repos/:id/pulls', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { title, body, head, base } = req.body;

  if (!title || !head || !base) {
    return res.status(400).json({ error: 'title, head, and base are required' });
  }

  try {
    // Find the repository
    const repository = await db.repositories.findById(id);
    if (!repository || repository.userId !== userId) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    if (!repository.nangoConnectionId) {
      return res.status(400).json({ error: 'Repository not connected via Nango' });
    }

    // Create PR via Nango Proxy (handles token injection automatically)
    const [owner, repo] = repository.githubFullName.split('/');
    const pr = await nangoService.createGithubPullRequest(
      repository.nangoConnectionId,
      owner,
      repo,
      { title, body: body || '', head, base }
    );

    res.json({
      number: pr.number,
      url: pr.html_url,
    });
  } catch (error) {
    console.error('Error creating PR:', error);
    res.status(500).json({ error: 'Failed to create pull request' });
  }
});

/**
 * POST /api/github-app/repos/:id/comments
 * Add a comment to an issue or PR
 */
githubAppRouter.post('/repos/:id/comments', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { issueNumber, body } = req.body;

  if (!issueNumber || !body) {
    return res.status(400).json({ error: 'issueNumber and body are required' });
  }

  try {
    const repository = await db.repositories.findById(id);
    if (!repository || repository.userId !== userId) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    if (!repository.nangoConnectionId) {
      return res.status(400).json({ error: 'Repository not connected via Nango' });
    }

    // Add comment via Nango Proxy (handles token injection automatically)
    const [owner, repo] = repository.githubFullName.split('/');
    const comment = await nangoService.addGithubIssueComment(
      repository.nangoConnectionId,
      owner,
      repo,
      issueNumber,
      body
    );

    res.json({
      id: comment.id,
      url: comment.html_url,
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});
