/**
 * Onboarding API Routes
 *
 * Handles CLI proxy authentication for Claude Code and other providers.
 * Spawns CLI tools via PTY to get auth URLs, captures tokens.
 *
 * We use node-pty instead of child_process.spawn because:
 * 1. Many CLIs detect if they're in a TTY and behave differently
 * 2. Interactive OAuth flows often require TTY for proper output
 * 3. PTY ensures the CLI outputs auth URLs correctly
 */

import { Router, Request, Response } from 'express';
import type { IPty } from 'node-pty';
import * as crypto from 'crypto';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import { vault } from '../vault/index.js';

// Re-export from shared module for backward compatibility
export {
  CLI_AUTH_CONFIG,
  runCLIAuthViaPTY,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
  validateProviderConfig,
  validateAllProviderConfigs,
  getSupportedProviders,
  type CLIAuthConfig,
  type PTYAuthResult,
  type PTYAuthOptions,
  type PromptHandler,
} from './cli-pty-runner.js';

import {
  CLI_AUTH_CONFIG,
  runCLIAuthViaPTY,
  matchesSuccessPattern,
} from './cli-pty-runner.js';

export const onboardingRouter = Router();

// All routes require authentication
onboardingRouter.use(requireAuth);

/**
 * Active CLI auth sessions
 * Maps sessionId -> { process, authUrl, status, token }
 */
interface CLIAuthSession {
  userId: string;
  provider: string;
  process?: IPty;
  authUrl?: string;
  callbackUrl?: string;
  status: 'starting' | 'waiting_auth' | 'success' | 'error' | 'timeout';
  token?: string;
  error?: string;
  createdAt: Date;
  output: string; // Accumulated output for debugging
}

const activeSessions = new Map<string, CLIAuthSession>();

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  activeSessions.forEach((session, id) => {
    // Remove sessions older than 10 minutes
    if (now - session.createdAt.getTime() > 10 * 60 * 1000) {
      if (session.process) {
        try {
          session.process.kill();
        } catch {
          // Process may already be dead
        }
      }
      activeSessions.delete(id);
    }
  });
}, 60000);

/**
 * POST /api/onboarding/cli/:provider/start
 * Start CLI-based auth - forwards to workspace daemon if available
 *
 * CLI auth requires a running workspace since CLI tools are installed there.
 * For onboarding without a workspace, users should use the API key flow.
 */
onboardingRouter.post('/cli/:provider/start', async (req: Request, res: Response) => {
  const { provider } = req.params;
  const userId = req.session.userId!;
  const { workspaceId } = req.body; // Optional: specific workspace to use

  const config = CLI_AUTH_CONFIG[provider];
  if (!config) {
    return res.status(400).json({
      error: 'Provider not supported for CLI auth',
      supportedProviders: Object.keys(CLI_AUTH_CONFIG),
    });
  }

  try {
    // Find a running workspace to use for CLI auth
    let workspace;
    if (workspaceId) {
      workspace = await db.workspaces.findById(workspaceId);
      if (!workspace || workspace.userId !== userId) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
    } else {
      // Find any running workspace for this user
      const workspaces = await db.workspaces.findByUserId(userId);
      workspace = workspaces.find(w => w.status === 'running' && w.publicUrl);
    }

    if (!workspace || workspace.status !== 'running' || !workspace.publicUrl) {
      return res.status(400).json({
        error: 'CLI auth requires a running workspace',
        code: 'NO_RUNNING_WORKSPACE',
        message: 'Please start a workspace first, or use the API key input to connect your provider.',
        hint: 'You can create a workspace without providers and connect them afterward using CLI auth.',
      });
    }

    // Forward auth request to workspace daemon
    const workspaceUrl = workspace.publicUrl.replace(/\/$/, '');
    const authResponse = await fetch(`${workspaceUrl}/auth/cli/${provider}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!authResponse.ok) {
      const errorData = await authResponse.json().catch(() => ({})) as { error?: string };
      return res.status(authResponse.status).json({
        error: errorData.error || 'Failed to start CLI auth in workspace',
      });
    }

    const workspaceSession = await authResponse.json() as {
      sessionId: string;
      status?: string;
      authUrl?: string;
    };

    // Create cloud session to track this
    const sessionId = crypto.randomUUID();
    const session: CLIAuthSession = {
      userId,
      provider,
      status: (workspaceSession.status as CLIAuthSession['status']) || 'starting',
      authUrl: workspaceSession.authUrl,
      createdAt: new Date(),
      output: '',
    };

    // Store workspace info for status polling
    (session as CLIAuthSession & { workspaceUrl?: string; workspaceSessionId?: string }).workspaceUrl = workspaceUrl;
    (session as CLIAuthSession & { workspaceUrl?: string; workspaceSessionId?: string }).workspaceSessionId = workspaceSession.sessionId;

    activeSessions.set(sessionId, session);

    res.json({
      sessionId,
      status: session.status,
      authUrl: session.authUrl,
      workspaceId: workspace.id,
      message: session.authUrl ? 'Open the auth URL to complete login' : 'Auth session starting, poll for status',
    });
  } catch (error) {
    console.error(`Error starting CLI auth for ${provider}:`, error);
    res.status(500).json({ error: 'Failed to start CLI authentication' });
  }
});

/**
 * GET /api/onboarding/cli/:provider/status/:sessionId
 * Check status of CLI auth session - forwards to workspace daemon
 */
onboardingRouter.get('/cli/:provider/status/:sessionId', async (req: Request, res: Response) => {
  const { provider, sessionId } = req.params;
  const userId = req.session.userId!;

  const session = activeSessions.get(sessionId) as CLIAuthSession & { workspaceUrl?: string; workspaceSessionId?: string } | undefined;
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // If we have workspace info, poll the workspace for status
  if (session.workspaceUrl && session.workspaceSessionId) {
    try {
      const statusResponse = await fetch(
        `${session.workspaceUrl}/auth/cli/${provider}/status/${session.workspaceSessionId}`
      );
      if (statusResponse.ok) {
        const workspaceStatus = await statusResponse.json() as {
          status?: string;
          authUrl?: string;
          error?: string;
        };
        // Update local session with workspace status
        session.status = (workspaceStatus.status as CLIAuthSession['status']) || session.status;
        session.authUrl = workspaceStatus.authUrl || session.authUrl;
        session.error = workspaceStatus.error;
      }
    } catch (err) {
      console.error('[onboarding] Failed to poll workspace status:', err);
    }
  }

  res.json({
    status: session.status,
    authUrl: session.authUrl,
    error: session.error,
  });
});

/**
 * POST /api/onboarding/cli/:provider/complete/:sessionId
 * Mark CLI auth as complete and store credentials
 */
onboardingRouter.post('/cli/:provider/complete/:sessionId', async (req: Request, res: Response) => {
  const { provider, sessionId } = req.params;
  const userId = req.session.userId!;
  const { token } = req.body; // Optional: user can paste token directly

  const session = activeSessions.get(sessionId) as CLIAuthSession & { workspaceUrl?: string; workspaceSessionId?: string } | undefined;
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // If token provided directly, use it
    let accessToken = token || session.token;

    // If no token yet, try to get from workspace
    if (!accessToken && session.workspaceUrl && session.workspaceSessionId) {
      try {
        const credsResponse = await fetch(
          `${session.workspaceUrl}/auth/cli/${provider}/creds/${session.workspaceSessionId}`
        );
        if (credsResponse.ok) {
          const creds = await credsResponse.json() as { token?: string };
          accessToken = creds.token;
        }
      } catch (err) {
        console.error('[onboarding] Failed to get credentials from workspace:', err);
      }
    }

    if (!accessToken) {
      return res.status(400).json({
        error: 'No token found. Please complete authentication or paste your token.',
      });
    }

    // Store in vault
    await vault.storeCredential({
      userId,
      provider,
      accessToken,
      scopes: getProviderScopes(provider),
    });

    // Clean up session
    activeSessions.delete(sessionId);

    res.json({
      success: true,
      message: `${provider} connected successfully`,
    });
  } catch (error) {
    console.error(`Error completing CLI auth for ${provider}:`, error);
    res.status(500).json({ error: 'Failed to complete authentication' });
  }
});

/**
 * POST /api/onboarding/cli/:provider/cancel/:sessionId
 * Cancel a CLI auth session
 */
onboardingRouter.post('/cli/:provider/cancel/:sessionId', async (req: Request, res: Response) => {
  const { provider, sessionId } = req.params;
  const userId = req.session.userId!;

  const session = activeSessions.get(sessionId) as CLIAuthSession & { workspaceUrl?: string; workspaceSessionId?: string } | undefined;
  if (session?.userId === userId) {
    // Cancel on workspace side if applicable
    if (session.workspaceUrl && session.workspaceSessionId) {
      try {
        await fetch(
          `${session.workspaceUrl}/auth/cli/${provider}/cancel/${session.workspaceSessionId}`,
          { method: 'POST' }
        );
      } catch {
        // Ignore cancel errors
      }
    }
    activeSessions.delete(sessionId);
  }

  res.json({ success: true });
});

/**
 * POST /api/onboarding/token/:provider
 * Directly store a token (for manual paste flow)
 */
onboardingRouter.post('/token/:provider', async (req: Request, res: Response) => {
  const { provider } = req.params;
  const userId = req.session.userId!;
  const { token, email } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    // Validate token by making a test API call
    const isValid = await validateProviderToken(provider, token);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    // Store in vault
    await vault.storeCredential({
      userId,
      provider,
      accessToken: token,
      scopes: getProviderScopes(provider),
      providerAccountEmail: email,
    });

    res.json({
      success: true,
      message: `${provider} connected successfully`,
    });
  } catch (error) {
    console.error(`Error storing token for ${provider}:`, error);
    res.status(500).json({ error: 'Failed to store token' });
  }
});

/**
 * GET /api/onboarding/status
 * Get overall onboarding status
 */
onboardingRouter.get('/status', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const [user, credentials, repositories] = await Promise.all([
      db.users.findById(userId),
      db.credentials.findByUserId(userId),
      db.repositories.findByUserId(userId),
    ]);

    const connectedProviders = credentials.map(c => c.provider);
    const hasAIProvider = connectedProviders.some(p =>
      ['anthropic', 'openai', 'google'].includes(p)
    );

    res.json({
      steps: {
        github: { complete: connectedProviders.includes('github') },
        aiProvider: {
          complete: hasAIProvider,
          connected: connectedProviders.filter(p => p !== 'github'),
        },
        repository: {
          complete: repositories.length > 0,
          count: repositories.length,
        },
      },
      onboardingComplete: user?.onboardingCompletedAt != null,
      canCreateWorkspace: hasAIProvider && repositories.length > 0,
    });
  } catch (error) {
    console.error('Error getting onboarding status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /api/onboarding/complete
 * Mark onboarding as complete
 */
onboardingRouter.post('/complete', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    await db.users.completeOnboarding(userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

/**
 * Helper: Extract credentials from CLI credential file
 */
async function extractCredentials(
  session: CLIAuthSession,
  config: typeof CLI_AUTH_CONFIG[string]
): Promise<void> {
  if (!config.credentialPath) return;

  try {
    const fs = await import('fs/promises');
    const os = await import('os');
    const credPath = config.credentialPath.replace('~', os.homedir());
    const content = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(content);

    // Extract token based on provider structure
    if (session.provider === 'anthropic') {
      // Claude stores: { "oauth_token": "...", ... } or { "api_key": "..." }
      session.token = creds.oauth_token || creds.access_token || creds.api_key;
    } else if (session.provider === 'openai') {
      // Codex might store: { "token": "..." } or { "api_key": "..." }
      session.token = creds.token || creds.access_token || creds.api_key;
    }
  } catch (error) {
    // Credentials file doesn't exist or isn't readable yet
    console.log(`Could not read credentials file: ${error}`);
  }
}

/**
 * Helper: Get default scopes for a provider
 */
function getProviderScopes(provider: string): string[] {
  const scopes: Record<string, string[]> = {
    anthropic: ['claude-code:execute', 'user:read'],
    openai: ['codex:execute', 'chat:write'],
    google: ['generative-language'],
    github: ['read:user', 'user:email', 'repo'],
  };
  return scopes[provider] || [];
}

/**
 * Helper: Validate a provider token by making a test API call
 */
async function validateProviderToken(provider: string, token: string): Promise<boolean> {
  try {
    const endpoints: Record<string, { url: string; headers: Record<string, string> }> = {
      anthropic: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
        },
      },
      openai: {
        url: 'https://api.openai.com/v1/models',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      google: {
        url: 'https://generativelanguage.googleapis.com/v1/models',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    };

    const config = endpoints[provider];
    if (!config) return true; // Unknown provider, assume valid

    const response = await fetch(config.url, {
      method: provider === 'anthropic' ? 'POST' : 'GET',
      headers: config.headers,
      ...(provider === 'anthropic' && {
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
        }),
      }),
    });

    // 401/403 means invalid token, anything else (including rate limits) means valid
    return response.status !== 401 && response.status !== 403;
  } catch (error) {
    console.error(`Error validating ${provider} token:`, error);
    return false;
  }
}
