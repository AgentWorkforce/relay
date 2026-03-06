import fs from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { CLI_AUTH_CONFIG } from '@agent-relay/config/cli-auth-config';
import { runInteractiveSession } from './ssh-interactive.js';

export type AuthCommandOptions = {
  workspace?: string;
  token?: string;
  cloudUrl?: string;
  timeout: string;
  useAuthBroker?: boolean;
};

export type ExitFn = (code: number) => never;

export interface AuthCommandIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

type StartResponse = {
  sessionId: string;
  ssh: {
    host: string;
    port: number | string;
    user: string;
    password: string;
  };
  command?: string;
  provider?: string;
  workspaceId: string;
  workspaceName?: string;
  expiresAt?: string;
  userId?: string;
};

export interface AuthSshRuntime {
  fetch: typeof fetch;
  loadSSH2: () => Promise<typeof import('ssh2') | null>;
  createAskpassScript: (password: string) => string;
  buildSystemSshArgs: (options: {
    host: string;
    port: number;
    username: string;
    localPort?: number;
    remotePort?: number;
  }) => string[];
  spawnProcess: typeof spawnProcess;
  createServer: typeof createServer;
  setTimeout: typeof setTimeout;
}

const DEFAULT_RUNTIME: AuthSshRuntime = {
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
  loadSSH2,
  createAskpassScript,
  buildSystemSshArgs,
  spawnProcess,
  createServer,
  setTimeout,
};

const color = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function shellEscape(value: string): string {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9_/\\.=:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readCloudConfig(configPath: string): { apiKey?: string; cloudUrl?: string } {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { apiKey?: string; cloudUrl?: string };
}

export async function loadSSH2(): Promise<typeof import('ssh2') | null> {
  try {
    return await import('ssh2');
  } catch {
    return null;
  }
}

/**
 * Create a temporary SSH_ASKPASS helper script that echoes the given password.
 * Returns the script path. Caller must clean up.
 */
export function createAskpassScript(password: string): string {
  const askpassPath = path.join(tmpdir(), `ar-askpass-${process.pid}-${Date.now()}`);
  const escaped = password.replace(/'/g, "'\"'\"'");
  fs.writeFileSync(askpassPath, `#!/bin/sh\nprintf '%s\\n' '${escaped}'\n`, { mode: 0o700 });
  return askpassPath;
}

/**
 * Build SSH args common to both auth and connect commands.
 */
export function buildSystemSshArgs(options: {
  host: string;
  port: number;
  username: string;
  localPort?: number;
  remotePort?: number;
}): string[] {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-p', String(options.port),
  ];
  if (options.localPort && options.remotePort) {
    args.push('-L', `${options.localPort}:localhost:${options.remotePort}`);
  }
  return args;
}

function normalizeProvider(providerArg: string): string {
  const providerInput = providerArg.toLowerCase().trim();
  const providerMap: Record<string, string> = {
    claude: 'anthropic',
    codex: 'openai',
    gemini: 'google',
  };
  return providerMap[providerInput] || providerInput;
}


export async function runAuthCommand(
  providerArg: string,
  options: AuthCommandOptions,
  io: AuthCommandIo,
  runtimeOverrides: Partial<AuthSshRuntime> = {}
): Promise<void> {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };

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
    io.log('Examples:');
    io.log(`  ${color.cyan('npx agent-relay auth claude --workspace=<ID>')}`);
    io.log(`  ${color.cyan('npx agent-relay auth codex --workspace=<ID>')}`);
    io.log(`  ${color.cyan('npx agent-relay auth gemini --workspace=<ID>')}`);
    io.log(`  ${color.cyan('npx agent-relay auth claude --use-auth-broker')}  ${color.dim('(for Daytona/sandboxed environments)')}`);
    io.log('');
    io.log('Supported provider ids:');
    io.log(`  ${known.join(', ')}`);
    io.exit(1);
  }

  const primaryCmd = [providerConfig.command, ...providerConfig.args].map(shellEscape).join(' ');
  const fallbackCmd =
    provider === 'cursor'
      ? `command -v agent >/dev/null 2>&1 && ${primaryCmd} || cursor-agent ${providerConfig.args.map(shellEscape).join(' ')}`
      : primaryCmd;
  const remoteCommandFallback = fallbackCmd;

  const cliToken = options.token;
  let cloudConfig: { apiKey?: string; cloudUrl?: string } = {};

  if (!cliToken) {
    const dataDir = process.env.AGENT_RELAY_DATA_DIR || path.join(homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

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
  }

  const cloudUrl = (options.cloudUrl || process.env.AGENT_RELAY_CLOUD_URL || cloudConfig.cloudUrl || 'https://agent-relay.com')
    .replace(/\/$/, '');

  const requestedWorkspaceId = options.workspace || process.env.WORKSPACE_ID;
  const useAuthBroker = options.useAuthBroker ?? false;

  io.log('');
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log(color.cyan('        Provider Authentication (SSH)'));
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log('');
  io.log(`Provider: ${providerConfig.displayName} (${provider})`);
  if (useAuthBroker) {
    io.log(`Target: ${color.cyan('Auth Broker')} (dedicated authentication instance)`);
  } else {
    io.log(`Workspace: ${requestedWorkspaceId ? `${requestedWorkspaceId.slice(0, 8)}...` : '(default)'}`);
  }
  io.log(color.dim(`Cloud: ${cloudUrl}`));
  io.log('');

  io.log('Requesting SSH session from cloud...');

  let start: StartResponse;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!cliToken && cloudConfig.apiKey) {
      headers.Authorization = `Bearer ${cloudConfig.apiKey}`;
    }

    const response = await runtime.fetch(`${cloudUrl}/api/auth/ssh/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider,
        workspaceId: requestedWorkspaceId,
        ...(cliToken && { token: cliToken }),
        ...(useAuthBroker && { useAuthBroker: true }),
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
      io.error(color.red(`Failed to start SSH auth session: ${details || response.statusText}`));
      io.exit(1);
    }

    start = (await response.json()) as StartResponse;
  } catch (err) {
    io.error(color.red(`Failed to connect to cloud API: ${err instanceof Error ? err.message : String(err)}`));
    io.exit(1);
  }

  const sshPort = typeof start.ssh?.port === 'string' ? parseInt(start.ssh.port, 10) : start.ssh?.port;
  if (!start.sessionId || !start.workspaceId || !start.ssh?.host || !sshPort || !start.ssh.user || !start.ssh.password) {
    io.error(color.red('Cloud returned invalid SSH session details.'));
    io.exit(1);
  }

  const baseCommand =
    typeof start.command === 'string' && start.command.trim().length > 0
      ? start.command.trim()
      : remoteCommandFallback;

  const remoteCommand = start.userId
    ? `mkdir -p /data/users/${shellEscape(start.userId)} && HOME=/data/users/${shellEscape(start.userId)} PATH=/home/workspace/.local/bin:$PATH ${baseCommand}`
    : `PATH=/home/workspace/.local/bin:$PATH ${baseCommand}`;

  io.log(color.green('✓ SSH session created'));
  if (useAuthBroker) {
    io.log(`Target: ${color.cyan('Auth Broker')}`);
  } else if (start.workspaceName) {
    io.log(`Workspace: ${color.cyan(start.workspaceName)} (${start.workspaceId.slice(0, 8)}...)`);
  } else {
    io.log(`Workspace: ${start.workspaceId.slice(0, 8)}...`);
  }
  io.log(color.dim(`  SSH: ${start.ssh.user}@${start.ssh.host}:${sshPort}`));
  io.log(color.dim(`  Command: ${remoteCommand}`));
  io.log('');

  const tunnelPort = 1455;

  io.log(color.yellow('Connecting via SSH...'));
  io.log(color.dim(`  Tunnel: localhost:${tunnelPort} → ${useAuthBroker ? 'auth-broker' : 'workspace'}:${tunnelPort}`));
  io.log(color.dim(`  Running: ${remoteCommand}`));
  io.log('');

  const successPatterns = providerConfig.successPatterns || [];
  const errorPatterns = providerConfig.errorPatterns || [];

  const sessionResult = await runInteractiveSession({
    ssh: {
      host: start.ssh.host,
      port: sshPort,
      user: start.ssh.user,
      password: start.ssh.password,
    },
    remoteCommand,
    successPatterns,
    errorPatterns,
    timeoutMs,
    io,
    tunnelPort,
    runtime,
  });

  io.log('');
  io.log('Finalizing authentication with cloud...');
  const success = sessionResult.authDetected;

  const providerForComplete =
    typeof start.provider === 'string' && start.provider.trim().length > 0
      ? start.provider.trim()
      : provider;

  try {
    const completeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!cliToken && cloudConfig.apiKey) {
      completeHeaders.Authorization = `Bearer ${cloudConfig.apiKey}`;
    }

    const response = await runtime.fetch(`${cloudUrl}/api/auth/ssh/complete`, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify({
        sessionId: start.sessionId,
        workspaceId: start.workspaceId,
        provider: providerForComplete,
        success,
        ...(cliToken && { token: cliToken }),
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
      io.log('');
      io.error(color.red(`Remote auth command exited with code ${exitCode}.`));
    }

    if (sessionResult.exitCode === 127) {
      io.log('');
      if (useAuthBroker) {
        io.log(color.yellow(`The ${providerConfig.displayName} CLI ("${providerConfig.command}") is not installed on the auth broker.`));
        io.log(color.dim('This is unexpected. Please report this issue.'));
      } else {
        io.log(color.yellow(`The ${providerConfig.displayName} CLI ("${providerConfig.command}") is not installed on this workspace.`));
        io.log(color.dim('Ask your workspace administrator to install it, or check the workspace Dockerfile.'));
      }
    }

    io.exit(1);
  }

  io.log('');
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log(color.green('          Authentication Complete!'));
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log('');
  if (useAuthBroker) {
    io.log(`${providerConfig.displayName} credentials are now stored in your account.`);
    io.log(color.dim('Your Daytona/sandboxed workspaces will use these credentials automatically.'));
  } else {
    io.log(`${providerConfig.displayName} is now connected to workspace ${start.workspaceId.slice(0, 8)}...`);
  }
  io.log('');
}
