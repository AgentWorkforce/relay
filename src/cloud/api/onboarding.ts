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
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import crypto from 'crypto';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';
import { vault } from '../vault/index.js';

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
  for (const [id, session] of activeSessions) {
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
  }
}, 60000);

/**
 * Interactive prompt handler configuration
 * Defines patterns to detect prompts and responses to send
 */
interface PromptHandler {
  /** Pattern to detect in CLI output (case-insensitive) */
  pattern: RegExp;
  /** Response to send (e.g., '\r' for enter, 'y\r' for yes+enter) */
  response: string;
  /** Delay before sending response (ms) */
  delay?: number;
  /** Description for logging/debugging */
  description: string;
}

/**
 * CLI auth configuration for each provider
 */
export interface CLIAuthConfig {
  /** CLI command to run */
  command: string;
  /** Arguments to pass */
  args: string[];
  /** Pattern to extract auth URL from output */
  urlPattern: RegExp;
  /** Path to credentials file (for reading after auth) */
  credentialPath?: string;
  /** Display name for UI */
  displayName: string;
  /** Interactive prompts to auto-respond to */
  prompts: PromptHandler[];
  /** Success indicators in output */
  successPatterns: RegExp[];
  /** How long to wait for URL to appear (ms) */
  waitTimeout: number;
}

/**
 * CLI commands and URL patterns for each provider
 *
 * Each CLI tool outputs an OAuth URL when run without credentials.
 * We capture stdout/stderr and extract the URL using a simple https:// pattern.
 *
 * IMPORTANT: These CLIs are interactive - they output the auth URL then wait
 * for the user to complete OAuth in their browser. We capture the URL and
 * display it in a popup for the user.
 */
export const CLI_AUTH_CONFIG: Record<string, CLIAuthConfig> = {
  anthropic: {
    command: 'claude',
    args: [],
    urlPattern: /(https:\/\/[^\s]+)/,
    credentialPath: '~/.claude/credentials.json',
    displayName: 'Claude',
    waitTimeout: 5000,
    prompts: [
      {
        pattern: /dark\s*(mode|theme)/i,
        response: '\r', // Press enter to accept default
        delay: 100,
        description: 'Dark mode prompt',
      },
      {
        pattern: /(subscription|api\s*key|how\s*would\s*you\s*like\s*to\s*authenticate)/i,
        response: '\r', // Press enter for first option (subscription)
        delay: 100,
        description: 'Auth method prompt',
      },
      {
        pattern: /trust\s*(this|the)\s*(directory|folder|workspace)/i,
        response: 'y\r', // Yes to trust
        delay: 100,
        description: 'Trust directory prompt',
      },
    ],
    successPatterns: [
      /success/i,
      /authenticated/i,
      /logged\s*in/i,
    ],
  },
  openai: {
    command: 'codex',
    args: ['login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    credentialPath: '~/.codex/credentials.json',
    displayName: 'Codex',
    waitTimeout: 3000,
    prompts: [
      {
        pattern: /trust\s*(this|the)\s*(directory|folder|workspace)/i,
        response: 'y\r',
        delay: 100,
        description: 'Trust directory prompt',
      },
    ],
    successPatterns: [
      /success/i,
      /authenticated/i,
      /logged\s*in/i,
    ],
  },
  google: {
    command: 'gemini',
    args: [],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'Gemini',
    waitTimeout: 3000,
    prompts: [],
    successPatterns: [
      /success/i,
      /authenticated/i,
    ],
  },
  opencode: {
    command: 'opencode',
    args: [],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'OpenCode',
    waitTimeout: 3000,
    prompts: [],
    successPatterns: [
      /success/i,
      /authenticated/i,
    ],
  },
  droid: {
    command: 'droid',
    args: [],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'Droid',
    waitTimeout: 3000,
    prompts: [],
    successPatterns: [
      /success/i,
      /authenticated/i,
    ],
  },
};

/**
 * Strip ANSI escape codes from text
 */
export function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Check if text matches any success pattern
 */
export function matchesSuccessPattern(text: string, patterns: RegExp[]): boolean {
  const cleanText = stripAnsiCodes(text).toLowerCase();
  return patterns.some(p => p.test(cleanText));
}

/**
 * Find matching prompt handler for given text
 */
export function findMatchingPrompt(
  text: string,
  prompts: PromptHandler[],
  respondedPrompts: Set<string>
): PromptHandler | null {
  const cleanText = stripAnsiCodes(text);

  for (const prompt of prompts) {
    // Skip if already responded to this prompt type
    if (respondedPrompts.has(prompt.description)) continue;

    if (prompt.pattern.test(cleanText)) {
      return prompt;
    }
  }

  return null;
}

/**
 * Validate a provider's CLI auth configuration
 * Returns null if valid, or an error message if invalid
 */
export function validateProviderConfig(providerId: string, config: CLIAuthConfig): string | null {
  if (!config.command || typeof config.command !== 'string') {
    return `${providerId}: missing or invalid 'command'`;
  }

  if (!Array.isArray(config.args)) {
    return `${providerId}: 'args' must be an array`;
  }

  if (!(config.urlPattern instanceof RegExp)) {
    return `${providerId}: 'urlPattern' must be a RegExp`;
  }

  // Check urlPattern has a capture group
  const testUrl = 'https://example.com/test';
  const match = testUrl.match(config.urlPattern);
  if (!match || !match[1]) {
    return `${providerId}: 'urlPattern' must have a capture group - got ${config.urlPattern}`;
  }

  if (!config.displayName || typeof config.displayName !== 'string') {
    return `${providerId}: missing or invalid 'displayName'`;
  }

  if (typeof config.waitTimeout !== 'number' || config.waitTimeout <= 0) {
    return `${providerId}: 'waitTimeout' must be a positive number`;
  }

  if (!Array.isArray(config.prompts)) {
    return `${providerId}: 'prompts' must be an array`;
  }

  for (let i = 0; i < config.prompts.length; i++) {
    const prompt = config.prompts[i];
    if (!(prompt.pattern instanceof RegExp)) {
      return `${providerId}: prompt[${i}].pattern must be a RegExp`;
    }
    if (typeof prompt.response !== 'string') {
      return `${providerId}: prompt[${i}].response must be a string`;
    }
    if (!prompt.description || typeof prompt.description !== 'string') {
      return `${providerId}: prompt[${i}].description must be a non-empty string`;
    }
  }

  if (!Array.isArray(config.successPatterns)) {
    return `${providerId}: 'successPatterns' must be an array`;
  }

  for (let i = 0; i < config.successPatterns.length; i++) {
    if (!(config.successPatterns[i] instanceof RegExp)) {
      return `${providerId}: successPatterns[${i}] must be a RegExp`;
    }
  }

  return null;
}

/**
 * Validate all provider configurations
 * Throws an error if any provider is invalid
 */
export function validateAllProviderConfigs(): void {
  const errors: string[] = [];

  for (const [providerId, config] of Object.entries(CLI_AUTH_CONFIG)) {
    const error = validateProviderConfig(providerId, config);
    if (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid provider configurations:\n${errors.join('\n')}`);
  }
}

/**
 * Get list of supported providers for CLI auth
 */
export function getSupportedProviders(): { id: string; displayName: string; command: string }[] {
  return Object.entries(CLI_AUTH_CONFIG).map(([id, config]) => ({
    id,
    displayName: config.displayName,
    command: config.command,
  }));
}

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
    // Spawn CLI process via PTY for proper TTY emulation
    // This ensures the CLI outputs auth URLs correctly
    const proc = pty.spawn(config.command, config.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', TERM: 'xterm-256color' } as Record<string, string>,
    });

    session.process = proc;

    // Track which prompts we've already responded to
    const respondedPrompts = new Set<string>();

    // Capture PTY output for auth URL and handle interactive prompts
    proc.onData((data: string) => {
      session.output += data;

      // Check for matching prompts and auto-respond
      const matchingPrompt = findMatchingPrompt(data, config.prompts, respondedPrompts);
      if (matchingPrompt) {
        respondedPrompts.add(matchingPrompt.description);
        const delay = matchingPrompt.delay ?? 100;
        setTimeout(() => {
          try {
            proc.write(matchingPrompt.response);
            console.log(`[onboarding] Auto-responded to: ${matchingPrompt.description}`);
          } catch {
            // Process may have exited
          }
        }, delay);
      }

      // Look for auth URL
      const cleanText = stripAnsiCodes(data);
      const match = cleanText.match(config.urlPattern);
      if (match && match[1]) {
        session.authUrl = match[1];
        session.status = 'waiting_auth';
      }

      // Check for success indicators
      if (matchesSuccessPattern(data, config.successPatterns)) {
        session.status = 'success';
      }
    });

    proc.onExit(async ({ exitCode }) => {
      if (exitCode === 0 && session.status !== 'error') {
        session.status = 'success';
        // Try to read credentials from file
        await extractCredentials(session, config);
      } else if (session.status === 'starting') {
        session.status = 'error';
        session.error = `CLI exited with code ${exitCode}`;
      }
    });

    // Wait for URL to appear using provider-specific timeout
    await new Promise(resolve => setTimeout(resolve, config.waitTimeout));

    // Return session info based on current state
    if (session.status === 'success') {
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
