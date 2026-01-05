/**
 * Shared CLI Auth Configuration
 *
 * Provider-specific CLI commands and patterns for OAuth authentication.
 * Used by both the cloud API and workspace daemon.
 */

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
  /** Alternative args for device flow (if supported) */
  deviceFlowArgs?: string[];
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
  /** Whether this provider supports device flow */
  supportsDeviceFlow?: boolean;
}

/**
 * CLI commands and URL patterns for each provider
 *
 * Each CLI tool outputs an OAuth URL when run without credentials.
 * We capture stdout/stderr and extract the URL using regex patterns.
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
    credentialPath: '~/.claude/.credentials.json',
    displayName: 'Claude',
    waitTimeout: 30000, // Claude can take a while to show the auth URL
    prompts: [
      {
        // Claude Code version selection - accept default (recommended)
        pattern: /which\s*version|claude\s*code\s*version|select.*version/i,
        response: '\r',
        delay: 100,
        description: 'Version selection prompt',
      },
      {
        pattern: /dark\s*(mode|theme)/i,
        response: '\r', // Press enter to accept default
        delay: 100,
        description: 'Dark mode prompt',
      },
      {
        // Login method selection - "Select login method:" with Claude account or Console options
        pattern: /select\s*login\s*method|how\s*would\s*you\s*like\s*to\s*authenticate|choose.*auth.*method|select.*auth|subscription\s*or.*api\s*key/i,
        response: '\r', // Press enter for first option (Claude account with subscription)
        delay: 100,
        description: 'Login method selection',
      },
      {
        // Login success - press enter to continue
        pattern: /login\s*successful|logged\s*in.*press\s*enter|press\s*enter\s*to\s*continue/i,
        response: '\r',
        delay: 200,
        description: 'Login success prompt',
      },
      {
        // Trust directory - matches various trust prompts including:
        // "Quick safety check: Is this a project you created or one you trust?"
        // "Yes, I trust this folder"
        // "Do you trust the files in this folder?"
        pattern: /trust\s*(this|the)?\s*(files|directory|folder|workspace)|do\s*you\s*trust|safety\s*check|yes,?\s*i\s*trust/i,
        response: '\r', // Press enter for first option (Yes, proceed)
        delay: 300, // Slightly longer delay for menu to render
        description: 'Trust directory prompt',
      },
      {
        // Fallback: Any "press enter" or "enter to confirm/continue" prompt
        // Keep this LAST so more specific handlers match first
        pattern: /press\s*enter|enter\s*to\s*(confirm|continue|proceed)|hit\s*enter/i,
        response: '\r',
        delay: 300,
        description: 'Generic enter prompt',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i, /you.*(?:are|now).*logged/i],
  },
  openai: {
    command: 'codex',
    args: ['login'], // Standard OAuth flow
    deviceFlowArgs: ['login', '--device-auth'], // Device auth for headless/container environments
    supportsDeviceFlow: true,
    urlPattern: /(https:\/\/[^\s]+)/,
    credentialPath: '~/.codex/auth.json',
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
        response: '\r', // Select first option (Login with Google)
        delay: 200,
        description: 'Auth method selection',
      },
    ],
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i],
  },
  opencode: {
    command: 'opencode',
    args: ['auth', 'login'],
    // OpenCode redirects to provider OAuth pages (Anthropic, OpenAI, Google)
    urlPattern: /(https:\/\/[^\s]+)/,
    credentialPath: '~/.local/share/opencode/auth.json',
    displayName: 'OpenCode',
    waitTimeout: 30000,
    prompts: [
      {
        pattern: /select.*provider|choose.*provider|which.*provider/i,
        response: '\r', // Select first provider (OpenCode Zen - recommended)
        delay: 300,
        description: 'Provider selection',
      },
      {
        pattern: /opencode\s*zen|recommended/i,
        response: '\r', // Confirm provider selection
        delay: 200,
        description: 'Confirm provider',
      },
    ],
    // Success patterns include credential added and existing credentials list
    successPatterns: [/success/i, /authenticated/i, /logged\s*in/i, /credential\s*added/i, /\d+\s*credentials?/i],
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
  return patterns.some((p) => p.test(cleanText));
}

/**
 * Find matching prompt handler that hasn't been responded to yet
 */
export function findMatchingPrompt(
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
 * Get list of supported provider IDs
 */
export function getSupportedProviderIds(): string[] {
  return Object.keys(CLI_AUTH_CONFIG);
}

/**
 * Get list of supported providers with details
 */
export function getSupportedProviders(): { id: string; displayName: string; command: string }[] {
  return Object.entries(CLI_AUTH_CONFIG).map(([id, config]) => ({
    id,
    displayName: config.displayName,
    command: config.command,
  }));
}

/**
 * Validate a provider's CLI auth configuration
 * Returns null if valid, or an error message if invalid
 */
export function validateProviderConfig(
  providerId: string,
  config: CLIAuthConfig
): string | null {
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
    if (!prompt.description) {
      return `${providerId}: prompt[${i}].description is required`;
    }
  }

  if (!Array.isArray(config.successPatterns)) {
    return `${providerId}: 'successPatterns' must be an array`;
  }

  return null;
}

/**
 * Validate all provider configurations
 * Returns array of error messages (empty if all valid)
 */
export function validateAllProviderConfigs(): string[] {
  const errors: string[] = [];
  for (const [id, config] of Object.entries(CLI_AUTH_CONFIG)) {
    const error = validateProviderConfig(id, config);
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}
