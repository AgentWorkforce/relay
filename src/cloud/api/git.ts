/**
 * Git Gateway API Routes
 *
 * Provides fresh GitHub tokens to workspace containers for git operations.
 * This gateway pattern ensures tokens are always valid (Nango handles refresh).
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { nangoService } from '../services/nango.js';
import { getConfig } from '../config.js';

export const gitRouter = Router();

/**
 * Generate expected workspace token using HMAC
 */
function generateExpectedToken(workspaceId: string): string {
  const config = getConfig();
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`workspace:${workspaceId}`)
    .digest('hex');
}

/**
 * Verify workspace access token
 * Workspaces authenticate with a secret passed at provisioning time
 */
function verifyWorkspaceToken(req: Request, workspaceId: string): boolean {
  const authHeader = req.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  const providedToken = authHeader.slice(7);
  const expectedToken = generateExpectedToken(workspaceId);

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedToken),
      Buffer.from(expectedToken)
    );
  } catch {
    return false;
  }
}

/**
 * GET /api/git/token
 * Get a fresh GitHub token for git operations
 *
 * Query params:
 *   - workspaceId: The workspace requesting the token
 *
 * Returns: { token: string, expiresAt?: string }
 *
 * This endpoint is called by the git credential helper in workspace containers.
 * It fetches a fresh GitHub App installation token via Nango.
 */
gitRouter.get('/token', async (req: Request, res: Response) => {
  const { workspaceId } = req.query;

  if (!workspaceId || typeof workspaceId !== 'string') {
    return res.status(400).json({ error: 'workspaceId is required' });
  }

  // Verify the request is from a valid workspace
  if (!verifyWorkspaceToken(req, workspaceId)) {
    return res.status(401).json({ error: 'Invalid workspace token' });
  }

  try {
    // Get workspace to find the user
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const userId = workspace.userId;

    // Find a repository with a Nango connection for this user
    const repos = await db.repositories.findByUserId(userId);
    const repoWithConnection = repos.find(r => r.nangoConnectionId);

    if (!repoWithConnection?.nangoConnectionId) {
      return res.status(404).json({
        error: 'No GitHub App connection found',
        hint: 'Connect a repository via the GitHub App to enable git operations',
      });
    }

    // Get fresh token from Nango (auto-refreshes if needed)
    const token = await nangoService.getGithubAppToken(repoWithConnection.nangoConnectionId);

    // GitHub App installation tokens expire after 1 hour
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // 55 min buffer

    res.json({
      token,
      expiresAt,
      username: 'x-access-token', // GitHub App tokens use this as username
    });
  } catch (error) {
    console.error('[git] Error getting token:', error);
    res.status(500).json({ error: 'Failed to get GitHub token' });
  }
});

/**
 * POST /api/git/token
 * Same as GET but accepts body params (for compatibility with some git credential helpers)
 */
gitRouter.post('/token', async (req: Request, res: Response) => {
  const workspaceId = req.body.workspaceId || req.query.workspaceId;

  if (!workspaceId || typeof workspaceId !== 'string') {
    return res.status(400).json({ error: 'workspaceId is required' });
  }

  if (!verifyWorkspaceToken(req, workspaceId)) {
    return res.status(401).json({ error: 'Invalid workspace token' });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const repos = await db.repositories.findByUserId(workspace.userId);
    const repoWithConnection = repos.find(r => r.nangoConnectionId);

    if (!repoWithConnection?.nangoConnectionId) {
      return res.status(404).json({
        error: 'No GitHub App connection found',
      });
    }

    const token = await nangoService.getGithubAppToken(repoWithConnection.nangoConnectionId);
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

    res.json({
      token,
      expiresAt,
      username: 'x-access-token',
    });
  } catch (error) {
    console.error('[git] Error getting token:', error);
    res.status(500).json({ error: 'Failed to get GitHub token' });
  }
});
