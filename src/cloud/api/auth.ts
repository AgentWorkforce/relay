/**
 * Auth API Routes
 *
 * Handles GitHub OAuth for user login.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getConfig } from '../config';
import { db } from '../db';

export const authRouter = Router();

// Extend session type
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    githubToken?: string;
    oauthState?: string;
  }
}

/**
 * GET /api/auth/github
 * Start GitHub OAuth flow
 */
authRouter.get('/github', (req: Request, res: Response) => {
  const config = getConfig();
  const state = crypto.randomBytes(16).toString('hex');

  // Store state in session for CSRF protection
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: `${config.publicUrl}/api/auth/github/callback`,
    scope: 'read:user user:email repo',
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

/**
 * GET /api/auth/github/callback
 * GitHub OAuth callback
 */
authRouter.get('/github/callback', async (req: Request, res: Response) => {
  const config = getConfig();
  const { code, state } = req.query;

  // Verify state
  if (state !== req.session.oauthState) {
    return res.status(400).json({ error: 'Invalid state parameter' });
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }

    const accessToken = tokenData.access_token;

    // Get user info
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    const userData = await userResponse.json();

    // Get user email if not public
    let email = userData.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      const emails = await emailsResponse.json();
      const primaryEmail = emails.find((e: any) => e.primary);
      email = primaryEmail?.email;
    }

    // Create or update user
    const user = await db.users.upsert({
      githubId: String(userData.id),
      githubUsername: userData.login,
      email,
      avatarUrl: userData.avatar_url,
    });

    // Store GitHub token as a credential
    await db.credentials.upsert({
      userId: user.id,
      provider: 'github',
      accessToken,
      scopes: ['read:user', 'user:email', 'repo'],
      providerAccountId: String(userData.id),
      providerAccountEmail: email,
    });

    // Set session
    req.session.userId = user.id;
    req.session.githubToken = accessToken;
    delete req.session.oauthState;

    // Redirect to dashboard or onboarding
    const redirectTo = user.onboardingCompletedAt
      ? '/dashboard'
      : '/onboarding/providers';

    res.redirect(redirectTo);
  } catch (error) {
    console.error('GitHub OAuth error:', error);
    res.redirect('/login?error=oauth_failed');
  }
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

    res.json({
      id: user.id,
      githubUsername: user.githubUsername,
      email: user.email,
      avatarUrl: user.avatarUrl,
      plan: user.plan,
      connectedProviders,
      pendingInvites: pendingInvites.length,
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
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}
