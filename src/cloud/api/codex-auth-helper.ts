/**
 * Codex Auth Helper API
 *
 * Provides endpoints for the `npx agent-relay codex-auth` CLI command.
 * Uses SSH tunneling to forward localhost:1455 to the workspace container,
 * allowing the Codex CLI's OAuth callback to work in remote/container environments.
 *
 * Flow:
 * 1. CLI gets workspace SSH info via /tunnel-info
 * 2. CLI establishes SSH tunnel: local:1455 -> container:1455
 * 3. User completes OAuth, browser redirects to localhost:1455
 * 4. Tunnel forwards to container's Codex CLI server
 * 5. Codex CLI exchanges code for tokens internally
 * 6. CLI polls for auth completion
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import { deriveSshPassword } from '../services/ssh-security.js';

export const codexAuthHelperRouter = Router();

// Store pending auth sessions (sessionId -> session data mapping)
interface PendingAuthSession {
  userId: string;
  createdAt: Date;
  code?: string; // The auth code once received from the CLI
  state?: string; // OAuth state parameter for CSRF validation
}

const pendingAuthSessions = new Map<string, PendingAuthSession>();

// Store pending CLI tokens (for SSH tunnel authentication)
interface PendingCliToken {
  userId: string;
  workspaceId: string;
  createdAt: Date;
  authUrl?: string; // OAuth URL to open
  sessionId?: string; // Session ID for credential storage
}

const pendingCliTokens = new Map<string, PendingCliToken>();

// Clean up old sessions every minute
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pendingAuthSessions) {
    // Remove sessions older than 10 minutes
    if (now - session.createdAt.getTime() > 10 * 60 * 1000) {
      pendingAuthSessions.delete(id);
    }
  }
  // Also clean up CLI tokens
  for (const [id, token] of pendingCliTokens) {
    // Remove tokens older than 10 minutes
    if (now - token.createdAt.getTime() > 10 * 60 * 1000) {
      pendingCliTokens.delete(id);
    }
  }
}, 60000);

/**
 * Stop the cleanup interval. Call this on server shutdown.
 */
export function stopCodexAuthCleanup(): void {
  clearInterval(cleanupInterval);
}

/**
 * POST /api/auth/codex-helper/cli-session
 * Create a new auth session for the CLI command.
 * Returns workspace info and CLI command for SSH tunnel approach.
 */
codexAuthHelperRouter.post('/cli-session', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, authUrl, sessionId: onboardingSessionId } = req.body;

  // If workspace ID provided, return SSH tunnel command
  if (workspaceId) {
    try {
      const workspace = await db.workspaces.findById(workspaceId);

      if (!workspace || workspace.userId !== userId) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      // Generate a one-time CLI token for authentication
      const cliToken = crypto.randomUUID();
      pendingCliTokens.set(cliToken, {
        userId,
        workspaceId,
        createdAt: new Date(),
        authUrl, // Store authUrl so CLI can retrieve it
        sessionId: onboardingSessionId, // Store sessionId for credential storage
      });

      console.log(`[codex-helper] Created CLI session for workspace ${workspaceId} with token ${cliToken.slice(0, 8)}...`);

      const cloudUrl = process.env.PUBLIC_URL || 'https://agent-relay.com';

      // Generate the CLI command with workspace ID and token
      res.json({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        expiresIn: 600, // 10 minutes
        command: `npx agent-relay codex-auth --workspace=${workspaceId} --token=${cliToken}`,
        commandWithUrl: `npx agent-relay codex-auth --workspace=${workspaceId} --token=${cliToken} --cloud-url=${cloudUrl}`,
      });
      return;
    } catch (error) {
      console.error('[codex-helper] Error creating CLI session:', error);
      return res.status(500).json({ error: 'Failed to create CLI session' });
    }
  }

  // Legacy: token-based session (for backwards compatibility)
  const authSessionId = crypto.randomUUID();
  pendingAuthSessions.set(authSessionId, {
    userId,
    createdAt: new Date(),
  });

  console.log(`[codex-helper] Created legacy CLI session ${authSessionId} for user ${userId}`);

  res.json({
    authSessionId,
    expiresIn: 600, // 10 minutes
    command: `npx agent-relay codex-auth --token=${authSessionId}`,
  });
});

/**
 * POST /api/auth/codex-helper/callback
 * Receives the auth code from the CLI.
 * No auth required - validated by authSessionId.
 */
codexAuthHelperRouter.post('/callback', async (req: Request, res: Response) => {
  const { authSessionId, code, state, error } = req.body;

  if (!authSessionId) {
    return res.status(400).json({ error: 'Missing authSessionId' });
  }

  const session = pendingAuthSessions.get(authSessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (error) {
    console.log(`[codex-helper] Auth error for session ${authSessionId}:`, error);
    pendingAuthSessions.delete(authSessionId);
    return res.json({ success: false, error });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing auth code' });
  }

  // Store the code and state so the polling endpoint can retrieve them
  session.code = code;
  session.state = state; // Store state for CSRF validation
  pendingAuthSessions.set(authSessionId, session);

  console.log(`[codex-helper] Auth code received for session ${authSessionId}`);
  res.json({ success: true, message: 'Auth code received. You can close this terminal.' });
});

/**
 * GET /api/auth/codex-helper/status/:authSessionId
 * Check if auth code has been received.
 * The dashboard polls this to know when the CLI has captured the callback.
 */
codexAuthHelperRouter.get('/status/:authSessionId', requireAuth, async (req: Request, res: Response) => {
  const { authSessionId } = req.params;
  const session = pendingAuthSessions.get(authSessionId);

  if (!session || session.userId !== req.session.userId) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.code) {
    // Clean up session after successful retrieval (code is single-use)
    const code = session.code;
    const state = session.state;
    pendingAuthSessions.delete(authSessionId);

    return res.json({
      ready: true,
      code,
      state, // Return state for CSRF validation
    });
  }

  res.json({ ready: false });
});

/**
 * GET /api/auth/codex-helper/tunnel-info/:workspaceId
 * Get SSH tunnel info for establishing port forwarding to a workspace.
 * Returns host, port, user, and password for SSH connection.
 *
 * Authentication: Requires either session auth OR a valid CLI token.
 */
codexAuthHelperRouter.get('/tunnel-info/:workspaceId', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const { token } = req.query;

  // Authenticate via CLI token or session
  let userId: string | undefined;

  if (token && typeof token === 'string') {
    // CLI token authentication
    const cliToken = pendingCliTokens.get(token);
    if (!cliToken) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (cliToken.workspaceId !== workspaceId) {
      return res.status(403).json({ error: 'Token does not match workspace' });
    }
    userId = cliToken.userId;
    // Don't delete token - it's also used for auth-status polling
    // Cleanup interval will remove it after 10 minutes
    console.log(`[codex-helper] CLI token used for workspace ${workspaceId}`);
  } else if (req.session?.userId) {
    // Session authentication
    userId = req.session.userId;
  } else {
    return res.status(401).json({ error: 'Authentication required. Provide token query parameter or valid session.' });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);

    if (!workspace || workspace.userId !== userId) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.status !== 'running') {
      return res.status(400).json({ error: 'Workspace is not running' });
    }

    // Parse workspace URL to get host
    const publicUrl = workspace.publicUrl;
    if (!publicUrl) {
      return res.status(400).json({ error: 'Workspace URL not available' });
    }

    const url = new URL(publicUrl);
    const host = url.hostname;
    const apiPort = parseInt(url.port, 10) || 80;

    // SSH connection info varies by environment:
    // - Fly.io: Use public fly.dev hostname with port 2222 (exposed via TCP service)
    // - Local Docker: Use localhost with derived SSH port (22000 + apiPort - 3000)
    const isOnFly = !!process.env.FLY_APP_NAME;
    const isLocalDocker = (host === 'localhost' || host === '127.0.0.1') && apiPort >= 3000;

    let sshHost: string;
    let sshPort: number;

    if (isOnFly) {
      // Fly.io public hostname - SSH is exposed as a public TCP service on port 2222
      // Users can SSH directly from their machine to {app}.fly.dev:2222
      const appName = `ar-${workspace.id.substring(0, 8)}`;
      sshHost = `${appName}.fly.dev`;
      sshPort = 2222;
    } else if (isLocalDocker) {
      // Local Docker: SSH port is derived from API port
      // API port 3500 -> SSH port 22500 (formula: 22000 + apiPort - 3000)
      sshHost = 'localhost';
      sshPort = 22000 + (apiPort - 3000);
    } else {
      // Default fallback
      sshHost = host;
      sshPort = 2222;
    }

    // SSH password is derived per-workspace for security
    // Each workspace gets a unique password based on its ID + secret salt
    const sshPassword = deriveSshPassword(workspace.id);

    // Get authUrl from CLI token if available
    let authUrl: string | undefined;
    if (token && typeof token === 'string') {
      const cliToken = pendingCliTokens.get(token);
      authUrl = cliToken?.authUrl;
    }

    res.json({
      host: sshHost,
      port: sshPort,
      user: 'workspace',
      password: sshPassword,
      tunnelPort: 1455, // Codex OAuth callback port
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      authUrl, // OAuth URL if available (set by dashboard)
    });
  } catch (error) {
    console.error('[codex-helper] Error getting tunnel info:', error);
    res.status(500).json({ error: 'Failed to get tunnel info' });
  }
});

/**
 * GET /api/auth/codex-helper/auth-status/:workspaceId
 * Poll for Codex authentication completion in a workspace.
 * The CLI uses this after establishing the tunnel to know when auth is done.
 *
 * Authentication: Requires either session auth OR a valid CLI token.
 */
codexAuthHelperRouter.get('/auth-status/:workspaceId', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const { token } = req.query;

  // Authenticate via CLI token or session
  let userId: string | undefined;

  if (token && typeof token === 'string') {
    // CLI token authentication
    const cliToken = pendingCliTokens.get(token);
    if (!cliToken) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (cliToken.workspaceId !== workspaceId) {
      return res.status(403).json({ error: 'Token does not match workspace' });
    }
    userId = cliToken.userId;
  } else if (req.session?.userId) {
    // Session authentication
    userId = req.session.userId;
  } else {
    return res.status(401).json({ error: 'Authentication required. Provide token query parameter or valid session.' });
  }

  try {
    const workspace = await db.workspaces.findById(workspaceId);

    if (!workspace || workspace.userId !== userId) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (!workspace.publicUrl) {
      return res.status(400).json({ error: 'Workspace URL not available' });
    }

    // Check with workspace daemon if Codex is authenticated
    const response = await fetch(`${workspace.publicUrl}/auth/cli/openai/check`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json() as { authenticated: boolean };
      return res.json({ authenticated: data.authenticated });
    }

    res.json({ authenticated: false });
  } catch (error) {
    // Workspace might not be reachable, return false
    res.json({ authenticated: false });
  }
});
