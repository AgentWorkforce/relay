/**
 * Connect — Cloud-brokered Daytona Auth.
 *
 * Calls the workflows server API to create a Daytona sandbox for interactive
 * OAuth, SSHes in via PTY, then notifies the server to store credentials.
 * Follows the same pattern as auth-ssh.ts (cloud API broker).
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { CLI_AUTH_CONFIG } from '@agent-relay/config/cli-auth-config';
import { runInteractiveSession } from './ssh-interactive.js';
import type { AuthCommandIo } from './auth-ssh.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConnectCommandOptions {
  timeout: string;
  language?: string;
  cloudUrl?: string;
}

type StartResponse = {
  sessionId: string;
  ssh: {
    host: string;
    port: number | string;
    user: string;
    password: string;
  };
  remoteCommand: string;
  provider: string;
  expiresAt?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const color = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function normalizeProvider(providerArg: string): string {
  const providerInput = providerArg.toLowerCase().trim();
  const providerMap: Record<string, string> = {
    claude: 'anthropic',
    codex: 'openai',
    gemini: 'google',
  };
  return providerMap[providerInput] || providerInput;
}

function readCloudConfig(configPath: string): { apiKey?: string; cloudUrl?: string } {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { apiKey?: string; cloudUrl?: string };
}

// ── Main function ────────────────────────────────────────────────────────────

export async function runConnectCommand(
  providerArg: string,
  options: ConnectCommandOptions,
  io: AuthCommandIo
): Promise<void> {
  const timeoutSeconds = parseInt(options.timeout, 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    io.error(color.red(`Invalid --timeout value: ${options.timeout}`));
    io.exit(1);
  }
  const timeoutMs = timeoutSeconds * 1000;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    io.error(color.red('This command requires an interactive terminal (TTY).'));
    io.log(color.dim('Run it directly in your terminal (not piped/redirected).'));
    io.exit(1);
  }

  const provider = normalizeProvider(providerArg);
  const providerConfig = CLI_AUTH_CONFIG[provider];
  if (!providerConfig) {
    const known = Object.keys(CLI_AUTH_CONFIG).sort();
    io.error(color.red(`Unknown provider: ${providerArg}`));
    io.log('');
    io.log('Supported providers:');
    io.log(`  ${known.join(', ')}`);
    io.exit(1);
  }

  // Read cloud config for API key (same as auth-ssh.ts)
  const dataDir = process.env.AGENT_RELAY_DATA_DIR || path.join(homedir(), '.local', 'share', 'agent-relay');
  const configPath = path.join(dataDir, 'cloud-config.json');

  let cloudConfig: { apiKey?: string; cloudUrl?: string } = {};

  if (!fs.existsSync(configPath)) {
    io.error(color.red('Cloud config not found.'));
    io.log(color.dim(`Expected: ${configPath}`));
    io.log('');
    io.log(`Run ${color.cyan('agent-relay cloud link')} first to link this machine to Agent Relay Cloud.`);
    io.exit(1);
  }

  try {
    cloudConfig = readCloudConfig(configPath);
  } catch (err) {
    io.error(color.red(`Failed to read cloud config: ${err instanceof Error ? err.message : String(err)}`));
    io.exit(1);
  }

  if (!cloudConfig.apiKey) {
    io.error(color.red('Cloud config is missing apiKey.'));
    io.log(color.dim(`Config path: ${configPath}`));
    io.log(`Re-link with ${color.cyan('agent-relay cloud link')}.`);
    io.exit(1);
  }

  const cloudUrl = (options.cloudUrl || process.env.AGENT_RELAY_CLOUD_URL || cloudConfig.cloudUrl || 'https://agent-relay.com')
    .replace(/\/$/, '');

  const language = options.language || 'typescript';

  io.log('');
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log(color.cyan('      Provider Authentication (Daytona Connect)'));
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log('');
  io.log(`Provider: ${providerConfig.displayName} (${provider})`);
  io.log(`Language: ${color.dim(language)}`);
  io.log(color.dim(`Cloud: ${cloudUrl}`));
  io.log('');

  // 1. Request sandbox from cloud API
  io.log('Requesting sandbox from cloud...');

  let start: StartResponse;
  try {
    const response = await fetch(`${cloudUrl}/api/v1/cli/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloudConfig.apiKey}`,
      },
      body: JSON.stringify({ provider, language }),
    });

    if (!response.ok) {
      let details = response.statusText;
      try {
        const json = (await response.json()) as { error?: string; message?: string };
        details = json.error || json.message || details;
      } catch {
        try {
          details = await response.text();
        } catch {
          // ignore
        }
      }
      io.error(color.red(`Failed to create auth sandbox: ${details || response.statusText}`));
      io.exit(1);
    }

    start = (await response.json()) as StartResponse;
  } catch (err) {
    io.error(color.red(`Failed to connect to cloud API: ${err instanceof Error ? err.message : String(err)}`));
    io.exit(1);
  }

  const sshPort = typeof start.ssh?.port === 'string' ? parseInt(start.ssh.port, 10) : start.ssh?.port;
  if (!start.sessionId || !start.ssh?.host || !sshPort || !start.ssh.user || !start.ssh.password) {
    io.error(color.red('Cloud returned invalid SSH session details.'));
    io.exit(1);
  }

  io.log(color.green('✓ Sandbox ready'));
  io.log(color.dim(`  SSH: ${start.ssh.user}@${start.ssh.host}:${sshPort}`));
  io.log('');

  // 2. Run interactive session
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
    });
  } catch (err) {
    io.error(color.red(`Failed to connect via SSH: ${err instanceof Error ? err.message : String(err)}`));
    io.exit(1);
  }

  io.log('');

  const success = sessionResult.authDetected;

  // 3. Notify cloud of completion
  io.log('Finalizing authentication with cloud...');

  try {
    const response = await fetch(`${cloudUrl}/api/v1/cli/auth/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloudConfig.apiKey}`,
      },
      body: JSON.stringify({
        sessionId: start.sessionId,
        success,
      }),
    });

    if (!response.ok) {
      let details = response.statusText;
      try {
        const json = (await response.json()) as { error?: string; message?: string };
        details = json.error || json.message || details;
      } catch {
        try {
          details = await response.text();
        } catch {
          // ignore
        }
      }
      io.error(color.red(`Failed to complete auth session: ${details || response.statusText}`));
      io.exit(1);
    }
  } catch (err) {
    io.error(color.red(`Failed to complete auth session: ${err instanceof Error ? err.message : String(err)}`));
    io.exit(1);
  }

  if (!success) {
    const exitCode = sessionResult.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      io.error(color.red(`Remote auth command exited with code ${exitCode}.`));
    }
    if (sessionResult.exitCode === 127) {
      io.log(color.yellow(`The ${providerConfig.displayName} CLI ("${providerConfig.command}") is not installed on the sandbox.`));
      io.log(color.dim('Check the sandbox snapshot includes the required CLI tools.'));
    }
    io.exit(1);
  }

  io.log('');
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log(color.green('          Authentication Complete!'));
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log('');
  io.log(`${providerConfig.displayName} credentials are now stored in the Daytona volume.`);
  io.log(color.dim('Your sandboxes can mount the volume to access stored credentials.'));
  io.log('');
}
