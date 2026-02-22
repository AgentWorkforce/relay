import fs from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { CLI_AUTH_CONFIG, stripAnsiCodes, findMatchingError } from '@agent-relay/config/cli-auth-config';

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

function getSshErrorMessage(host: string, port: number, err: Error): string {
  if (err.message.includes('Authentication')) {
    return 'SSH authentication failed.';
  }
  if (err.message.includes('ECONNREFUSED')) {
    return `Cannot connect to SSH server at ${host}:${port}. Is the workspace running and SSH enabled?`;
  }
  if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
    return `Cannot resolve hostname: ${host}. Check network connectivity.`;
  }
  if (err.message.includes('ETIMEDOUT')) {
    return `Connection timed out to ${host}:${port}. Is the workspace running?`;
  }
  return `SSH error: ${err.message}`;
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
  const ssh2 = await runtime.loadSSH2();
  const tunnelTarget = useAuthBroker ? 'auth-broker' : 'workspace';

  io.log(color.yellow('Connecting via SSH...'));
  io.log(color.dim(`  Tunnel: localhost:${tunnelPort} → ${tunnelTarget}:${tunnelPort}`));
  io.log(color.dim(`  Running: ${remoteCommand}`));
  io.log('');

  const successPatterns = providerConfig.successPatterns || [];
  const errorPatterns = providerConfig.errorPatterns || [];

  let execResult: { exitCode: number | null; exitSignal: string | null; authDetected: boolean } | null = null;
  let execError: Error | null = null;

  if (ssh2) {
    const { Client } = ssh2;
    const sshClient = new Client();
    let sshReady = false;
    const tunnel: { server: ReturnType<typeof createServer> | null } = { server: null };

    const sshReadyPromise = new Promise<void>((resolve, reject) => {
      sshClient.on('ready', () => {
        sshReady = true;

        tunnel.server = runtime.createServer((localSocket) => {
          sshClient.forwardOut('127.0.0.1', tunnelPort, 'localhost', tunnelPort, (err, stream) => {
            if (err) {
              localSocket.end();
              return;
            }
            localSocket.pipe(stream).pipe(localSocket);
          });
        });

        tunnel.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            io.log(color.dim(`Note: Port ${tunnelPort} in use, OAuth callbacks may not work.`));
          }
          resolve();
        });

        tunnel.server.listen(tunnelPort, '127.0.0.1', () => {
          resolve();
        });
      });

      sshClient.on('error', (err) => {
        reject(new Error(getSshErrorMessage(start.ssh.host, sshPort, err)));
      });

      sshClient.on('close', () => {
        if (!sshReady) {
          reject(new Error(`SSH connection to ${start.ssh.host}:${sshPort} closed unexpectedly.`));
        }
      });
    });

    try {
      sshClient.connect({
        host: start.ssh.host,
        port: sshPort,
        username: start.ssh.user,
        password: start.ssh.password,
        readyTimeout: 10000,
        hostVerifier: () => true,
      });

      await Promise.race([
        sshReadyPromise,
        new Promise<void>((_, reject) => runtime.setTimeout(() => reject(new Error('SSH connection timeout')), 15000)),
      ]);
    } catch (err) {
      io.error(color.red(`Failed to connect via SSH: ${err instanceof Error ? err.message : String(err)}`));
      if (tunnel.server) tunnel.server.close();
      sshClient.end();
      io.exit(1);
    }

    const execInteractive = async (command: string, commandTimeoutMs: number) =>
      await new Promise<{ exitCode: number | null; exitSignal: string | null; authDetected: boolean }>((resolve, reject) => {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        const term = process.env.TERM || 'xterm-256color';

        sshClient.exec(command, { pty: { term, cols, rows } }, (err, stream) => {
          if (err) return reject(err);

          let exitCode: number | null = null;
          let exitSignal: string | null = null;
          let authDetected = false;
          let outputBuffer = '';

          const stdin = process.stdin;
          const stdout = process.stdout;
          const stderr = process.stderr;

          const wasRaw = (stdin as unknown as { isRaw?: boolean }).isRaw ?? false;
          try {
            stdin.setRawMode?.(true);
          } catch {
            // ignore
          }
          stdin.resume();

          const onStdinData = (data: Buffer) => {
            if (authDetected && (data[0] === 0x1b || data[0] === 0x03)) {
              cleanup();
              clearTimeout(timer);
              try {
                stream.close();
              } catch {
                // ignore
              }
              return;
            }
            stream.write(data);
          };
          stdin.on('data', onStdinData);

          const cleanup = () => {
            stdin.off('data', onStdinData);
            stdout.off('resize', onResize);
            try {
              stdin.setRawMode?.(wasRaw);
            } catch {
              // ignore
            }
            stdin.pause();
          };

          const closeOnAuthSuccess = () => {
            authDetected = true;
            stdout.write('\n');
            stdout.write(color.green('  ✓ Authentication successful!') + '\n');
            stdout.write(color.dim('  Press Escape or Ctrl+C to exit.') + '\n');
            stdout.write('\n');
          };

          stream.on('data', (data: Buffer) => {
            stdout.write(data);

            outputBuffer += data.toString();
            if (outputBuffer.length > 8192) {
              outputBuffer = outputBuffer.slice(-8192);
            }

            if (!authDetected && successPatterns.length > 0) {
              const clean = stripAnsiCodes(outputBuffer);
              for (const pattern of successPatterns) {
                if (pattern.test(clean)) {
                  closeOnAuthSuccess();
                  break;
                }
              }
            }

            if (!authDetected && errorPatterns.length > 0) {
              const matched = findMatchingError(outputBuffer, errorPatterns);
              if (matched) {
                clearTimeout(timer);
                cleanup();
                try {
                  stream.close();
                } catch {
                  // ignore
                }
                reject(new Error(matched.message + (matched.hint ? ` ${matched.hint}` : '')));
              }
            }
          });

          stream.stderr.on('data', (data: Buffer) => {
            stderr.write(data);
          });

          const onResize = () => {
            try {
              stream.setWindow(stdout.rows || 24, stdout.columns || 80, 0, 0);
            } catch {
              // ignore
            }
          };
          stdout.on('resize', onResize);

          const timer = runtime.setTimeout(() => {
            cleanup();
            try {
              stream.close();
            } catch {
              // ignore
            }
            reject(new Error(`Authentication timed out after ${Math.floor(commandTimeoutMs / 1000)}s`));
          }, commandTimeoutMs);

          stream.on('exit', (code: unknown, signal?: unknown) => {
            if (typeof code === 'number') exitCode = code;
            if (typeof signal === 'string') exitSignal = signal;
          });

          stream.on('close', () => {
            clearTimeout(timer);
            cleanup();
            resolve({ exitCode, exitSignal, authDetected });
          });

          stream.on('error', (streamErr: unknown) => {
            clearTimeout(timer);
            cleanup();
            reject(streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
          });
        });
      });

    try {
      io.log(color.yellow('Starting interactive authentication...'));
      io.log(color.dim('Follow the prompts below. The session will close automatically when auth completes.'));
      io.log('');
      execResult = await execInteractive(remoteCommand, timeoutMs);
    } catch (err) {
      execError = err instanceof Error ? err : new Error(String(err));
      io.log('');
      io.error(color.red(`Remote auth command failed: ${execError.message}`));
    } finally {
      if (tunnel.server) tunnel.server.close();
      sshClient.end();
    }
  } else {
    const askpassPath = runtime.createAskpassScript(start.ssh.password);
    try {
      const sshArgs = runtime.buildSystemSshArgs({
        host: start.ssh.host,
        port: sshPort,
        username: start.ssh.user,
        localPort: tunnelPort,
        remotePort: tunnelPort,
      });
      sshArgs.push('-tt');
      sshArgs.push(`${start.ssh.user}@${start.ssh.host}`);
      sshArgs.push(remoteCommand);

      io.log(color.yellow('Starting interactive authentication...'));
      io.log(color.dim('Follow the prompts below.'));
      io.log('');

      const child = runtime.spawnProcess('ssh', sshArgs, {
        stdio: 'inherit',
        env: {
          ...process.env,
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: process.env.DISPLAY || ':0',
        },
      });

      execResult = await new Promise((resolve) => {
        child.on('exit', (code, signal) => {
          resolve({
            exitCode: code,
            exitSignal: signal ? String(signal) : null,
            authDetected: code === 0,
          });
        });
        child.on('error', (err) => {
          io.error(color.red(`Failed to launch ssh: ${err.message}`));
          resolve({ exitCode: 1, exitSignal: null, authDetected: false });
        });
      });
    } catch (err) {
      execError = err instanceof Error ? err : new Error(String(err));
      io.log('');
      io.error(color.red(`SSH error: ${execError.message}`));
    } finally {
      try {
        fs.unlinkSync(askpassPath);
      } catch {
        // ignore
      }
    }
  }

  io.log('');
  io.log('Finalizing authentication with cloud...');
  const success = execError === null && (execResult?.authDetected === true || execResult?.exitCode === 0);

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
    const exitCode = execResult?.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      io.log('');
      io.error(color.red(`Remote auth command exited with code ${exitCode}.`));
    }

    if (execResult?.exitCode === 127) {
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
