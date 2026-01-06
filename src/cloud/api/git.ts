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
 *
 * Returns:
 * - { valid: true } if token matches
 * - { valid: false, reason: string } if token is invalid or missing
 */
function verifyWorkspaceToken(req: Request, workspaceId: string): { valid: true } | { valid: false; reason: string } {
  const authHeader = req.get('authorization');

  if (!authHeader) {
    return { valid: false, reason: 'No Authorization header. WORKSPACE_TOKEN may not be set in the container.' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { valid: false, reason: 'Invalid Authorization header format. Expected: Bearer <token>' };
  }

  const providedToken = authHeader.slice(7);
  if (!providedToken) {
    return { valid: false, reason: 'Empty bearer token provided.' };
  }

  const expectedToken = generateExpectedToken(workspaceId);

  // Use timing-safe comparison to prevent timing attacks
  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(providedToken),
      Buffer.from(expectedToken)
    );

    if (!isValid) {
      return { valid: false, reason: 'Token mismatch. Workspace may need reprovisioning or SESSION_SECRET changed.' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Token comparison failed (length mismatch). Workspace may need reprovisioning.' };
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
  const tokenVerification = verifyWorkspaceToken(req, workspaceId);
  if (!tokenVerification.valid) {
    console.warn(`[git] Token verification failed for workspace ${workspaceId.substring(0, 8)}: ${tokenVerification.reason}`);
    return res.status(401).json({
      error: 'Invalid workspace token',
      code: 'INVALID_WORKSPACE_TOKEN',
      hint: tokenVerification.reason,
    });
  }

  try {
    // Get workspace to find the user
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      console.warn(`[git] Workspace not found: ${workspaceId}`);
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
        hint: 'The workspace may have been deleted. Try reprovisioning.',
      });
    }

    const userId = workspace.userId;
    console.log(`[git] Token request for workspace ${workspaceId.substring(0, 8)}, user ${userId.substring(0, 8)}`);

    // Find a repository with a Nango connection for this user
    const repos = await db.repositories.findByUserId(userId);
    const repoWithConnection = repos.find(r => r.nangoConnectionId);

    if (!repoWithConnection?.nangoConnectionId) {
      console.warn(`[git] No Nango connection found for user ${userId.substring(0, 8)}. Repos: ${repos.length}, with connections: ${repos.filter(r => r.nangoConnectionId).length}`);
      return res.status(404).json({
        error: 'No GitHub App connection found',
        code: 'NO_GITHUB_APP_CONNECTION',
        hint: 'Install the GitHub App on your repositories at https://github.com/apps/agent-relay',
        repoCount: repos.length,
      });
    }

    console.log(`[git] Fetching token from Nango for connection ${repoWithConnection.nangoConnectionId.substring(0, 8)}...`);

    // Get fresh tokens from Nango (auto-refreshes if needed)
    // - installationToken: for git operations (clone, push, pull)
    // - userToken: for gh CLI operations (requires user context)
    let installationToken: string;
    try {
      installationToken = await nangoService.getGithubAppToken(repoWithConnection.nangoConnectionId);
    } catch (nangoError) {
      const errorMessage = nangoError instanceof Error ? nangoError.message : 'Unknown error';
      console.error(`[git] Nango token fetch failed for connection ${repoWithConnection.nangoConnectionId}:`, errorMessage);

      // Provide specific hints based on error type
      if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        return res.status(500).json({
          error: 'GitHub App connection expired or revoked',
          code: 'NANGO_CONNECTION_EXPIRED',
          hint: 'Reconnect your GitHub App at https://github.com/apps/agent-relay',
          details: errorMessage,
        });
      }

      return res.status(500).json({
        error: 'Failed to fetch GitHub token from Nango',
        code: 'NANGO_TOKEN_FETCH_FAILED',
        hint: 'This may be a temporary issue. Try again in a few seconds.',
        details: errorMessage,
      });
    }

    // Get user OAuth token from user's login connection (GITHUB_USER integration)
    // This is the user's personal OAuth token, not the GitHub App installation token
    // Required for gh CLI operations that need user context (e.g., creating PRs)
    let userToken: string | null = null;
    try {
      // Look up the user to get their login connection ID
      const user = await db.users.findById(userId);
      if (user?.nangoConnectionId) {
        userToken = await nangoService.getGithubUserToken(user.nangoConnectionId);
        console.log(`[git] Retrieved user OAuth token from login connection`);
      } else {
        console.log('[git] User has no login connection (nangoConnectionId is null)');
      }
    } catch (err) {
      console.log('[git] Failed to get user OAuth token:', err instanceof Error ? err.message : err);
    }

    // GitHub App installation tokens expire after 1 hour
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // 55 min buffer

    console.log(`[git] Token fetched successfully for workspace ${workspaceId.substring(0, 8)}`);

    res.json({
      token: installationToken,
      userToken, // For gh CLI - may be null if not available
      expiresAt,
      username: 'x-access-token', // GitHub App tokens use this as username
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[git] Unexpected error getting token:', error);
    res.status(500).json({
      error: 'Failed to get GitHub token',
      code: 'UNEXPECTED_ERROR',
      details: errorMessage,
    });
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

  const tokenVerification = verifyWorkspaceToken(req, workspaceId);
  if (!tokenVerification.valid) {
    console.warn(`[git] POST: Token verification failed for workspace ${workspaceId.substring(0, 8)}: ${tokenVerification.reason}`);
    return res.status(401).json({
      error: 'Invalid workspace token',
      code: 'INVALID_WORKSPACE_TOKEN',
      hint: tokenVerification.reason,
    });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      console.warn(`[git] POST: Workspace not found: ${workspaceId}`);
      return res.status(404).json({
        error: 'Workspace not found',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }

    const repos = await db.repositories.findByUserId(workspace.userId);
    const repoWithConnection = repos.find(r => r.nangoConnectionId);

    if (!repoWithConnection?.nangoConnectionId) {
      console.warn(`[git] POST: No Nango connection for user ${workspace.userId.substring(0, 8)}`);
      return res.status(404).json({
        error: 'No GitHub App connection found',
        code: 'NO_GITHUB_APP_CONNECTION',
      });
    }

    let token: string;
    try {
      token = await nangoService.getGithubAppToken(repoWithConnection.nangoConnectionId);
    } catch (nangoError) {
      const errorMessage = nangoError instanceof Error ? nangoError.message : 'Unknown error';
      console.error(`[git] POST: Nango token fetch failed:`, errorMessage);
      return res.status(500).json({
        error: 'Failed to fetch GitHub token',
        code: 'NANGO_TOKEN_FETCH_FAILED',
        details: errorMessage,
      });
    }

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

    res.json({
      token,
      expiresAt,
      username: 'x-access-token',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[git] POST: Unexpected error:', error);
    res.status(500).json({
      error: 'Failed to get GitHub token',
      code: 'UNEXPECTED_ERROR',
      details: errorMessage,
    });
  }
});
