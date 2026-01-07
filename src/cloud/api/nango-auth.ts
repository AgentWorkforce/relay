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

    // Check workspace status for frontend visibility
    const workspaces = await db.workspaces.findByUserId(userId);
    const primaryWorkspace = workspaces[0];

    res.json({
      ready: true,
      repos: reposFromConnection.map(r => ({
        id: r.id,
        fullName: r.githubFullName,
        isPrivate: r.isPrivate,
        defaultBranch: r.defaultBranch,
      })),
      workspace: primaryWorkspace ? {
        id: primaryWorkspace.id,
        name: primaryWorkspace.name,
        status: primaryWorkspace.status,
        publicUrl: primaryWorkspace.publicUrl,
      } : null,
      workspaceProvisioning: primaryWorkspace?.status === 'provisioning',
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
  const rawBody = (req as Request & { rawBody?: string }).rawBody || JSON.stringify(req.body);

  // Verify webhook signature if present
  const hasSignature = req.headers['x-nango-signature'] || req.headers['x-nango-hmac-sha256'];
  if (hasSignature) {
    if (!nangoService.verifyWebhookSignature(rawBody, req.headers as Record<string, string | string[] | undefined>)) {
      console.error('[nango-webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = req.body;
  console.log(`[nango-webhook] Received ${payload.type} event`);

  try {
    switch (payload.type) {
      case 'auth':
        await handleAuthWebhook(payload);
        break;

      case 'sync':
        console.log('[nango-webhook] Sync event received');
        break;

      case 'forward':
        await handleForwardWebhook(payload);
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
 * Check user's repo access and auto-add them to workspaces
 * Uses GitHub user OAuth to query accessible repos and persists them to database
 */
async function checkAndAutoAddToWorkspaces(userId: string, connectionId: string): Promise<void> {
  try {
    const user = await db.users.findById(userId);
    if (!user) return;

    console.log(`[nango-webhook] Checking workspace auto-add for ${user.githubUsername}`);

    // Query repos the user has access to via GitHub OAuth
    const { repositories } = await nangoService.listUserAccessibleRepos(connectionId, {
      perPage: 100,
      type: 'all',
    });

    const workspacesToJoin = new Set<string>();

    // Check for workspace memberships - only persist repos that match existing workspaces
    for (const repo of repositories) {
      // Check if any user has this repo linked to a workspace
      const allRepoRecords = await db.repositories.findByGithubFullName(repo.fullName);

      let matchedWorkspaceId: string | null = null;
      for (const record of allRepoRecords) {
        if (record.workspaceId) {
          workspacesToJoin.add(record.workspaceId);
          matchedWorkspaceId = record.workspaceId; // Save the workspaceId to copy
        }
      }

      // Only persist repos that are linked to workspaces
      if (matchedWorkspaceId) {
        await db.repositories.upsert({
          userId: user.id,
          githubFullName: repo.fullName,
          githubId: repo.id,
          isPrivate: repo.isPrivate,
          defaultBranch: repo.defaultBranch,
          nangoConnectionId: connectionId,
          workspaceId: matchedWorkspaceId, // Copy the workspaceId
          syncStatus: 'synced',
          lastSyncedAt: new Date(),
        });
      }
    }

    // Auto-add user to workspaces
    for (const workspaceId of workspacesToJoin) {
      const existingMembership = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!existingMembership) {
        const workspace = await db.workspaces.findById(workspaceId);
        if (workspace) {
          console.log(`[nango-webhook] Auto-adding ${user.githubUsername} to workspace ${workspace.name}`);
          await db.workspaceMembers.addMember({
            workspaceId,
            userId,
            role: 'member',
            invitedBy: workspace.userId,
          });
          await db.workspaceMembers.acceptInvite(workspaceId, userId);
        }
      }
    }

    console.log(`[nango-webhook] Synced ${repositories.length} repos, auto-added ${user.githubUsername} to ${workspacesToJoin.size} workspaces`);
  } catch (error) {
    console.error(`[nango-webhook] Error checking workspace auto-add:`, error);
    // Non-fatal - don't throw
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

    // Check for auto-add to workspaces based on repo access
    await checkAndAutoAddToWorkspaces(newUser.id, connectionId);
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

    // Check for auto-add using permanent connection
    await checkAndAutoAddToWorkspaces(existingUser.id, existingUser.nangoConnectionId);
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

  // Check for auto-add to workspaces
  await checkAndAutoAddToWorkspaces(existingUser.id, connectionId);
}

/**
 * Handle Nango forward webhook (GitHub events forwarded by Nango)
 */
async function handleForwardWebhook(payload: {
  type: 'forward';
  connectionId: string;
  providerConfigKey: string;
  payload: {
    action?: string;
    installation?: {
      id: number;
      account: { login: string; id: number; type: string };
      permissions: Record<string, string>;
      events: string[];
    };
    repositories?: Array<{ id: number; full_name: string; private: boolean }>;
    repositories_added?: Array<{ id: number; full_name: string; private: boolean }>;
    repositories_removed?: Array<{ id: number; full_name: string }>;
    sender?: { id: number; login: string };
  };
}): Promise<void> {
  const githubPayload = payload.payload;

  console.log(`[nango-webhook] Forward event: action=${githubPayload.action} from ${payload.providerConfigKey}`);

  // Only process GitHub App events
  if (payload.providerConfigKey !== NANGO_INTEGRATIONS.GITHUB_APP) {
    console.log('[nango-webhook] Ignoring forward event from non-GitHub-App integration');
    return;
  }

  try {
    // Determine event type from payload structure
    if (githubPayload.installation && githubPayload.action === 'created' && githubPayload.repositories) {
      // Installation created event
      await handleInstallationForward(githubPayload, payload.connectionId);
    } else if (githubPayload.repositories_added || githubPayload.repositories_removed) {
      // Installation repositories added/removed
      await handleInstallationRepositoriesForward(githubPayload, payload.connectionId);
    } else {
      console.log(`[nango-webhook] Unhandled forward event structure: action=${githubPayload.action}`);
    }
  } catch (error) {
    console.error(`[nango-webhook] Error processing forward event:`, error);
    throw error;
  }
}

/**
 * Handle GitHub installation events forwarded by Nango
 */
async function handleInstallationForward(
  body: {
    action?: string;
    installation?: {
      id: number;
      account: { login: string; id: number; type: string };
      permissions: Record<string, string>;
      events: string[];
    };
    repositories?: Array<{ id: number; full_name: string; private: boolean }>;
    sender?: { id: number; login: string };
  },
  connectionId: string
): Promise<void> {
  const { action, installation, repositories, sender } = body;
  if (!installation || !sender) return;

  const installationId = String(installation.id);
  console.log(`[nango-webhook] Installation ${action}: ${installation.account.login} (${installationId})`);

  if (action === 'created') {
    // Find user by GitHub ID
    const user = await db.users.findByGithubId(String(sender.id));

    // Create/update installation record
    await db.githubInstallations.upsert({
      installationId,
      accountType: installation.account.type.toLowerCase(),
      accountLogin: installation.account.login,
      accountId: String(installation.account.id),
      installedById: user?.id ?? null,
      permissions: installation.permissions,
      events: installation.events,
    });

    // Sync repositories if provided
    if (repositories && user) {
      const dbInstallation = await db.githubInstallations.findByInstallationId(installationId);
      if (dbInstallation) {
        const workspacesToJoin = new Set<string>();

        for (const repo of repositories) {
          const syncedRepo = await db.repositories.upsert({
            userId: user.id,
            githubFullName: repo.full_name,
            githubId: repo.id,
            isPrivate: repo.private,
            installationId: dbInstallation.id,
            nangoConnectionId: connectionId,
            syncStatus: 'synced',
            lastSyncedAt: new Date(),
          });

          // Check if repo is part of an existing workspace
          // Look for ANY user's record of this repo that has a workspaceId
          if (syncedRepo.workspaceId) {
            workspacesToJoin.add(syncedRepo.workspaceId);
          } else {
            // Check if other users have this repo linked to a workspace
            const allRepoRecords = await db.repositories.findByGithubFullName(repo.full_name);
            for (const otherRecord of allRepoRecords) {
              if (otherRecord.workspaceId && otherRecord.userId !== user.id) {
                workspacesToJoin.add(otherRecord.workspaceId);
              }
            }
          }
        }

        // Auto-join user to workspaces for repos they have access to
        for (const workspaceId of workspacesToJoin) {
          const existingMembership = await db.workspaceMembers.findMembership(workspaceId, user.id);
          if (!existingMembership) {
            const workspace = await db.workspaces.findById(workspaceId);
            if (workspace) {
              console.log(`[nango-webhook] Auto-adding ${user.githubUsername} to workspace ${workspace.name}`);
              await db.workspaceMembers.addMember({
                workspaceId,
                userId: user.id,
                role: 'member',
                invitedBy: workspace.userId,
              });
              await db.workspaceMembers.acceptInvite(workspaceId, user.id);
            }
          }
        }

        console.log(`[nango-webhook] Installation created for ${installation.account.login}, auto-joined ${workspacesToJoin.size} workspaces`);
      }
    }
  }
}

/**
 * Handle installation_repositories events forwarded by Nango
 */
async function handleInstallationRepositoriesForward(
  body: {
    action?: string;
    installation?: { id: number; account: { login: string } };
    repositories_added?: Array<{ id: number; full_name: string; private: boolean }>;
    repositories_removed?: Array<{ id: number; full_name: string }>;
    sender?: { id: number; login: string };
  },
  connectionId: string
): Promise<void> {
  const { action, installation, repositories_added, repositories_removed, sender } = body;
  if (!installation || !sender) return;

  const installationId = String(installation.id);
  console.log(`[nango-webhook] Repositories ${action} for ${installation.account.login}`);

  // Find installation in database
  const dbInstallation = await db.githubInstallations.findByInstallationId(installationId);
  if (!dbInstallation) {
    console.error(`[nango-webhook] Installation ${installationId} not found in database`);
    return;
  }

  // Find user who triggered this
  const user = await db.users.findByGithubId(String(sender.id));
  if (!user) {
    console.error(`[nango-webhook] User ${sender.login} not found in database`);
    return;
  }

  if (action === 'added' && repositories_added) {
    const workspacesToJoin = new Set<string>();

    for (const repo of repositories_added) {
      const syncedRepo = await db.repositories.upsert({
        userId: user.id,
        githubFullName: repo.full_name,
        githubId: repo.id,
        isPrivate: repo.private,
        installationId: dbInstallation.id,
        nangoConnectionId: connectionId,
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      });

      // Check if repo is part of an existing workspace
      // Look for ANY user's record of this repo that has a workspaceId
      if (syncedRepo.workspaceId) {
        workspacesToJoin.add(syncedRepo.workspaceId);
      } else {
        // Check if other users have this repo linked to a workspace
        const allRepoRecords = await db.repositories.findByGithubFullName(repo.full_name);
        for (const otherRecord of allRepoRecords) {
          if (otherRecord.workspaceId && otherRecord.userId !== user.id) {
            workspacesToJoin.add(otherRecord.workspaceId);
          }
        }
      }
    }

    // Auto-join user to workspaces for repos they have access to
    for (const workspaceId of workspacesToJoin) {
      const existingMembership = await db.workspaceMembers.findMembership(workspaceId, user.id);
      if (!existingMembership) {
        const workspace = await db.workspaces.findById(workspaceId);
        if (workspace) {
          console.log(`[nango-webhook] Auto-adding ${user.githubUsername} to workspace ${workspace.name}`);
          await db.workspaceMembers.addMember({
            workspaceId,
            userId: user.id,
            role: 'member',
            invitedBy: workspace.userId,
          });
          await db.workspaceMembers.acceptInvite(workspaceId, user.id);
        }
      }
    }

    console.log(`[nango-webhook] Added ${repositories_added.length} repositories, auto-joined ${workspacesToJoin.size} workspaces`);
  }

  if (action === 'removed' && repositories_removed) {
    for (const repo of repositories_removed) {
      const repos = await db.repositories.findByUserId(user.id);
      const existingRepo = repos.find(r => r.githubFullName === repo.full_name);
      if (existingRepo) {
        await db.repositories.updateSyncStatus(existingRepo.id, 'access_removed');
      }
    }
    console.log(`[nango-webhook] Removed access to ${repositories_removed.length} repositories`);
  }
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

    // Track workspaces to auto-join
    const workspacesToJoin = new Set<string>();

    // Sync repos to database
    for (const repo of repos) {
      const syncedRepo = await db.repositories.upsert({
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

      // Check if this repo is part of an existing workspace
      // Look for ANY user's record of this repo that has a workspaceId
      if (syncedRepo.workspaceId) {
        workspacesToJoin.add(syncedRepo.workspaceId);
      } else {
        // Check if other users have this repo linked to a workspace
        const allRepoRecords = await db.repositories.findByGithubFullName(repo.full_name);
        for (const otherRecord of allRepoRecords) {
          if (otherRecord.workspaceId && otherRecord.userId !== user.id) {
            workspacesToJoin.add(otherRecord.workspaceId);
          }
        }
      }
    }

    // Auto-join user to workspaces for repos they have access to
    for (const workspaceId of workspacesToJoin) {
      // Check if already a member
      const existingMembership = await db.workspaceMembers.findMembership(workspaceId, user.id);
      if (!existingMembership) {
        // Get workspace owner to use as invitedBy
        const workspace = await db.workspaces.findById(workspaceId);
        if (workspace) {
          console.log(`[nango-webhook] Auto-adding ${user.githubUsername} to workspace ${workspace.name}`);
          await db.workspaceMembers.addMember({
            workspaceId,
            userId: user.id,
            role: 'member',
            invitedBy: workspace.userId, // Workspace owner invited them
          });
          // Auto-accept since they have GitHub repo access
          await db.workspaceMembers.acceptInvite(workspaceId, user.id);
        }
      }
    }

    // Clear any pending installation request
    await db.users.clearPendingInstallationRequest(user.id);

    console.log(`[nango-webhook] Synced ${repos.length} repos for ${user.githubUsername} (installation: ${githubInstallationId || 'unknown'}), auto-joined ${workspacesToJoin.size} workspaces`);

    // Note: We intentionally do NOT auto-provision workspaces here.
    // Users should go through the onboarding flow at /app to:
    // 1. Name their workspace
    // 2. Choose which repos to include
    // 3. Understand what they're creating

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

