/**
 * CLI Auth Handler for Workspace Daemon
 *
 * Handles CLI-based authentication (claude, codex, etc.) via PTY.
 * Runs inside the workspace container where CLI tools are installed.
 */

import * as pty from 'node-pty';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import { createLogger } from '../resiliency/logger.js';
import {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
  getSupportedProviders,
  type CLIAuthConfig,
  type PromptHandler,
} from '../shared/cli-auth-config.js';

const logger = createLogger('cli-auth');

// Re-export for consumers
export { CLI_AUTH_CONFIG, getSupportedProviders };
export type { CLIAuthConfig, PromptHandler };

/**
 * Auth session state
 */
interface AuthSession {
  id: string;
  provider: string;
  status: 'starting' | 'waiting_auth' | 'success' | 'error';
  authUrl?: string;
  token?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  error?: string;
  output: string;
  promptsHandled: string[];
  createdAt: Date;
  process?: pty.IPty;
}

// Active sessions
const sessions = new Map<string, AuthSession>();

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt.getTime() > 10 * 60 * 1000) {
      if (session.process) {
        try {
          session.process.kill();
        } catch {
          // Process may already be dead
        }
      }
      sessions.delete(id);
    }
  }
}, 60000);

export interface StartCLIAuthOptions {
  /** Use device flow instead of standard OAuth (if provider supports it) */
  useDeviceFlow?: boolean;
}

/**
 * Start CLI auth flow
 *
 * This function waits for the auth URL to be captured before returning,
 * ensuring the caller can immediately open the OAuth popup.
 */
export async function startCLIAuth(
  provider: string,
  options: StartCLIAuthOptions = {}
): Promise<AuthSession> {
  const config = CLI_AUTH_CONFIG[provider];
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const sessionId = crypto.randomUUID();
  const session: AuthSession = {
    id: sessionId,
    provider,
    status: 'starting',
    output: '',
    promptsHandled: [],
    createdAt: new Date(),
  };
  sessions.set(sessionId, session);

  // Check if already authenticated (credentials exist)
  try {
    const existingCreds = await extractCredentials(provider, config);
    if (existingCreds?.token) {
      logger.info('Already authenticated - existing credentials found', { provider, sessionId });
      session.status = 'success';
      session.token = existingCreds.token;
      session.refreshToken = existingCreds.refreshToken;
      session.tokenExpiresAt = existingCreds.expiresAt;
      return session;
    }
  } catch {
    // No existing credentials, proceed with auth flow
  }

  // Use device flow args if requested and supported
  const args = options.useDeviceFlow && config.deviceFlowArgs
    ? config.deviceFlowArgs
    : config.args;

  logger.info('Starting CLI auth', {
    provider,
    sessionId,
    useDeviceFlow: options.useDeviceFlow,
    args,
  });

  const respondedPrompts = new Set<string>();

  // Create a promise that resolves when authUrl is captured or timeout
  let resolveAuthUrl: () => void;
  const authUrlPromise = new Promise<void>((resolve) => {
    resolveAuthUrl = resolve;
  });

  // Timeout for waiting for auth URL (shorter than the full OAuth timeout)
  const AUTH_URL_WAIT_TIMEOUT = 15000; // 15 seconds to capture auth URL
  const authUrlTimeout = setTimeout(() => {
    logger.warn('Auth URL wait timeout, returning session without URL', { provider, sessionId });
    resolveAuthUrl();
  }, AUTH_URL_WAIT_TIMEOUT);

  try {
    const proc = pty.spawn(config.command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
        TERM: 'xterm-256color',
        BROWSER: 'echo',
        DISPLAY: '',
      } as Record<string, string>,
    });

    session.process = proc;

    // Timeout handler - give user plenty of time to complete OAuth flow
    // 5 minutes should be enough for even slow OAuth flows
    const OAUTH_COMPLETION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    const timeout = setTimeout(() => {
      if (session.status === 'starting' || session.status === 'waiting_auth') {
        logger.warn('CLI auth timed out', { provider, sessionId, status: session.status });
        proc.kill();
        session.status = 'error';
        session.error = 'Timeout waiting for auth completion (5 minutes). Please try again.';
      }
    }, config.waitTimeout + OAUTH_COMPLETION_TIMEOUT);

    proc.onData((data: string) => {
      session.output += data;

      // Handle prompts
      const matchingPrompt = findMatchingPrompt(data, config.prompts, respondedPrompts);
      if (matchingPrompt) {
        respondedPrompts.add(matchingPrompt.description);
        session.promptsHandled.push(matchingPrompt.description);
        logger.info('Auto-responding to prompt', { description: matchingPrompt.description });

        const delay = matchingPrompt.delay ?? 100;
        setTimeout(() => {
          try {
            proc.write(matchingPrompt.response);
          } catch {
            // Process may have exited
          }
        }, delay);
      }

      // Extract auth URL
      const cleanText = stripAnsiCodes(data);
      const match = cleanText.match(config.urlPattern);
      if (match && match[1] && !session.authUrl) {
        session.authUrl = match[1];
        session.status = 'waiting_auth';
        logger.info('Auth URL captured', { provider, url: session.authUrl });
        // Signal that we have the auth URL
        clearTimeout(authUrlTimeout);
        resolveAuthUrl();
      }

      // Check for success and try to extract credentials
      if (matchesSuccessPattern(data, config.successPatterns)) {
        session.status = 'success';
        logger.info('Success pattern detected, attempting credential extraction', { provider });

        // Try to extract credentials immediately (CLI may not exit after success)
        // Use a small delay to let the CLI finish writing the file
        setTimeout(async () => {
          try {
            const creds = await extractCredentials(provider, config);
            if (creds) {
              session.token = creds.token;
              session.refreshToken = creds.refreshToken;
              session.tokenExpiresAt = creds.expiresAt;
              logger.info('Credentials extracted successfully', { provider, hasRefreshToken: !!creds.refreshToken });
            }
          } catch (err) {
            logger.error('Failed to extract credentials on success', { error: String(err) });
          }
        }, 500);
      }
    });

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      clearTimeout(authUrlTimeout);

      // Log full output for debugging PTY exit issues
      const cleanOutput = stripAnsiCodes(session.output);
      logger.info('CLI process exited', {
        provider,
        exitCode,
        outputLength: session.output.length,
        hasAuthUrl: !!session.authUrl,
        sessionStatus: session.status,
        promptsHandled: session.promptsHandled,
        // Last 500 chars of output for debugging
        outputTail: cleanOutput.slice(-500),
      });

      // Try to extract credentials
      if (session.authUrl || exitCode === 0) {
        try {
          const creds = await extractCredentials(provider, config);
          if (creds) {
            session.token = creds.token;
            session.refreshToken = creds.refreshToken;
            session.tokenExpiresAt = creds.expiresAt;
            session.status = 'success';
          }
        } catch (err) {
          logger.error('Failed to extract credentials', { error: String(err) });
        }
      }

      if (!session.authUrl && !session.token && session.status !== 'error') {
        session.status = 'error';
        session.error = 'CLI exited without auth URL or credentials';
      }

      // Resolve in case we're still waiting
      resolveAuthUrl();
    });
  } catch (err) {
    session.status = 'error';
    session.error = err instanceof Error ? err.message : 'Failed to spawn CLI';
    logger.error('Failed to start CLI auth', { error: session.error });
    clearTimeout(authUrlTimeout);
    resolveAuthUrl!();
  }

  // Wait for auth URL to be captured (or timeout)
  await authUrlPromise;

  return session;
}

/**
 * Get auth session status
 */
export function getAuthSession(sessionId: string): AuthSession | null {
  return sessions.get(sessionId) || null;
}

/**
 * Submit auth code to a waiting session
 * This writes the code to the PTY process stdin
 *
 * @returns Object with success status and optional error message
 */
export async function submitAuthCode(
  sessionId: string,
  code: string
): Promise<{ success: boolean; error?: string; needsRestart?: boolean }> {
  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn('Auth code submission failed: session not found', { sessionId });
    return { success: false, error: 'Session not found or expired', needsRestart: true };
  }

  if (!session.process) {
    logger.warn('Auth code submission failed: no PTY process', {
      sessionId,
      sessionStatus: session.status,
      provider: session.provider,
    });

    // Try to extract credentials as a fallback - maybe auth completed in browser
    const config = CLI_AUTH_CONFIG[session.provider];
    if (config) {
      try {
        const creds = await extractCredentials(session.provider, config);
        if (creds) {
          session.token = creds.token;
          session.refreshToken = creds.refreshToken;
          session.tokenExpiresAt = creds.expiresAt;
          session.status = 'success';
          logger.info('Credentials found despite PTY exit', { provider: session.provider });
          return { success: true };
        }
      } catch {
        // No credentials found
      }
    }

    // For providers like Claude that need the code pasted into CLI,
    // if the PTY is gone, user needs to restart the auth flow
    return {
      success: false,
      error: 'The authentication session has ended. The CLI process exited before the code could be entered. Please click "Try Again" to restart.',
      needsRestart: true,
    };
  }

  try {
    // Write the auth code followed by enter
    session.process.write(code + '\r');
    logger.info('Auth code submitted', { sessionId, codeLength: code.length });

    // Start polling for credentials after code submission
    // The CLI should write credentials shortly after receiving the code
    const config = CLI_AUTH_CONFIG[session.provider];
    if (config) {
      pollForCredentials(session, config);
    }

    return { success: true };
  } catch (err) {
    logger.error('Failed to submit auth code', { sessionId, error: String(err) });
    return { success: false, error: 'Failed to write to CLI process' };
  }
}

/**
 * Poll for credentials file after auth code submission
 * Some CLIs don't output success patterns, so we check the file directly
 */
async function pollForCredentials(session: AuthSession, config: CLIAuthConfig): Promise<void> {
  const maxAttempts = 10;
  const pollInterval = 1000; // 1 second

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    // Skip if session already has credentials or errored
    if (session.token || session.status === 'error') {
      return;
    }

    try {
      const creds = await extractCredentials(session.provider, config);
      if (creds) {
        session.token = creds.token;
        session.refreshToken = creds.refreshToken;
        session.tokenExpiresAt = creds.expiresAt;
        session.status = 'success';
        logger.info('Credentials found via polling', {
          provider: session.provider,
          attempt: i + 1,
          hasRefreshToken: !!creds.refreshToken,
        });
        return;
      }
    } catch {
      // File doesn't exist yet, continue polling
    }
  }

  logger.warn('Credential polling completed without finding credentials', {
    provider: session.provider,
    sessionId: session.id,
  });
}

/**
 * Complete auth session by polling for credentials
 * Called when user indicates they've completed auth in browser
 */
export async function completeAuthSession(sessionId: string): Promise<{
  success: boolean;
  error?: string;
  token?: string;
}> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found or expired' };
  }

  // Already have credentials
  if (session.token) {
    return { success: true, token: session.token };
  }

  const config = CLI_AUTH_CONFIG[session.provider];
  if (!config) {
    return { success: false, error: 'Unknown provider' };
  }

  // Poll for credentials (user just completed auth in browser)
  const maxAttempts = 15;
  const pollInterval = 1000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const creds = await extractCredentials(session.provider, config);
      if (creds) {
        session.token = creds.token;
        session.refreshToken = creds.refreshToken;
        session.tokenExpiresAt = creds.expiresAt;
        session.status = 'success';
        logger.info('Credentials found via complete polling', {
          provider: session.provider,
          attempt: i + 1,
        });
        return { success: true, token: creds.token };
      }
    } catch {
      // File doesn't exist yet
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return {
    success: false,
    error: 'Credentials not found. Please ensure you completed authentication in the browser.',
  };
}

/**
 * Cancel auth session
 */
export function cancelAuthSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.process) {
    try {
      session.process.kill();
    } catch {
      // Already dead
    }
  }

  sessions.delete(sessionId);
  return true;
}

interface ExtractedCredentials {
  token: string;
  refreshToken?: string;
  expiresAt?: Date;
}

/**
 * Extract credentials from CLI credential file
 */
async function extractCredentials(
  provider: string,
  config: CLIAuthConfig
): Promise<ExtractedCredentials | null> {
  if (!config.credentialPath) return null;

  try {
    const credPath = config.credentialPath.replace('~', os.homedir());
    const content = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(content);

    // Extract token based on provider
    if (provider === 'anthropic') {
      // Claude stores OAuth in: { claudeAiOauth: { accessToken: "...", refreshToken: "...", expiresAt: ... } }
      if (creds.claudeAiOauth?.accessToken) {
        return {
          token: creds.claudeAiOauth.accessToken,
          refreshToken: creds.claudeAiOauth.refreshToken,
          expiresAt: creds.claudeAiOauth.expiresAt ? new Date(creds.claudeAiOauth.expiresAt) : undefined,
        };
      }
      // Fallback to legacy formats
      const token = creds.oauth_token || creds.access_token || creds.api_key;
      return token ? { token } : null;
    } else if (provider === 'openai') {
      // Codex stores OAuth in: { tokens: { access_token: "...", refresh_token: "...", ... } }
      if (creds.tokens?.access_token) {
        return {
          token: creds.tokens.access_token,
          refreshToken: creds.tokens.refresh_token,
        };
      }
      // Fallback: API key or legacy formats
      const token = creds.OPENAI_API_KEY || creds.token || creds.access_token || creds.api_key;
      return token ? { token } : null;
    } else if (provider === 'opencode') {
      // OpenCode stores multiple providers: { opencode: {...}, anthropic: {...}, openai: {...}, google: {...} }
      // Check for any valid credential - prefer OpenCode Zen, then Anthropic
      if (creds.opencode?.key) {
        return { token: creds.opencode.key };
      }
      if (creds.anthropic?.access) {
        return {
          token: creds.anthropic.access,
          refreshToken: creds.anthropic.refresh,
          expiresAt: creds.anthropic.expires ? new Date(creds.anthropic.expires) : undefined,
        };
      }
      if (creds.openai?.access) {
        return {
          token: creds.openai.access,
          refreshToken: creds.openai.refresh,
          expiresAt: creds.openai.expires ? new Date(creds.openai.expires) : undefined,
        };
      }
      if (creds.google?.key) {
        return { token: creds.google.key };
      }
      return null;
    }

    const token = creds.token || creds.access_token || creds.api_key;
    return token ? { token } : null;
  } catch {
    return null;
  }
}

