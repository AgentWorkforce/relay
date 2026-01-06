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

// Import for local use
import {
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
};

export const onboardingRouter = Router();

// Debug: log all requests to this router
onboardingRouter.use((req, res, next) => {
  console.log(`[onboarding] ${req.method} ${req.path} - body:`, JSON.stringify(req.body));
  next();
});

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
  refreshToken?: string;
  tokenExpiresAt?: Date;
  error?: string;
  /** User-friendly hint for resolving errors */
  errorHint?: string;
  /** Whether the error can be resolved by retrying */
  recoverable?: boolean;
  createdAt: Date;
  output: string; // Accumulated output for debugging
  // Workspace delegation fields (set when auth runs in workspace daemon)
  workspaceUrl?: string;
  workspaceSessionId?: string;
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
  console.log('[onboarding] Route handler entered! provider:', req.params.provider);
  const { provider } = req.params;
  const userId = req.session.userId!;
  const { workspaceId, useDeviceFlow } = req.body; // Optional: specific workspace, device flow option
  console.log('[onboarding] userId:', userId, 'workspaceId:', workspaceId, 'useDeviceFlow:', useDeviceFlow);

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
      if (!workspace) {
        console.log(`[onboarding] Workspace ${workspaceId} not found in database`);
        return res.status(404).json({ error: 'Workspace not found' });
      }
      if (workspace.userId !== userId) {
        console.log(`[onboarding] Workspace ${workspaceId} belongs to ${workspace.userId}, not ${userId}`);
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
    // When running in Docker, localhost refers to the container, not the host
    // Use host.docker.internal on Mac/Windows to reach the host machine
    // When running on Fly.io, use internal networking (.internal) instead of public DNS
    let workspaceUrl = workspace.publicUrl.replace(/\/$/, '');

    // Detect Fly.io by checking FLY_APP_NAME env var
    const isOnFly = !!process.env.FLY_APP_NAME;

    // Detect Docker by checking for /.dockerenv file or RUNNING_IN_DOCKER env var
    const isInDocker = process.env.RUNNING_IN_DOCKER === 'true' ||
                       await import('fs').then(fs => fs.existsSync('/.dockerenv')).catch(() => false);

    console.log('[onboarding] isOnFly:', isOnFly, 'isInDocker:', isInDocker);

    if (isOnFly && workspaceUrl.includes('.fly.dev')) {
      // Use Fly.io internal networking for server-to-server communication
      // ar-583f273b.fly.dev -> http://ar-583f273b.internal:3888
      // .internal uses IPv6 and works by default for apps in the same org
      const appName = workspaceUrl.match(/https?:\/\/([^.]+)\.fly\.dev/)?.[1];
      if (appName) {
        workspaceUrl = `http://${appName}.internal:3888`;
        console.log('[onboarding] Using Fly internal network:', workspaceUrl);
      }
    } else if (isInDocker && workspaceUrl.includes('localhost')) {
      workspaceUrl = workspaceUrl.replace('localhost', 'host.docker.internal');
      console.log('[onboarding] Translated localhost to host.docker.internal');
    }
    const targetUrl = `${workspaceUrl}/auth/cli/${provider}/start`;
    console.log('[onboarding] Forwarding to workspace daemon:', targetUrl);

    const authResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useDeviceFlow }),
    });

    console.log('[onboarding] Workspace daemon response:', authResponse.status);

    if (!authResponse.ok) {
      const errorData = await authResponse.json().catch(() => ({})) as { error?: string };
      console.log('[onboarding] Workspace daemon error:', errorData);
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
      // Store workspace info for status polling and auth code forwarding
      workspaceUrl,
      workspaceSessionId: workspaceSession.sessionId,
    };

    activeSessions.set(sessionId, session);
    console.log('[onboarding] Session created:', { sessionId, workspaceUrl, workspaceSessionId: workspaceSession.sessionId });

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

  const session = activeSessions.get(sessionId);
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
          errorHint?: string;
          recoverable?: boolean;
        };
        // Update local session with workspace status
        session.status = (workspaceStatus.status as CLIAuthSession['status']) || session.status;
        session.authUrl = workspaceStatus.authUrl || session.authUrl;
        session.error = workspaceStatus.error;
        session.errorHint = workspaceStatus.errorHint;
        session.recoverable = workspaceStatus.recoverable;
      }
    } catch (err) {
      console.error('[onboarding] Failed to poll workspace status:', err);
    }
  }

  res.json({
    status: session.status,
    authUrl: session.authUrl,
    error: session.error,
    errorHint: session.errorHint,
    recoverable: session.recoverable,
  });
});

/**
 * POST /api/onboarding/cli/:provider/complete/:sessionId
 * Mark CLI auth as complete and store credentials
 *
 * Handles two modes:
 * 1. Workspace delegation: Forwards to workspace daemon to complete auth, then fetches credentials
 * 2. Direct: Uses token from body or session
 */
onboardingRouter.post('/cli/:provider/complete/:sessionId', async (req: Request, res: Response) => {
  const { provider, sessionId } = req.params;
  const userId = req.session.userId!;
  const { token, authCode } = req.body; // token for direct mode, authCode for Codex redirect

  console.log(`[onboarding] POST /cli/${provider}/complete/${sessionId} - token: ${token ? 'provided' : 'none'}, authCode: ${authCode ? 'provided' : 'none'}`);

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    let accessToken = token || session.token;
    let refreshToken = session.refreshToken;
    let _tokenExpiresAt = session.tokenExpiresAt;

    // If using workspace delegation, forward complete request first
    if (session.workspaceUrl && session.workspaceSessionId) {
      // Forward authCode to workspace if provided (for Codex-style redirects)
      if (authCode) {
        const backendProviderId = provider === 'anthropic' ? 'anthropic' : provider;
        const targetUrl = `${session.workspaceUrl}/auth/cli/${backendProviderId}/complete/${session.workspaceSessionId}`;
        console.log('[onboarding] Forwarding complete request to workspace:', targetUrl);

        const completeResponse = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authCode }),
        });

        if (!completeResponse.ok) {
          const errorData = await completeResponse.json().catch(() => ({})) as { error?: string };
          return res.status(completeResponse.status).json({
            error: errorData.error || 'Failed to complete authentication in workspace',
          });
        }
        session.status = 'success';
      }

      // Fetch credentials from workspace with retry
      // Credentials may not be immediately available after OAuth completes
      if (!accessToken) {
        const MAX_CREDS_RETRIES = 5;
        const CREDS_RETRY_DELAY = 1000; // 1 second between retries

        for (let attempt = 1; attempt <= MAX_CREDS_RETRIES; attempt++) {
          try {
            console.log(`[onboarding] Fetching credentials from workspace (attempt ${attempt}/${MAX_CREDS_RETRIES})`);
            const credsResponse = await fetch(
              `${session.workspaceUrl}/auth/cli/${provider}/creds/${session.workspaceSessionId}`
            );

            if (credsResponse.ok) {
              const creds = await credsResponse.json() as {
                token?: string;
                refreshToken?: string;
                tokenExpiresAt?: string;
              };
              accessToken = creds.token;
              refreshToken = creds.refreshToken;
              if (creds.tokenExpiresAt) {
                _tokenExpiresAt = new Date(creds.tokenExpiresAt);
              }
              console.log('[onboarding] Fetched credentials from workspace:', {
                hasToken: !!accessToken,
                hasRefreshToken: !!refreshToken,
                attempt,
              });
              break; // Success, exit retry loop
            }

            // Check if it's an error state (not just "not ready yet")
            const errorBody = await credsResponse.json().catch(() => ({})) as {
              status?: string;
              error?: string;
              errorHint?: string;
              recoverable?: boolean;
            };

            if (errorBody.status === 'error') {
              // Auth failed, don't retry
              console.error('[onboarding] Auth failed in workspace:', errorBody);
              return res.status(400).json({
                error: errorBody.error || 'Authentication failed',
                errorHint: errorBody.errorHint,
                recoverable: errorBody.recoverable,
              });
            }

            // If not ready yet and we have more retries, wait and try again
            if (attempt < MAX_CREDS_RETRIES) {
              console.log(`[onboarding] Credentials not ready yet, retrying in ${CREDS_RETRY_DELAY}ms...`);
              await new Promise(resolve => setTimeout(resolve, CREDS_RETRY_DELAY));
            }
          } catch (err) {
            console.error(`[onboarding] Failed to get credentials from workspace (attempt ${attempt}):`, err);
            if (attempt < MAX_CREDS_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, CREDS_RETRY_DELAY));
            }
          }
        }
      }
    }

    if (!accessToken) {
      return res.status(400).json({
        error: 'No token found. Please complete authentication or paste your token.',
      });
    }

    // Mark provider as connected (tokens are not stored centrally - CLI tools
    // authenticate directly on workspace instances)
    await db.credentials.upsert({
      userId,
      provider,
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
 * POST /api/onboarding/cli/:provider/code/:sessionId
 * Submit auth code to the CLI PTY session
 * Used when OAuth returns a code that must be pasted into the CLI
 */
onboardingRouter.post('/cli/:provider/code/:sessionId', async (req: Request, res: Response) => {
  const { provider, sessionId } = req.params;
  const userId = req.session.userId!;
  const { code } = req.body;

  console.log('[onboarding] Auth code submission request:', { provider, sessionId, codeLength: code?.length });

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Auth code is required' });
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    console.log('[onboarding] Session not found:', { sessionId, activeSessions: Array.from(activeSessions.keys()) });
    return res.status(404).json({ error: 'Session not found or expired. Please try connecting again.' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  console.log('[onboarding] Session found:', {
    sessionId,
    workspaceUrl: session.workspaceUrl,
    workspaceSessionId: session.workspaceSessionId,
    status: session.status,
  });

  // Forward to workspace daemon
  if (session.workspaceUrl && session.workspaceSessionId) {
    try {
      const targetUrl = `${session.workspaceUrl}/auth/cli/${provider}/code/${session.workspaceSessionId}`;
      console.log('[onboarding] Forwarding auth code to workspace:', targetUrl);

      const codeResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      console.log('[onboarding] Workspace response:', { status: codeResponse.status });

      if (codeResponse.ok) {
        return res.json({ success: true, message: 'Auth code submitted' });
      }

      const errorData = await codeResponse.json().catch(() => ({})) as { error?: string };
      console.log('[onboarding] Workspace error:', errorData);

      // Provide more helpful error message
      const needsRestart = (errorData as { needsRestart?: boolean }).needsRestart;
      if (codeResponse.status === 404 || codeResponse.status === 400) {
        return res.status(400).json({
          error: errorData.error || 'Auth session expired in workspace. The CLI process may have timed out. Please try connecting again.',
          needsRestart: needsRestart ?? true,
        });
      }

      return res.status(codeResponse.status).json({
        error: errorData.error || 'Failed to submit auth code to workspace',
        needsRestart,
      });
    } catch (err) {
      console.error('[onboarding] Failed to submit auth code to workspace:', err);
      return res.status(500).json({
        error: 'Failed to reach workspace. Please ensure your workspace is running and try again.',
      });
    }
  }

  console.log('[onboarding] No workspace session info available');
  return res.status(400).json({
    error: 'No workspace session available. This can happen if the workspace was restarted. Please try connecting again.',
  });
});

// Note: POST /cli/:provider/complete/:sessionId handler is defined above (lines 269-368)
// It handles both direct token storage and workspace delegation with authCode forwarding

/**
 * POST /api/onboarding/cli/:provider/cancel/:sessionId
 * Cancel a CLI auth session
 */
onboardingRouter.post('/cli/:provider/cancel/:sessionId', async (req: Request, res: Response) => {
  const { provider, sessionId } = req.params;
  const userId = req.session.userId!;

  const session = activeSessions.get(sessionId);
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

    // Mark provider as connected (tokens are not stored centrally - CLI tools
    // authenticate directly on workspace instances)
    await db.credentials.upsert({
      userId,
      provider,
      scopes: getProviderScopes(provider),
      providerAccountEmail: email,
    });

    res.json({
      success: true,
      message: `${provider} connected successfully`,
      note: 'Token validated. Configure this on your workspace for usage.',
    });
  } catch (error) {
    console.error(`Error storing provider connection for ${provider}:`, error);
    res.status(500).json({ error: 'Failed to store provider connection' });
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
 * @deprecated Currently unused - kept for potential future use
 */
async function _extractCredentials(
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
      // Claude stores OAuth in: { claudeAiOauth: { accessToken: "...", refreshToken: "...", expiresAt: ... } }
      if (creds.claudeAiOauth?.accessToken) {
        session.token = creds.claudeAiOauth.accessToken;
        session.refreshToken = creds.claudeAiOauth.refreshToken;
        if (creds.claudeAiOauth.expiresAt) {
          session.tokenExpiresAt = new Date(creds.claudeAiOauth.expiresAt);
        }
      } else {
        // Fallback to legacy formats
        session.token = creds.oauth_token || creds.access_token || creds.api_key;
      }
    } else if (session.provider === 'openai') {
      // Codex stores OAuth in: { tokens: { access_token: "...", refresh_token: "...", ... } }
      if (creds.tokens?.access_token) {
        session.token = creds.tokens.access_token;
        session.refreshToken = creds.tokens.refresh_token;
        // Codex doesn't store expiry in the file, but JWTs have exp claim
        // We could decode it, but for now just skip
      } else {
        // Fallback: API key or legacy formats
        session.token = creds.OPENAI_API_KEY || creds.token || creds.access_token || creds.api_key;
      }
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
 *
 * Note: OAuth tokens from CLI flows (like `claude` CLI) are different from API keys.
 * - API keys: sk-ant-api03-... (can be validated via API)
 * - OAuth tokens: Session tokens from OAuth flow (can't be validated the same way)
 *
 * For OAuth tokens, we accept them if they look valid (non-empty, reasonable length).
 * The CLI already validated the OAuth flow, so we trust those tokens.
 */
async function validateProviderToken(provider: string, token: string): Promise<boolean> {
  // Basic sanity check
  if (!token || token.length < 10) {
    return false;
  }

  try {
    // Check if this looks like an API key vs OAuth token
    const isAnthropicApiKey = token.startsWith('sk-ant-');
    const isOpenAIApiKey = token.startsWith('sk-');

    // For OAuth tokens (not API keys), accept them without API validation
    // The OAuth flow already authenticated the user
    if (provider === 'anthropic' && !isAnthropicApiKey) {
      console.log('[onboarding] Accepting OAuth token for anthropic (not an API key)');
      return true;
    }
    if (provider === 'openai' && !isOpenAIApiKey) {
      console.log('[onboarding] Accepting OAuth token for openai (not an API key)');
      return true;
    }

    // For API keys, validate via API call
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
