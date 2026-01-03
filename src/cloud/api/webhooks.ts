/**
 * Webhook API Routes
 *
 * Handles GitHub App webhooks for installation events.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getConfig } from '../config.js';
import { db } from '../db/index.js';

export const webhooksRouter = Router();

// GitHub webhook signature verification
function verifyGitHubSignature(payload: string, signature: string | undefined): boolean {
  if (!signature) return false;

  const config = getConfig();
  const secret = config.github.webhookSecret || config.github.clientSecret;

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * POST /api/webhooks/github
 * Handle GitHub App webhook events
 */
webhooksRouter.post('/github', async (req: Request, res: Response) => {
  const signature = req.get('x-hub-signature-256');
  const event = req.get('x-github-event');
  const deliveryId = req.get('x-github-delivery');

  // Get raw body for signature verification
  // Note: This requires raw body middleware to be set up
  const rawBody = JSON.stringify(req.body);

  // Verify signature
  if (!verifyGitHubSignature(rawBody, signature)) {
    console.error(`[webhook] Invalid signature for delivery ${deliveryId}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log(`[webhook] Received ${event} event (delivery: ${deliveryId})`);

  try {
    switch (event) {
      case 'installation':
        await handleInstallationEvent(req.body);
        break;

      case 'installation_repositories':
        await handleInstallationRepositoriesEvent(req.body);
        break;

      case 'push':
        // Future: trigger sync for push events
        console.log(`[webhook] Push to ${req.body.repository?.full_name}`);
        break;

      case 'pull_request':
        // Future: handle PR events
        console.log(`[webhook] PR ${req.body.action} on ${req.body.repository?.full_name}`);
        break;

      case 'issues':
        // Future: handle issue events
        console.log(`[webhook] Issue ${req.body.action} on ${req.body.repository?.full_name}`);
        break;

      default:
        console.log(`[webhook] Unhandled event: ${event}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error(`[webhook] Error processing ${event}:`, error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/**
 * Handle installation events (created, deleted, suspended, etc.)
 */
async function handleInstallationEvent(payload: {
  action: string;
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
      type: string;
    };
    permissions: Record<string, string>;
    events: string[];
    suspended_at: string | null;
    suspended_by?: { login: string };
  };
  sender: {
    id: number;
    login: string;
  };
  repositories?: Array<{
    id: number;
    full_name: string;
    private: boolean;
  }>;
}): Promise<void> {
  const { action, installation, sender, repositories } = payload;
  const installationId = String(installation.id);

  console.log(
    `[webhook] Installation ${action}: ${installation.account.login} (${installationId})`
  );

  switch (action) {
    case 'created': {
      // Find the user by their GitHub ID (the sender who installed the app)
      const user = await db.users.findByGithubId(String(sender.id));

      // Create/update the installation record
      await db.githubInstallations.upsert({
        installationId,
        accountType: installation.account.type.toLowerCase(),
        accountLogin: installation.account.login,
        accountId: String(installation.account.id),
        installedById: user?.id ?? null,
        permissions: installation.permissions,
        events: installation.events,
      });

      // If repositories were included, sync them
      if (repositories && user) {
        for (const repo of repositories) {
          const dbInstallation = await db.githubInstallations.findByInstallationId(installationId);
          if (dbInstallation) {
            await db.repositories.upsert({
              userId: user.id,
              githubFullName: repo.full_name,
              githubId: repo.id,
              isPrivate: repo.private,
              installationId: dbInstallation.id,
              syncStatus: 'synced',
              lastSyncedAt: new Date(),
            });
          }
        }
      }

      console.log(`[webhook] Created installation for ${installation.account.login}`);
      break;
    }

    case 'deleted': {
      // Remove the installation
      await db.githubInstallations.delete(installationId);
      console.log(`[webhook] Deleted installation for ${installation.account.login}`);
      break;
    }

    case 'suspend': {
      await db.githubInstallations.suspend(
        installationId,
        installation.suspended_by?.login || 'unknown'
      );
      console.log(`[webhook] Suspended installation for ${installation.account.login}`);
      break;
    }

    case 'unsuspend': {
      await db.githubInstallations.unsuspend(installationId);
      console.log(`[webhook] Unsuspended installation for ${installation.account.login}`);
      break;
    }

    case 'new_permissions_accepted': {
      // Update permissions
      await db.githubInstallations.updatePermissions(
        installationId,
        installation.permissions,
        installation.events
      );
      console.log(`[webhook] Updated permissions for ${installation.account.login}`);
      break;
    }

    default:
      console.log(`[webhook] Unhandled installation action: ${action}`);
  }
}

/**
 * Handle installation_repositories events (added/removed repos)
 */
async function handleInstallationRepositoriesEvent(payload: {
  action: 'added' | 'removed';
  installation: {
    id: number;
    account: { login: string };
  };
  repositories_added?: Array<{
    id: number;
    full_name: string;
    private: boolean;
  }>;
  repositories_removed?: Array<{
    id: number;
    full_name: string;
  }>;
  sender: {
    id: number;
    login: string;
  };
}): Promise<void> {
  const { action, installation, repositories_added, repositories_removed, sender } = payload;
  const installationId = String(installation.id);

  console.log(
    `[webhook] Repositories ${action} for ${installation.account.login}`
  );

  // Find the installation in our database
  const dbInstallation = await db.githubInstallations.findByInstallationId(installationId);
  if (!dbInstallation) {
    console.error(`[webhook] Installation ${installationId} not found in database`);
    return;
  }

  // Get the user who triggered this (should be the installedBy user)
  const user = await db.users.findByGithubId(String(sender.id));
  if (!user) {
    console.error(`[webhook] User ${sender.login} not found in database`);
    return;
  }

  if (action === 'added' && repositories_added) {
    for (const repo of repositories_added) {
      await db.repositories.upsert({
        userId: user.id,
        githubFullName: repo.full_name,
        githubId: repo.id,
        isPrivate: repo.private,
        installationId: dbInstallation.id,
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      });
    }
    console.log(`[webhook] Added ${repositories_added.length} repositories`);
  }

  if (action === 'removed' && repositories_removed) {
    // We don't delete repos, just remove the installation link
    // This preserves any user config while showing the repo is no longer accessible
    for (const repo of repositories_removed) {
      // Find the repo and clear its installation reference
      const repos = await db.repositories.findByUserId(user.id);
      const existingRepo = repos.find(r => r.githubFullName === repo.full_name);
      if (existingRepo) {
        // Update sync status to indicate repo access was removed
        await db.repositories.updateSyncStatus(existingRepo.id, 'access_removed');
      }
    }
    console.log(`[webhook] Removed access to ${repositories_removed.length} repositories`);
  }
}
