/**
 * Provider connect orchestration — provisions a Daytona sandbox via the
 * Cloud API, opens an interactive SSH session that runs the provider CLI,
 * and finalizes the auth state with Cloud.
 *
 * The CLI command in `agent-relay cloud connect <provider>` is a thin wrapper
 * around this function; other tools (e.g. `ricky connect <provider>`) can
 * import it directly and drive the same flow.
 */

import { CLI_AUTH_CONFIG } from '@agent-relay/config/cli-auth-config';

import { ensureAuthenticated, authorizedApiFetch } from './auth.js';
import { defaultApiUrl, type AuthSessionResponse } from './types.js';
import { runInteractiveSession } from './lib/ssh-interactive.js';
import type { AuthSshRuntime } from './lib/ssh-runtime.js';

const PROVIDER_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
};

export function getProviderHelpText(): string {
  return Object.keys(CLI_AUTH_CONFIG)
    .sort()
    .map((id) => {
      const alias = Object.entries(PROVIDER_ALIASES).find(([, target]) => target === id);
      return alias ? `${id} (alias: ${alias[0]})` : id;
    })
    .join(', ');
}

export function normalizeProvider(providerArg: string): string {
  const providerInput = providerArg.toLowerCase().trim();
  return PROVIDER_ALIASES[providerInput] || providerInput;
}

export interface ConnectProviderIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ConnectProviderOptions {
  /** Provider id or alias (`anthropic`/`claude`, `openai`/`codex`, `google`/`gemini`, …). */
  provider: string;
  /** Override the Cloud API URL. Defaults to `defaultApiUrl()`. */
  apiUrl?: string;
  /** Sandbox language/image. Defaults to `'typescript'`. */
  language?: string;
  /** Auth timeout in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Logger sink. Defaults to `console.log` / `console.error`. */
  io?: ConnectProviderIo;
  /** Override SSH/network runtime hooks (used in tests). */
  runtime?: Partial<AuthSshRuntime>;
}

export interface ConnectProviderResult {
  /** Normalized provider id used for the request. */
  provider: string;
  /** Whether the interactive session reported a positive auth pattern match. */
  success: boolean;
}

const color = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const DEFAULT_IO: ConnectProviderIo = {
  log: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
};

async function getErrorDetails(response: Response): Promise<string> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return response.statusText;
  }
  if (!body) return response.statusText;
  try {
    const json = JSON.parse(body) as { error?: string; message?: string };
    return json.error || json.message || response.statusText;
  } catch {
    return body;
  }
}

/**
 * Connect a provider via interactive SSH session.
 *
 * Throws on any failure. Returns `{ provider, success }` when the auth flow
 * completed successfully — `success` is always `true` on resolved promises;
 * an unsuccessful auth attempt rejects with a descriptive Error.
 */
export async function connectProvider(options: ConnectProviderOptions): Promise<ConnectProviderResult> {
  const io = options.io ?? DEFAULT_IO;
  const language = options.language ?? 'typescript';
  const timeoutMs = options.timeoutMs ?? 300_000;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('connectProvider requires an interactive terminal (TTY).');
  }

  const provider = normalizeProvider(options.provider);
  const providerConfig = CLI_AUTH_CONFIG[provider];
  if (!providerConfig) {
    const known = Object.keys(CLI_AUTH_CONFIG).sort();
    throw new Error(`Unknown provider: ${options.provider}. Supported providers: ${known.join(', ')}`);
  }

  const apiUrl = options.apiUrl || defaultApiUrl();

  io.log('');
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log(color.cyan('      Provider Authentication (Daytona Connect)'));
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log('');
  io.log(`Provider: ${providerConfig.displayName} (${provider})`);
  io.log(`Language: ${color.dim(language)}`);
  io.log(color.dim(`Cloud: ${apiUrl}`));
  io.log('');
  io.log('Requesting sandbox from cloud...');

  let auth = await ensureAuthenticated(apiUrl);

  const { response: createResponse, auth: refreshedAuth } = await authorizedApiFetch(
    auth,
    '/api/v1/cli/auth',
    {
      method: 'POST',
      body: JSON.stringify({ provider, language }),
    }
  );
  auth = refreshedAuth;

  const start = (await createResponse.json().catch(() => null)) as
    | (AuthSessionResponse & { error?: string; message?: string })
    | null;

  if (!createResponse.ok || !start?.sessionId) {
    const detail = start?.error || start?.message || `${createResponse.status} ${createResponse.statusText}`;
    throw new Error(detail);
  }

  const sshPort =
    typeof start.ssh?.port === 'string'
      ? Number.parseInt(start.ssh.port as unknown as string, 10)
      : start.ssh?.port;
  if (!start.ssh?.host || !sshPort || !start.ssh.user || !start.ssh.password) {
    throw new Error('Cloud returned invalid SSH session details.');
  }

  io.log(color.green('✓ Sandbox ready'));
  io.log(color.dim(`  SSH: ${start.ssh.user}@${start.ssh.host}:${sshPort}`));
  io.log('');
  io.log(color.yellow('Connecting via SSH...'));
  io.log(color.dim(`  Running: ${start.remoteCommand}`));
  io.log('');

  let sessionResult;
  try {
    sessionResult = await runInteractiveSession({
      ssh: {
        host: start.ssh.host,
        port: sshPort,
        user: start.ssh.user,
        password: start.ssh.password,
      },
      remoteCommand: start.remoteCommand,
      successPatterns: providerConfig.successPatterns || [],
      errorPatterns: providerConfig.errorPatterns || [],
      timeoutMs,
      io,
      runtime: options.runtime,
    });
  } catch (error) {
    throw new Error(`Failed to connect via SSH: ${error instanceof Error ? error.message : String(error)}`);
  }

  io.log('');
  const authSuccess = sessionResult.authDetected;

  io.log('Finalizing authentication with cloud...');
  const { response: completeResponse } = await authorizedApiFetch(auth, '/api/v1/cli/auth/complete', {
    method: 'POST',
    body: JSON.stringify({ sessionId: start.sessionId, success: authSuccess }),
  });

  if (!completeResponse.ok) {
    throw new Error(await getErrorDetails(completeResponse));
  }

  if (!authSuccess) {
    const exitCode = sessionResult.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      io.error(color.red(`Remote auth command exited with code ${exitCode}.`));
    }
    if (sessionResult.exitCode === 127) {
      io.log(
        color.yellow(
          `The ${providerConfig.displayName} CLI ("${providerConfig.command}") is not installed on the sandbox.`
        )
      );
      io.log(color.dim('Check the sandbox snapshot includes the required CLI tools.'));
    }
    throw new Error(`Provider auth for ${provider} did not complete successfully`);
  }

  io.log('');
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log(color.green('          Authentication Complete!'));
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log('');
  io.log(`${providerConfig.displayName} credentials are now stored and encrypted.`);
  io.log(color.dim('Your workflows will automatically use these credentials.'));
  io.log('');

  return { provider, success: true };
}
