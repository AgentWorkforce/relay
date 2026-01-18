/**
 * CLI PTY Runner
 *
 * Shared module for running CLI auth flows via PTY.
 * Used by both production (onboarding.ts) and tests (ci-test-real-clis.ts).
 *
 * This module uses the relay-pty Rust binary for PTY emulation,
 * removing the dependency on node-pty for better Node.js version compatibility.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Get the directory where this module is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared config and utilities
import {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
  validateProviderConfig,
  validateAllProviderConfigs as validateAllConfigs,
  getSupportedProviders,
  type CLIAuthConfig,
  type PromptHandler,
} from '../../shared/cli-auth-config.js';

// Re-export everything from shared config for backward compatibility
export {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
  matchesSuccessPattern,
  findMatchingPrompt,
  validateProviderConfig,
  getSupportedProviders,
  type CLIAuthConfig,
  type PromptHandler,
};

// Wrapper that throws instead of returning array (backward compatible)
export function validateAllProviderConfigs(): void {
  const errors = validateAllConfigs();
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
 * Find the relay-pty binary path.
 * Returns null if not found.
 */
function findRelayPtyBinary(): string | null {
  // Get the package root (four levels up from dist/cloud/api/)
  const packageRoot = join(__dirname, '..', '..', '..');

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

/**
 * Run CLI auth flow via PTY using relay-pty binary
 *
 * This is the core PTY runner used by both production and tests.
 * It handles:
 * - Spawning the CLI with proper TTY emulation via relay-pty
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

  // Find relay-pty binary
  const relayPtyPath = findRelayPtyBinary();
  if (!relayPtyPath) {
    result.error = 'relay-pty binary not found. Build with: cd relay-pty && cargo build --release';
    return result;
  }

  return new Promise((resolve) => {
    try {
      // Generate unique name for this auth session
      const sessionName = `auth-${randomUUID().substring(0, 8)}`;

      // Build relay-pty arguments
      const relayArgs = [
        '--name', sessionName,
        '--rows', '30',
        '--cols', '120',
        '--log-level', 'error', // Suppress relay-pty logs
        '--', config.command,
        ...config.args,
      ];

      const proc: ChildProcess = spawn(relayPtyPath, relayArgs, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          TERM: 'xterm-256color',
          // Prevent CLIs from trying to open browsers
          BROWSER: 'echo',
          DISPLAY: '',
          ...options.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Timeout handler
      const timeout = setTimeout(() => {
        proc.kill();
        result.error = 'Timeout waiting for auth URL';
        resolve(result);
      }, config.waitTimeout + 5000);

      // Handle stdout (main PTY output)
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        result.output += text;
        options.onOutput?.(text);

        // Check for matching prompts and auto-respond
        const matchingPrompt = findMatchingPrompt(text, config.prompts, respondedPrompts);
        if (matchingPrompt) {
          respondedPrompts.add(matchingPrompt.description);
          result.promptsHandled.push(matchingPrompt.description);
          options.onPromptHandled?.(matchingPrompt.description);

          const delay = matchingPrompt.delay ?? 100;
          setTimeout(() => {
            try {
              proc.stdin?.write(matchingPrompt.response);
            } catch {
              // Process may have exited
            }
          }, delay);
        }

        // Look for auth URL
        const cleanText = stripAnsiCodes(text);
        const match = cleanText.match(config.urlPattern);
        if (match && match[1] && !result.authUrl) {
          result.authUrl = match[1];
          options.onAuthUrl?.(result.authUrl);
        }

        // Check for success indicators
        if (matchesSuccessPattern(text, config.successPatterns)) {
          result.success = true;
        }
      });

      // Handle stderr (relay-pty logs, usually minimal)
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // Also check stderr for output (some CLIs write to stderr)
        result.output += text;
        options.onOutput?.(text);

        // Check stderr for auth URLs too
        const cleanText = stripAnsiCodes(text);
        const match = cleanText.match(config.urlPattern);
        if (match && match[1] && !result.authUrl) {
          result.authUrl = match[1];
          options.onAuthUrl?.(result.authUrl);
        }
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        result.exitCode = code;

        // Consider it a success if we got a URL (main goal)
        // or if exit code was 0 with success pattern
        if (result.authUrl || (code === 0 && result.success)) {
          result.success = true;
        }

        if (!result.authUrl && !result.success && !result.error) {
          result.error = 'Failed to extract auth URL from CLI output';
        }

        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        result.error = err.message;
        resolve(result);
      });
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Unknown error';
      resolve(result);
    }
  });
}
