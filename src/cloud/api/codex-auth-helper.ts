/**
 * Codex Auth Helper API
 *
 * Provides endpoints for the `npx agent-relay codex-auth` CLI command
 * to capture OAuth callbacks locally and send them to the cloud.
 *
 * This solves the "This site can't be reached" problem where Codex redirects
 * to localhost:1455 after auth but nothing is listening.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from './auth.js';

export const codexAuthHelperRouter = Router();

// Store pending auth sessions (sessionId -> session data mapping)
interface PendingAuthSession {
  userId: string;
  createdAt: Date;
  code?: string; // The auth code once received from the CLI
  state?: string; // OAuth state parameter for CSRF validation
}

const pendingAuthSessions = new Map<string, PendingAuthSession>();

// Clean up old sessions every minute
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pendingAuthSessions) {
    // Remove sessions older than 10 minutes
    if (now - session.createdAt.getTime() > 10 * 60 * 1000) {
      pendingAuthSessions.delete(id);
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
 * Returns an authSessionId that the CLI uses to send the auth code.
 */
codexAuthHelperRouter.post('/cli-session', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  const authSessionId = crypto.randomUUID();
  pendingAuthSessions.set(authSessionId, {
    userId,
    createdAt: new Date(),
  });

  console.log(`[codex-helper] Created CLI session ${authSessionId} for user ${userId}`);

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
