/**
 * CLI PTY Runner
 *
 * Shared module for running CLI auth flows via PTY.
 * Used by both production (onboarding.ts) and tests (ci-test-real-clis.ts).
 *
 * This module has minimal dependencies (only node-pty) so it can be
 * used in isolated test containers without the full server stack.
 */

import * as pty from 'node-pty';

/**
 * Interactive prompt handler configuration
 * Defines patterns to detect prompts and responses to send
 */
export interface PromptHandler {
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
    waitTimeout: 5000,
    prompts: [
      {
        pattern: /login\s*with\s*google|google\s*account|choose.*auth/i,
        response: '\r', // Select first option (Login with Google)
        delay: 200,
        description: 'Auth method selection',
      },
    ],
    successPatterns: [
      /success/i,
      /authenticated/i,
      /logged\s*in/i,
    ],
  },
  opencode: {
    command: 'opencode',
    args: ['auth', 'login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'OpenCode',
    waitTimeout: 5000,
    prompts: [
      {
        pattern: /select.*provider|choose.*provider|which.*provider/i,
        response: '\r', // Select first provider
        delay: 200,
        description: 'Provider selection',
      },
      {
        pattern: /claude\s*pro|anthropic|select.*auth/i,
        response: '\r', // Select first auth option
        delay: 200,
        description: 'Auth type selection',
      },
    ],
    successPatterns: [
      /success/i,
      /authenticated/i,
      /logged\s*in/i,
    ],
  },
  droid: {
    command: 'droid',
    args: ['--login'],
    urlPattern: /(https:\/\/[^\s]+)/,
    displayName: 'Droid',
    waitTimeout: 5000,
    prompts: [
      {
        pattern: /sign\s*in|log\s*in|authenticate/i,
        response: '\r',
        delay: 200,
        description: 'Login prompt',
      },
    ],
    successPatterns: [
      /success/i,
      /authenticated/i,
      /logged\s*in/i,
    ],
  },
};

/**
 * Strip ANSI escape codes from text
 */
export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
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
 * Result of running a CLI auth flow via PTY
 */
export interface PTYAuthResult {
  authUrl: string | null;
  success: boolean;
  promptsHandled: string[];
  output: string;
  exitCode: number | null;
  error?: string;
}

/**
 * Options for running CLI auth via PTY
 */
export interface PTYAuthOptions {
  /** Callback when auth URL is found */
  onAuthUrl?: (url: string) => void;
  /** Callback when a prompt is handled */
  onPromptHandled?: (description: string) => void;
  /** Callback for raw PTY output */
  onOutput?: (data: string) => void;
  /** Environment variables override */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
}

/**
 * Run CLI auth flow via PTY
 *
 * This is the core PTY runner used by both production and tests.
 * It handles:
 * - Spawning the CLI with proper TTY emulation
 * - Auto-responding to interactive prompts
 * - Extracting auth URLs from output
 * - Detecting success patterns
 *
 * @param config - CLI auth configuration for the provider
 * @param options - Optional callbacks and overrides
 * @returns Promise resolving to auth result
 */
export async function runCLIAuthViaPTY(
  config: CLIAuthConfig,
  options: PTYAuthOptions = {}
): Promise<PTYAuthResult> {
  const result: PTYAuthResult = {
    authUrl: null,
    success: false,
    promptsHandled: [],
    output: '',
    exitCode: null,
  };

  const respondedPrompts = new Set<string>();

  return new Promise((resolve) => {
    try {
      const proc = pty.spawn(config.command, config.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          TERM: 'xterm-256color',
          // Prevent CLIs from trying to open browsers
          BROWSER: 'echo',
          DISPLAY: '',
          ...options.env,
        } as Record<string, string>,
      });

      // Timeout handler
      const timeout = setTimeout(() => {
        proc.kill();
        result.error = 'Timeout waiting for auth URL';
        resolve(result);
      }, config.waitTimeout + 5000);

      proc.onData((data: string) => {
        result.output += data;
        options.onOutput?.(data);

        // Check for matching prompts and auto-respond
        const matchingPrompt = findMatchingPrompt(data, config.prompts, respondedPrompts);
        if (matchingPrompt) {
          respondedPrompts.add(matchingPrompt.description);
          result.promptsHandled.push(matchingPrompt.description);
          options.onPromptHandled?.(matchingPrompt.description);

          const delay = matchingPrompt.delay ?? 100;
          setTimeout(() => {
            try {
              proc.write(matchingPrompt.response);
            } catch {
              // Process may have exited
            }
          }, delay);
        }

        // Look for auth URL
        const cleanText = stripAnsiCodes(data);
        const match = cleanText.match(config.urlPattern);
        if (match && match[1] && !result.authUrl) {
          result.authUrl = match[1];
          options.onAuthUrl?.(result.authUrl);
        }

        // Check for success indicators
        if (matchesSuccessPattern(data, config.successPatterns)) {
          result.success = true;
        }
      });

      proc.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        result.exitCode = exitCode;

        // Consider it a success if we got a URL (main goal)
        // or if exit code was 0 with success pattern
        if (result.authUrl || (exitCode === 0 && result.success)) {
          result.success = true;
        }

        if (!result.authUrl && !result.success && !result.error) {
          result.error = 'Failed to extract auth URL from CLI output';
        }

        resolve(result);
      });
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Unknown error';
      resolve(result);
    }
  });
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
