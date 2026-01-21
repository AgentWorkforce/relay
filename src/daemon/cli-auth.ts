/**
 * CLI Auth Handler for Workspace Daemon
 *
 * Handles CLI-based authentication (claude, codex, etc.) via PTY.
 * Runs inside the workspace container where CLI tools are installed.
 *
 * Uses relay-pty binary for PTY emulation, providing better Node.js
 * version compatibility by avoiding native module compilation.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'crypto';
import { createLogger } from '../resiliency/logger.js';
import {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
  findMatchingError,
  getSupportedProviders,
  type CLIAuthConfig,
  type PromptHandler,
} from '../shared/cli-auth-config.js';
import { getUserDirectoryService } from './user-directory.js';

// Get the directory where this module is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('cli-auth');

// Re-export for consumers
export { CLI_AUTH_CONFIG, getSupportedProviders };
export type { CLIAuthConfig, PromptHandler };

/**
 * Find the relay-pty binary path.
 * Returns null if not found.
 */
function findRelayPtyBinary(): string | null {
  // Get the package root (two levels up from dist/daemon/)
  const packageRoot = join(__dirname, '..', '..');

  const candidates = [
    // Primary: installed by postinstall from platform-specific binary
    join(packageRoot, 'bin', 'relay-pty'),
    // Development: local Rust build
    join(packageRoot, 'relay-pty', 'target', 'release', 'relay-pty'),
    join(packageRoot, 'relay-pty', 'target', 'debug', 'relay-pty'),
    // Local build in cwd (for development)
    join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
    // Installed globally
    '/usr/local/bin/relay-pty',
    // In node_modules (when installed as dependency)
    join(process.cwd(), 'node_modules', 'agent-relay', 'bin', 'relay-pty'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Process wrapper interface for session management */
interface ProcessWrapper {
  write: (data: string) => void;
  kill: () => void;
}

/**
 * Auth session state
 */
interface AuthSession {
  id: string;
  provider: string;
  userId?: string;
  status: 'starting' | 'waiting_auth' | 'success' | 'error';
  authUrl?: string;
  token?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  error?: string;
  /** User-friendly hint for resolving the error */
  errorHint?: string;
  /** Whether the error can be resolved by retrying */
  recoverable?: boolean;
  output: string;
  promptsHandled: string[];
  createdAt: Date;
  process?: ProcessWrapper;
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
  /** User ID for per-user credential storage (multi-user workspaces) */
  userId?: string;
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
    userId: options.userId,
    status: 'starting',
    output: '',
    promptsHandled: [],
    createdAt: new Date(),
  };
  sessions.set(sessionId, session);

  logger.info('CLI auth session created', {
    sessionId,
    provider,
    totalActiveSessions: sessions.size,
    allSessionIds: Array.from(sessions.keys()),
  });

  // Check if already authenticated (credentials exist)
  try {
    const existingCreds = await extractCredentials(provider, config, options.userId);
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

  // Find relay-pty binary
  const relayPtyPath = findRelayPtyBinary();
  if (!relayPtyPath) {
    session.status = 'error';
    session.error = 'relay-pty binary not found. Build with: cd relay-pty && cargo build --release';
    return session;
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
    // Get per-user environment if userId provided (for multi-user workspaces)
    // This sets HOME to /data/users/{userId} so CLI stores credentials per-user
    let userEnv: Record<string, string> = {};
    if (options.userId) {
      try {
        const userDirService = getUserDirectoryService();
        userEnv = userDirService.getUserEnvironment(options.userId);
        logger.info('Using per-user environment for CLI auth', {
          provider,
          userId: options.userId,
          home: userEnv.HOME,
        });
      } catch (err) {
        logger.warn('Failed to get user environment, using default', {
          provider,
          userId: options.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Build relay-pty arguments
    const relayArgs = [
      '--name', `auth-${sessionId.substring(0, 8)}`,
      '--rows', '30',
      '--cols', '120',
      '--log-level', 'error', // Suppress relay-pty logs
      '--', config.command,
      ...args,
    ];

    const proc: ChildProcess = spawn(relayPtyPath, relayArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...userEnv, // Override HOME for per-user credential storage
        NO_COLOR: '1',
        TERM: 'xterm-256color',
        // Don't set BROWSER - let CLI fail to open browser and fall back to manual paste mode
        // Setting BROWSER: 'echo' caused CLI to think browser opened and wait for callback that never came
        DISPLAY: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Create wrapper for session management
    const processWrapper: ProcessWrapper = {
      write: (data: string) => proc.stdin?.write(data),
      kill: () => proc.kill(),
    };
    session.process = processWrapper;

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

    // Handle data from PTY output
    const handleData = (data: string) => {
      session.output += data;
      const cleanText = stripAnsiCodes(data);

      // Check for error patterns FIRST - if error detected, don't auto-respond to prompts
      // This prevents us from auto-responding to "Press Enter to retry" in error messages
      const matchedError = findMatchingError(data, config.errorPatterns);
      if (matchedError && session.status !== 'error') {
        logger.warn('Auth error detected', {
          provider,
          sessionId,
          errorMessage: matchedError.message,
          recoverable: matchedError.recoverable,
        });
        session.status = 'error';
        session.error = matchedError.message;
        session.errorHint = matchedError.hint;
        session.recoverable = matchedError.recoverable;
      }

      // Don't auto-respond to prompts if we're in error state
      // This prevents responding to "Press Enter to retry" after an error
      if (session.status !== 'error') {
        const matchingPrompt = findMatchingPrompt(data, config.prompts, respondedPrompts);
        if (matchingPrompt) {
          respondedPrompts.add(matchingPrompt.description);
          session.promptsHandled.push(matchingPrompt.description);
          logger.info('Auto-responding to prompt', { description: matchingPrompt.description });

          const delay = matchingPrompt.delay ?? 100;
          setTimeout(() => {
            try {
              proc.stdin?.write(matchingPrompt.response);
            } catch {
              // Process may have exited
            }
          }, delay);
        }
      }

      // Extract auth URL (only if not in error state and don't have URL yet)
      const match = cleanText.match(config.urlPattern);
      if (match && match[1] && !session.authUrl && session.status !== 'error') {
        session.authUrl = match[1];
        session.status = 'waiting_auth';
        logger.info('Auth URL captured', { provider, url: session.authUrl });
        // Signal that we have the auth URL
        clearTimeout(authUrlTimeout);
        resolveAuthUrl();
      }

      // Log all output after auth URL is captured (for debugging)
      if (session.authUrl) {
        const trimmedData = cleanText.trim();
        if (trimmedData.length > 0) {
          logger.info('PTY output after auth URL', {
            provider,
            sessionId,
            output: trimmedData.substring(0, 500),
          });
        }
      }

      // Check for success and try to extract credentials
      // Don't override error status - if there was an error, keep it
      if (session.status !== 'error' && matchesSuccessPattern(data, config.successPatterns)) {
        session.status = 'success';
        logger.info('Success pattern detected, attempting credential extraction', { provider });

        // Try to extract credentials immediately (CLI may not exit after success)
        // Use a small delay to let the CLI finish writing the file
        setTimeout(async () => {
          // Don't extract if status changed to error (e.g., error detected after success pattern)
          if (session.status === 'error') {
            logger.info('Skipping credential extraction - session is in error state', { provider });
            return;
          }
          try {
            const creds = await extractCredentials(provider, config, session.userId);
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
    };

    // Handle stdout (main PTY output)
    proc.stdout?.on('data', (data: Buffer) => {
      handleData(data.toString());
    });

    // Handle stderr (relay-pty logs and some CLI output)
    proc.stderr?.on('data', (data: Buffer) => {
      handleData(data.toString());
    });

    proc.on('exit', async (exitCode) => {
      clearTimeout(timeout);
      clearTimeout(authUrlTimeout);

      // Clear process reference so submitAuthCode knows PTY is gone
      session.process = undefined;

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

      // Try to extract credentials (but don't override error status)
      // CLI might exit cleanly (code 0) even after an OAuth error
      if ((session.authUrl || exitCode === 0) && session.status !== 'error') {
        try {
          const creds = await extractCredentials(provider, config, session.userId);
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

    proc.on('error', (err) => {
      clearTimeout(timeout);
      clearTimeout(authUrlTimeout);
      session.status = 'error';
      session.error = err.message;
      logger.error('CLI process error', { error: err.message });
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
 * @param sessionId - The auth session ID
 * @param code - The OAuth authorization code
 * @param state - Optional OAuth state parameter for CSRF validation (used by Codex)
 * @returns Object with success status and optional error message
 */
export async function submitAuthCode(
  sessionId: string,
  code: string,
  state?: string
): Promise<{ success: boolean; error?: string; needsRestart?: boolean }> {
  // Log all active sessions for debugging
  const activeSessionIds = Array.from(sessions.keys());
  logger.info('submitAuthCode called', {
    sessionId,
    codeLength: code.length,
    activeSessionCount: activeSessionIds.length,
    activeSessionIds,
  });

  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn('Auth code submission failed: session not found', {
      sessionId,
      activeSessionIds,
      hint: 'Session may have been cleaned up or never created',
    });
    return { success: false, error: 'Session not found or expired', needsRestart: true };
  }

  logger.info('Session found for code submission', {
    sessionId,
    provider: session.provider,
    status: session.status,
    hasProcess: !!session.process,
    hasAuthUrl: !!session.authUrl,
    hasToken: !!session.token,
    promptsHandled: session.promptsHandled,
    createdAt: session.createdAt.toISOString(),
    ageSeconds: Math.round((Date.now() - session.createdAt.getTime()) / 1000),
  });

  if (!session.process) {
    logger.warn('Auth code submission failed: no PTY process', {
      sessionId,
      sessionStatus: session.status,
      provider: session.provider,
      outputLength: session.output?.length || 0,
      outputTail: session.output ? stripAnsiCodes(session.output).slice(-500) : 'no output',
    });

    // Try to extract credentials as a fallback - maybe auth completed in browser
    // But don't override error status
    const config = CLI_AUTH_CONFIG[session.provider];
    if (config && session.status !== 'error') {
      try {
        const creds = await extractCredentials(session.provider, config, session.userId);
        // Re-check status after async operation (race condition protection)
        // Use type assertion because TypeScript narrowing doesn't account for async race conditions
        if (creds && (session.status as AuthSession['status']) !== 'error') {
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
    // Clean the code - trim whitespace and strip state parameter if present
    // Claude OAuth codes come as "CODE#STATE" - we only need the code part
    let cleanCode = code.trim();
    if (cleanCode.includes('#')) {
      const originalCode = cleanCode;
      cleanCode = cleanCode.split('#')[0];
      logger.info('Stripped state parameter from auth code', {
        sessionId,
        originalLength: originalCode.length,
        cleanLength: cleanCode.length,
      });
    }

    // For Codex (openai), forward the callback to the CLI's localhost server
    // instead of writing to PTY stdin. The CLI spawns a localhost server
    // waiting for the OAuth callback.
    if (session.provider === 'openai' && session.authUrl) {
      // Extract the redirect port from the auth URL (usually 1455)
      const redirectMatch = session.authUrl.match(/redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)/);
      const port = redirectMatch ? redirectMatch[1] : '1455';

      logger.info('Forwarding OAuth callback to Codex CLI localhost server', {
        sessionId,
        port,
        codeLength: cleanCode.length,
        hasState: !!state,
      });

      try {
        // Forward the callback to the CLI's localhost server
        // Include state parameter for CSRF validation if provided
        let callbackUrl = `http://localhost:${port}/auth/callback?code=${encodeURIComponent(cleanCode)}`;
        if (state) {
          callbackUrl += `&state=${encodeURIComponent(state)}`;
        }
        const response = await fetch(callbackUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          logger.info('OAuth callback forwarded successfully to Codex CLI', { sessionId, status: response.status });

          // Start polling for credentials
          const config = CLI_AUTH_CONFIG[session.provider];
          if (config) {
            pollForCredentials(session, config);
          }

          return { success: true };
        } else {
          // Try to get error details from response body
          let errorBody = '';
          try {
            errorBody = await response.text();
          } catch {
            // Ignore
          }
          logger.warn('Codex CLI localhost server returned error', {
            sessionId,
            status: response.status,
            statusText: response.statusText,
            errorBody: errorBody.substring(0, 500), // Limit log size
            callbackUrl: callbackUrl.replace(/code=[^&]+/, 'code=***'), // Redact code
          });
          // Fall through to PTY write as fallback
        }
      } catch (err) {
        logger.warn('Failed to forward callback to Codex CLI localhost server', {
          sessionId,
          error: String(err),
        });
        // Fall through to PTY write as fallback
      }
    }

    logger.info('Writing auth code to PTY', {
      sessionId,
      originalLength: code.length,
      cleanLength: cleanCode.length,
      codePreview: cleanCode.substring(0, 20) + '...',
    });

    // Write the auth code WITHOUT Enter first
    // Claude CLI's Ink text input needs time to process the input
    // before receiving Enter (tested: immediate Enter fails, delayed Enter works)
    session.process.write(cleanCode);
    logger.info('Auth code written, waiting before sending Enter...', { sessionId });

    // Wait 1 second for CLI to process the typed input
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Now send Enter to submit
    session.process.write('\r');
    logger.info('Enter key sent', { sessionId });

    // Start polling for credentials after code submission
    // The CLI should write credentials shortly after receiving the code
    const config = CLI_AUTH_CONFIG[session.provider];
    if (config) {
      pollForCredentials(session, config);
    }

    return { success: true };
  } catch (err) {
    logger.error('Failed to submit auth code', { sessionId, error: String(err) });
    return {
      success: false,
      error: 'Failed to write to CLI process. The process may have exited. Please try again.',
      needsRestart: true,
    };
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
      const creds = await extractCredentials(session.provider, config, session.userId);
      if (creds) {
        // Double-check we're not in error state (race condition protection)
        // Use type assertion because TypeScript narrowing doesn't account for async race conditions
        if ((session.status as AuthSession['status']) === 'error') {
          logger.info('Credentials found but session is in error state, not overriding', {
            provider: session.provider,
          });
          return;
        }
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
    // Check if session went into error state
    if (session.status === 'error') {
      return { success: false, error: session.error || 'Authentication failed' };
    }
    try {
      const creds = await extractCredentials(session.provider, config, session.userId);
      if (creds) {
        // Double-check we're not in error state (race condition protection)
        // Use type assertion because TypeScript narrowing doesn't account for async race conditions
        if ((session.status as AuthSession['status']) === 'error') {
          return { success: false, error: session.error || 'Authentication failed' };
        }
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

function resolveCredentialPath(
  provider: string,
  config: CLIAuthConfig,
  userId?: string
): string | null {
  if (!config.credentialPath) return null;

  if (!userId) {
    return config.credentialPath.replace('~', os.homedir());
  }

  try {
    const userDirService = getUserDirectoryService();
    const userHome = userDirService.getUserHome(userId);
    return config.credentialPath.replace('~', userHome);
  } catch (err) {
    logger.warn('Failed to resolve per-user credential path, using default', {
      provider,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return config.credentialPath.replace('~', os.homedir());
  }
}

/**
 * Extract credentials from CLI credential file
 */
async function extractCredentials(
  provider: string,
  config: CLIAuthConfig,
  userId?: string
): Promise<ExtractedCredentials | null> {
  const credPath = resolveCredentialPath(provider, config, userId);
  if (!credPath) return null;

  try {
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
    } else if (provider === 'cursor') {
      // Cursor stores credentials in various formats - try common patterns
      // { accessToken: "...", refreshToken: "..." } or { token: "..." } or nested
      if (creds.accessToken) {
        return {
          token: creds.accessToken,
          refreshToken: creds.refreshToken,
          expiresAt: creds.expiresAt ? new Date(creds.expiresAt) : undefined,
        };
      }
      if (creds.auth?.accessToken) {
        return {
          token: creds.auth.accessToken,
          refreshToken: creds.auth.refreshToken,
          expiresAt: creds.auth.expiresAt ? new Date(creds.auth.expiresAt) : undefined,
        };
      }
      // Fallback to generic token fields
      const token = creds.token || creds.access_token || creds.api_key;
      return token ? { token } : null;
    }

    const token = creds.token || creds.access_token || creds.api_key;
    return token ? { token } : null;
  } catch {
    return null;
  }
}

/**
 * Check if a provider is authenticated (credentials exist)
 * Used by the auth check endpoint for SSH tunnel flow
 */
export async function checkProviderAuth(provider: string, userId?: string): Promise<boolean> {
  const config = CLI_AUTH_CONFIG[provider];
  if (!config) {
    return false;
  }

  try {
    const creds = await extractCredentials(provider, config, userId);
    return !!creds?.token;
  } catch {
    return false;
  }
}
