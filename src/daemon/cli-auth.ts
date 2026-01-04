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

const logger = createLogger('cli-auth');

/**
 * CLI auth configuration for each provider
 */
interface CLIAuthConfig {
  command: string;
  args: string[];
  urlPattern: RegExp;
  credentialPath?: string;
  displayName: string;
  prompts: PromptHandler[];
  successPatterns: RegExp[];
  waitTimeout: number;
}

interface PromptHandler {
  pattern: RegExp;
  response: string;
  delay?: number;
  description: string;
}

const CLI_AUTH_CONFIG: Record<string, CLIAuthConfig> = {
  anthropic: {
    command: 'claude',
    args: [],
    urlPattern: /(https:\/\/[^\s]+)/,
    credentialPath: '~/.claude/credentials.json',
    displayName: 'Claude',
    waitTimeout: 30000,
    prompts: [
      {
        pattern: /dark\s*(mode|theme)/i,
        response: '\r',
        delay: 100,
        description: 'Dark mode prompt',
      },
      {
        pattern: /(subscription|api\s*key|how\s*would\s*you\s*like\s*to\s*authenticate)/i,
        response: '\r',
        delay: 100,
        description: 'Auth method prompt',
      },
      {
        pattern: /trust\s*(this|the)\s*(directory|folder|workspace)/i,
        response: 'y\r',
        delay: 100,
        description: 'Trust directory prompt',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i],
  },
  openai: {
    command: 'codex',
    args: ['login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    credentialPath: '~/.codex/credentials.json',
    displayName: 'Codex',
    waitTimeout: 30000,
    prompts: [
      {
        pattern: /trust\s*(this|the)\s*(directory|folder|workspace)/i,
        response: 'y\r',
        delay: 100,
        description: 'Trust directory prompt',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i],
  },
  google: {
    command: 'gemini',
    args: [],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'Gemini',
    waitTimeout: 30000,
    prompts: [
      {
        pattern: /login\s*with\s*google|google\s*account|choose.*auth/i,
        response: '\r',
        delay: 200,
        description: 'Auth method selection',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i],
  },
  opencode: {
    command: 'opencode',
    args: ['auth', 'login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'OpenCode',
    waitTimeout: 30000,
    prompts: [
      {
        pattern: /select.*provider|choose.*provider|which.*provider/i,
        response: '\r',
        delay: 200,
        description: 'Provider selection',
      },
      {
        pattern: /claude\s*pro|anthropic|select.*auth/i,
        response: '\r',
        delay: 200,
        description: 'Auth type selection',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i],
  },
  droid: {
    command: 'droid',
    args: ['--login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'Droid',
    waitTimeout: 30000,
    prompts: [
      {
        pattern: /sign\s*in|log\s*in|authenticate/i,
        response: '\r',
        delay: 200,
        description: 'Login prompt',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i],
  },
};

/**
 * Auth session state
 */
interface AuthSession {
  id: string;
  provider: string;
  status: 'starting' | 'waiting_auth' | 'success' | 'error';
  authUrl?: string;
  token?: string;
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

/**
 * Strip ANSI escape codes from text
 */
function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Check if text matches any success pattern
 */
function matchesSuccessPattern(text: string, patterns: RegExp[]): boolean {
  const cleanText = stripAnsiCodes(text).toLowerCase();
  return patterns.some((p) => p.test(cleanText));
}

/**
 * Find matching prompt handler
 */
function findMatchingPrompt(
  text: string,
  prompts: PromptHandler[],
  respondedPrompts: Set<string>
): PromptHandler | null {
  const cleanText = stripAnsiCodes(text);
  for (const prompt of prompts) {
    if (respondedPrompts.has(prompt.description)) continue;
    if (prompt.pattern.test(cleanText)) {
      return prompt;
    }
  }
  return null;
}

/**
 * Start CLI auth flow
 */
export function startCLIAuth(provider: string): AuthSession {
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

  const respondedPrompts = new Set<string>();

  try {
    const proc = pty.spawn(config.command, config.args, {
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

    // Timeout handler
    const timeout = setTimeout(() => {
      if (session.status === 'starting' || session.status === 'waiting_auth') {
        proc.kill();
        session.status = 'error';
        session.error = 'Timeout waiting for auth completion';
      }
    }, config.waitTimeout + 60000); // Extra time for user to complete OAuth

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
      }

      // Check for success
      if (matchesSuccessPattern(data, config.successPatterns)) {
        session.status = 'success';
      }
    });

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      logger.info('CLI process exited', { provider, exitCode });

      // Try to extract credentials
      if (session.authUrl || exitCode === 0) {
        try {
          const token = await extractCredentials(provider, config);
          if (token) {
            session.token = token;
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
    });
  } catch (err) {
    session.status = 'error';
    session.error = err instanceof Error ? err.message : 'Failed to spawn CLI';
    logger.error('Failed to start CLI auth', { error: session.error });
  }

  return session;
}

/**
 * Get auth session status
 */
export function getAuthSession(sessionId: string): AuthSession | null {
  return sessions.get(sessionId) || null;
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

/**
 * Extract credentials from CLI credential file
 */
async function extractCredentials(
  provider: string,
  config: CLIAuthConfig
): Promise<string | null> {
  if (!config.credentialPath) return null;

  try {
    const credPath = config.credentialPath.replace('~', os.homedir());
    const content = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(content);

    // Extract token based on provider
    if (provider === 'anthropic') {
      return creds.oauth_token || creds.access_token || creds.api_key;
    } else if (provider === 'openai') {
      return creds.token || creds.access_token || creds.api_key;
    }

    return creds.token || creds.access_token || creds.api_key || null;
  } catch {
    return null;
  }
}

/**
 * Get supported providers
 */
export function getSupportedProviders(): { id: string; displayName: string }[] {
  return Object.entries(CLI_AUTH_CONFIG).map(([id, config]) => ({
    id,
    displayName: config.displayName,
  }));
}
