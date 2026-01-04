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
 * Start CLI-based auth - spawns the CLI and captures auth URL
 */
onboardingRouter.post('/cli/:provider/start', async (req: Request, res: Response) => {
  const { provider } = req.params;
  const userId = req.session.userId!;

  const config = CLI_AUTH_CONFIG[provider];
  if (!config) {
    return res.status(400).json({
      error: 'Provider not supported for CLI auth',
      supportedProviders: Object.keys(CLI_AUTH_CONFIG),
    });
  }

  // Create session
  const sessionId = crypto.randomUUID();
  const session: CLIAuthSession = {
    userId,
    provider,
    status: 'starting',
    createdAt: new Date(),
    output: '',
  };
  activeSessions.set(sessionId, session);

  try {
    // Use shared PTY runner for CLI auth
    const ptyResult = await runCLIAuthViaPTY(config, {
      onAuthUrl: (url) => {
        session.authUrl = url;
        session.status = 'waiting_auth';
      },
      onPromptHandled: (description) => {
        console.log(`[onboarding] Auto-responded to: ${description}`);
      },
      onOutput: (data) => {
        session.output += data;
        if (matchesSuccessPattern(data, config.successPatterns)) {
          session.status = 'success';
        }
      },
    });

    // Update session with result
    if (ptyResult.success && !session.authUrl) {
      session.status = 'success';
      await extractCredentials(session, config);
    } else if (ptyResult.error && session.status === 'starting') {
      session.status = 'error';
      session.error = ptyResult.error;
    }

    // Return session info based on current state
    if (session.status === 'success' && !session.authUrl) {
      // Already authenticated - CLI exited successfully without auth URL
      activeSessions.delete(sessionId);
      res.json({
        sessionId,
        status: 'success',
        alreadyAuthenticated: true,
        message: `Already authenticated with ${config.displayName}`,
      });
    } else if (session.authUrl) {
      res.json({
        sessionId,
        status: 'waiting_auth',
        authUrl: session.authUrl,
        message: 'Open the auth URL to complete login',
      });
    } else if (session.status === 'error') {
      activeSessions.delete(sessionId);
      res.status(500).json({ error: session.error || 'CLI auth failed to start' });
    } else {
      // Still starting, return session ID to poll
      res.json({
        sessionId,
        status: 'starting',
        message: 'Auth session starting, poll for status',
      });
    }
  } catch (error) {
    activeSessions.delete(sessionId);
    console.error(`Error starting CLI auth for ${provider}:`, error);
    res.status(500).json({ error: 'Failed to start CLI authentication' });
  }
});

/**
 * GET /api/onboarding/cli/:provider/status/:sessionId
 * Check status of CLI auth session
 */
onboardingRouter.get('/cli/:provider/status/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const userId = req.session.userId!;

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
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

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // If token provided directly, use it
    let accessToken = token || session.token;

    // If no token yet, try to read from credentials file
    if (!accessToken) {
      const config = CLI_AUTH_CONFIG[provider];
      if (config) {
        await extractCredentials(session, config);
        accessToken = session.token;
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
    if (session.process) {
      try {
        session.process.kill();
      } catch {
        // Process may already be dead
      }
    }
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
onboardingRouter.post('/cli/:provider/cancel/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const userId = req.session.userId!;

  const session = activeSessions.get(sessionId);
  if (session?.userId === userId) {
    if (session.process) {
      try {
        session.process.kill();
      } catch {
        // Process may already be dead
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
