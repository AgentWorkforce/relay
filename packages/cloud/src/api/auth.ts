/**
 * Auth API Routes
 *
 * Session management routes.
 * User login is handled via Nango (see nango-auth.ts).
 * GitHub repo operations are in github-app.ts.
 */

import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';

export const authRouter = Router();

// Extend session type
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    githubToken?: string;
  }
}

/**
 * GET /api/auth/github
 * Redirect to Nango login flow
 * @deprecated Use /api/auth/nango/login-session instead
 */
authRouter.get('/github', (_req: Request, res: Response) => {
  res.redirect('/api/auth/nango/login-session');
});

/**
 * POST /api/auth/logout
 * Logout user
 */
authRouter.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

/**
 * GET /api/auth/me
 * Get current user
 */
authRouter.get('/me', async (req: Request, res: Response) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const user = await db.users.findById(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get connected providers
    const credentials = await db.credentials.findByUserId(user.id);
    const connectedProviders = credentials.map((c) => ({
      provider: c.provider,
      email: c.providerAccountEmail,
      connectedAt: c.createdAt,
    }));

    // Get pending invites
    const pendingInvites = await db.workspaceMembers.getPendingInvites(user.id);

    // Check for pending GitHub installation request
    const pendingGitHubApproval = !!user.pendingInstallationRequest;

    res.json({
      id: user.id,
      githubUsername: user.githubUsername,
      email: user.email,
      avatarUrl: user.avatarUrl,
      plan: user.plan,
      connectedProviders,
      pendingInvites: pendingInvites.length,
      pendingGitHubApproval,
      onboardingCompleted: !!user.onboardingCompletedAt,
    });
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * Middleware to require authentication
 */
export function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'SESSION_EXPIRED',
      message: 'Your session has expired. Please log in again.',
    });
  }
  next();
}

/**
 * GET /api/auth/session
 * Check if current session is valid
 */
authRouter.get('/session', async (req: Request, res: Response) => {
  if (!req.session.userId) {
    return res.json({
      authenticated: false,
      code: 'SESSION_EXPIRED',
      message: 'Your session has expired. Please log in again.',
    });
  }

  try {
    // Verify user still exists
    const user = await db.users.findById(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.json({
        authenticated: false,
        code: 'USER_NOT_FOUND',
        message: 'User account not found. Please log in again.',
      });
    }

    // Get connected providers
    const credentials = await db.credentials.findByUserId(user.id);
    const connectedProviders = credentials.map((c) => ({
      provider: c.provider,
      email: c.providerAccountEmail,
      connectedAt: c.createdAt,
    }));

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        githubUsername: user.githubUsername,
        email: user.email,
        avatarUrl: user.avatarUrl,
        plan: user.plan,
      },
      connectedProviders,
    });
  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({
      authenticated: false,
      code: 'SESSION_ERROR',
      message: 'An error occurred while checking your session.',
    });
  }
});
