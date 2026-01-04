/**
 * Nango Auth API Routes
 *
 * Handles GitHub OAuth via Nango with two-connection pattern:
 * - github: User login (identity)
 * - github-app-oauth: Repository access
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import { nangoService, NANGO_INTEGRATIONS } from '../services/nango.js';

export const nangoAuthRouter = Router();

/**
 * GET /api/auth/nango/status
 * Check if Nango is configured
 */
nangoAuthRouter.get('/status', (req: Request, res: Response) => {
  try {
    res.json({
      configured: true,
      integrations: NANGO_INTEGRATIONS,
    });
  } catch (_error) {
    res.json({
      configured: false,
      message: 'Nango not configured',
    });
  }
});

/**
 * GET /api/auth/nango/login-session
 * Create a Nango connect session for GitHub login
 */
nangoAuthRouter.get('/login-session', async (req: Request, res: Response) => {
  try {
    const tempUserId = randomUUID();
    const session = await nangoService.createConnectSession(
      [NANGO_INTEGRATIONS.GITHUB_USER],
      { id: tempUserId }
    );

    res.json({ sessionToken: session.token, tempUserId });
  } catch (error) {
    console.error('Error creating login session:', error);
    res.status(500).json({ error: 'Failed to create login session' });
  }
});

/**
 * GET /api/auth/nango/login-status/:connectionId
 * Poll for login completion after Nango connect UI
 */
nangoAuthRouter.get('/login-status/:connectionId', async (req: Request, res: Response) => {
  const { connectionId } = req.params;

  try {
    // Check if a user exists with this incoming connection
    const user = await db.users.findByIncomingConnectionId(connectionId);
    if (!user) {
      return res.json({ ready: false });
    }

    // Issue session
    req.session.userId = user.id;

    // Clear incoming connection ID
    await db.users.clearIncomingConnectionId(user.id);

    // Check if user has any repos connected
    const repos = await db.repositories.findByUserId(user.id);
    const hasRepos = repos.length > 0;

    res.json({
      ready: true,
      hasRepos,
      user: {
        id: user.id,
        githubUsername: user.githubUsername,
        email: user.email,
        avatarUrl: user.avatarUrl,
        plan: user.plan,
      },
    });
  } catch (error) {
    console.error('Error checking login status:', error);
    res.status(500).json({ error: 'Failed to check login status' });
  }
});

/**
 * GET /api/auth/nango/repo-session
 * Create a Nango connect session for GitHub App OAuth (repo access)
 * Requires authentication
 */
nangoAuthRouter.get('/repo-session', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const session = await nangoService.createConnectSession(
      [NANGO_INTEGRATIONS.GITHUB_APP],
      { id: user.id, email: user.email || undefined }
    );

    res.json({ sessionToken: session.token });
  } catch (error) {
    console.error('Error creating repo session:', error);
    res.status(500).json({ error: 'Failed to create repo session' });
  }
});

/**
 * GET /api/auth/nango/repo-status/:connectionId
 * Poll for repo sync completion after GitHub App OAuth
 * Requires authentication
 */
nangoAuthRouter.get('/repo-status/:connectionId', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { connectionId: _connectionId } = req.params;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check for pending org approval
    if (user.pendingInstallationRequest) {
      return res.json({
        ready: false,
        pendingApproval: true,
        message: 'Waiting for organization admin approval',
      });
    }

    // Check if repos have been synced
    const repos = await db.repositories.findByUserId(userId);
    const reposFromConnection = repos.filter(r => r.syncStatus === 'synced' && r.nangoConnectionId);

    if (reposFromConnection.length === 0) {
      return res.json({ ready: false });
    }

    res.json({
      ready: true,
      repos: reposFromConnection.map(r => ({
        id: r.id,
        fullName: r.githubFullName,
        isPrivate: r.isPrivate,
        defaultBranch: r.defaultBranch,
      })),
    });
  } catch (error) {
    console.error('Error checking repo status:', error);
    res.status(500).json({ error: 'Failed to check repo status' });
  }
});

// ============================================================================
// Nango Webhook Handler
// ============================================================================

/**
 * POST /api/auth/nango/webhook
 * Handle Nango webhooks for auth and sync events
 */
nangoAuthRouter.post('/webhook', async (req: Request, res: Response) => {
  // Use the preserved raw body from express.json verify callback
  const rawBody = (req as Request & { rawBody?: string }).rawBody || JSON.stringify(req.body);

  // Verify signature using the new verifyIncomingWebhookRequest method
  const hasSignature = req.headers['x-nango-signature'] || req.headers['x-nango-hmac-sha256'];
  const isDev = process.env.NODE_ENV !== 'production';

  if (hasSignature) {
    if (!nangoService.verifyWebhookSignature(rawBody, req.headers as Record<string, string | string[] | undefined>)) {
      console.error('[nango-webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    console.log('[nango-webhook] Signature verified');
  } else if (!isDev) {
    console.error('[nango-webhook] Missing signature in production');
    return res.status(401).json({ error: 'Missing signature' });
  } else {
    console.warn('[nango-webhook] Skipping signature verification in development (no signature)');
  }

  const payload = req.body;
  console.log(`[nango-webhook] Received ${payload.type} event`, JSON.stringify(payload, null, 2));

  try {
    switch (payload.type) {
      case 'auth':
        await handleAuthWebhook(payload);
        break;

      case 'sync':
        console.log('[nango-webhook] Sync event received');
        break;

      case 'forward':
        // Nango forwards events from providers - typically not needed for our flow
        console.log('[nango-webhook] Forward event from provider (ignored)');
        break;

      default:
        console.log(`[nango-webhook] Unhandled event type: ${payload.type}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[nango-webhook] Error processing webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/**
 * Handle Nango auth webhook
 */
async function handleAuthWebhook(payload: {
  type: 'auth';
  connectionId: string;
  providerConfigKey: string;
  endUser?: { id?: string; email?: string };
}): Promise<void> {
  const { connectionId, providerConfigKey, endUser } = payload;

  console.log(`[nango-webhook] Auth event for ${providerConfigKey} (${connectionId})`);

  if (providerConfigKey === NANGO_INTEGRATIONS.GITHUB_USER) {
    await handleLoginWebhook(connectionId, endUser);
  } else if (providerConfigKey === NANGO_INTEGRATIONS.GITHUB_APP) {
    await handleRepoAuthWebhook(connectionId, endUser);
  }
}

/**
 * Handle GitHub login webhook
 *
 * Three scenarios:
 * 1. New user - Create user record, keep connection as permanent
 * 2. Returning user with existing connection - Store incoming ID for polling, delete temp connection
 * 3. Existing user, first connection - Set connection ID as permanent
 */
async function handleLoginWebhook(
  connectionId: string,
  _endUser?: { id?: string; email?: string }
): Promise<void> {
  // Get GitHub user info via Nango proxy
  const githubUser = await nangoService.getGithubUser(connectionId);
  const githubId = String(githubUser.id);

  // Check if user already exists
  const existingUser = await db.users.findByGithubId(githubId);

  // SCENARIO 1: New user
  if (!existingUser) {
    const newUser = await db.users.upsert({
      githubId,
      githubUsername: githubUser.login,
      email: githubUser.email || null,
      avatarUrl: githubUser.avatar_url || null,
      nangoConnectionId: connectionId,
      incomingConnectionId: connectionId,
    });

    // Update connection with real user ID
    await nangoService.updateEndUser(connectionId, NANGO_INTEGRATIONS.GITHUB_USER, {
      id: newUser.id,
      email: newUser.email || undefined,
    });

    console.log(`[nango-webhook] New user created: ${githubUser.login}`);
    return;
  }

  // SCENARIO 2: Returning user with existing connection - delete temp connection
  if (existingUser.nangoConnectionId && existingUser.nangoConnectionId !== connectionId) {
    console.log(`[nango-webhook] Returning user: ${githubUser.login}`, {
      permanentConnectionId: existingUser.nangoConnectionId,
      incomingConnectionId: connectionId,
    });

    // Store incoming connection ID for polling
    await db.users.update(existingUser.id, {
      incomingConnectionId: connectionId,
      githubUsername: githubUser.login,
      avatarUrl: githubUser.avatar_url || null,
    });

    // Delete the temporary connection from Nango to prevent duplicates
    try {
      await nangoService.deleteConnection(connectionId, NANGO_INTEGRATIONS.GITHUB_USER);
      console.log(`[nango-webhook] Deleted temp connection for returning user`);
    } catch (error) {
      console.error(`[nango-webhook] Failed to delete temp connection:`, error);
      // Non-fatal - continue anyway
    }

    return;
  }

  // SCENARIO 3: Existing user, first connection (or same connection)
  console.log(`[nango-webhook] First/same connection for existing user: ${githubUser.login}`);
  await db.users.update(existingUser.id, {
    nangoConnectionId: connectionId,
    incomingConnectionId: connectionId,
    githubUsername: githubUser.login,
    avatarUrl: githubUser.avatar_url || null,
  });

  // Update connection with user ID
  await nangoService.updateEndUser(connectionId, NANGO_INTEGRATIONS.GITHUB_USER, {
    id: existingUser.id,
    email: existingUser.email || undefined,
  });
}

/**
 * Handle GitHub App OAuth webhook (repo access)
 */
async function handleRepoAuthWebhook(
  connectionId: string,
  endUser?: { id?: string; email?: string }
): Promise<void> {
  let userId = endUser?.id;

  // Fallback: If endUser.id not in webhook, fetch connection metadata from Nango
  if (!userId) {
    console.log('[nango-webhook] No user ID in webhook payload, fetching from connection metadata...');
    try {
      const connection = await nangoService.getConnection(connectionId, NANGO_INTEGRATIONS.GITHUB_APP);
      userId = connection.end_user?.id;
      console.log(`[nango-webhook] Got user ID from connection: ${userId || 'not found'}`);
    } catch (err) {
      console.error('[nango-webhook] Failed to fetch connection metadata:', err);
    }
  }

  if (!userId) {
    console.error('[nango-webhook] No user ID found - cannot sync repos');
    return;
  }

  const user = await db.users.findById(userId);
  if (!user) {
    console.error(`[nango-webhook] User ${userId} not found`);
    return;
  }

  try {
    // Get the GitHub App installation ID
    const githubInstallationId = await nangoService.getGithubAppInstallationId(connectionId);
    let installationUuid: string | null = null;

    if (githubInstallationId) {
      // Find or create the github_installations record
      let installation = await db.githubInstallations.findByInstallationId(String(githubInstallationId));

      if (!installation) {
        // Create a new installation record
        // We need to get more info about the installation - for now use user info
        installation = await db.githubInstallations.upsert({
          installationId: String(githubInstallationId),
          accountType: 'user', // Could be 'organization' - we'd need to detect this
          accountLogin: user.githubUsername || 'unknown',
          accountId: user.githubId || 'unknown',
          installedById: user.id,
          permissions: {},
          events: [],
        });
        console.log(`[nango-webhook] Created installation record for ${githubInstallationId}`);
      }

      installationUuid = installation.id;
    } else {
      console.warn('[nango-webhook] Could not get installation ID from Nango connection');
    }

    // Fetch repos the user has access to
    const { repositories: repos } = await nangoService.listGithubAppRepos(connectionId);

    // Sync repos to database
    for (const repo of repos) {
      await db.repositories.upsert({
        userId: user.id,
        githubFullName: repo.full_name,
        githubId: repo.id,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        nangoConnectionId: connectionId,
        installationId: installationUuid,
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      });
    }

    // Clear any pending installation request
    await db.users.clearPendingInstallationRequest(user.id);

    console.log(`[nango-webhook] Synced ${repos.length} repos for ${user.githubUsername} (installation: ${githubInstallationId || 'unknown'})`);

  } catch (error: unknown) {
    const err = error as { message?: string };
    if (err.message?.includes('403')) {
      // Org approval pending
      await db.users.setPendingInstallationRequest(user.id);
      console.log(`[nango-webhook] Org approval pending for ${user.githubUsername}`);
    } else {
      throw error;
    }
  }
}
