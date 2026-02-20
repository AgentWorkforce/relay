import fs from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  buildSystemSshArgs,
  createAskpassScript,
  loadSSH2,
  type AuthCommandIo,
} from './auth-ssh.js';

export type CliAuthOptions = {
  workspace?: string;
  cloudUrl: string;
  token?: string;
  sessionCookie?: string;
  timeout: string;
};

type TunnelInfo = {
  host: string;
  port: number;
  user: string;
  password: string;
  tunnelPort: number;
  workspaceName: string;
  authUrl?: string;
};

export interface AuthCliRuntime {
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
  sleep: (ms: number) => Promise<void>;
  onSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  now: () => number;
}

const DEFAULT_RUNTIME: AuthCliRuntime = {
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
  loadSSH2,
  createAskpassScript,
  buildSystemSshArgs,
  spawnProcess,
  createServer,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  onSignal: (signal, listener) => {
    process.on(signal, listener);
  },
  now: () => Date.now(),
};

const CLI_AUTH_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
  google: 'Gemini',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  droid: 'Droid',
};

const CLI_AUTH_COMMAND_NAMES: Record<string, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  cursor: 'cursor',
  copilot: 'copilot',
  opencode: 'opencode',
  droid: 'droid',
};

const CLI_AUTH_PROVIDER_MAP: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
};

const color = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function getSshErrorMessage(host: string, port: number, err: Error): string {
  if (err.message.includes('Authentication')) {
    return 'SSH authentication failed. Check the password.';
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

export async function runCliAuthCommand(
  providerArg: string,
  options: CliAuthOptions,
  io: AuthCommandIo,
  runtimeOverrides: Partial<AuthCliRuntime> = {}
): Promise<void> {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  const provider = CLI_AUTH_PROVIDER_MAP[providerArg.toLowerCase()] || providerArg.toLowerCase();
  const displayName = CLI_AUTH_DISPLAY_NAMES[provider] || provider;
  const cliName = CLI_AUTH_COMMAND_NAMES[provider] || provider;

  const timeoutSeconds = parseInt(options.timeout, 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    io.error(color.red(`Invalid --timeout value: ${options.timeout}`));
    io.exit(1);
  }

  const timeoutMs = timeoutSeconds * 1000;
  const cloudUrl = options.cloudUrl.replace(/\/$/, '');
  const tunnelPort = 1455;

  io.log('');
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log(color.cyan(`       ${displayName} Authentication Helper`));
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log('');

  if (!options.workspace) {
    io.error(color.red('Missing --workspace parameter.'));
    io.log('');
    io.log(`To connect ${displayName}, follow these steps:`);
    io.log('');
    io.log('  1. Go to the Agent Relay dashboard');
    io.log(`  2. Click "Connect with ${displayName}" (Settings → AI Providers)`);
    io.log('  3. Copy the command shown (it includes the workspace ID and token)');
    io.log('  4. Run the command in your terminal');
    io.log('');
    io.log('The command will look like:');
    io.log(color.cyan(`  npx agent-relay cli-auth ${cliName} --workspace=<ID> --token=<TOKEN>`));
    io.log('');
    io.exit(1);
  }

  if (!options.token && !options.sessionCookie) {
    io.error(color.red('Missing --token parameter.'));
    io.log('');
    io.log(`The token is provided by the dashboard when you click "Connect with ${displayName}".`);
    io.log('Copy the complete command from the dashboard and paste it here.');
    io.log('');
    io.exit(1);
  }

  const workspaceId = options.workspace;
  io.log(`Provider: ${displayName}`);
  io.log(`Workspace: ${workspaceId.slice(0, 8)}...`);
  io.log('Getting workspace connection info...');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.sessionCookie) {
    headers.Cookie = options.sessionCookie;
  }

  let tunnelInfo: TunnelInfo;
  try {
    const tunnelInfoUrl = new URL(`${cloudUrl}/api/auth/codex-helper/tunnel-info/${workspaceId}`);
    if (options.token) {
      tunnelInfoUrl.searchParams.set('token', options.token);
    }
    tunnelInfoUrl.searchParams.set('provider', provider);

    const response = await runtime.fetch(tunnelInfoUrl.toString(), {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      io.error(color.red(`Failed to get tunnel info: ${errorData.error || response.statusText}`));
      io.exit(1);
    }

    tunnelInfo = (await response.json()) as TunnelInfo;
  } catch (err) {
    io.error(color.red(`Failed to connect to cloud API: ${err instanceof Error ? err.message : String(err)}`));
    io.exit(1);
  }

  io.log(`Workspace: ${color.cyan(tunnelInfo.workspaceName)}`);
  io.log('');

  io.log(color.yellow('Establishing SSH tunnel...'));
  io.log(color.dim(`  SSH: ${tunnelInfo.host}:${tunnelInfo.port}`));
  io.log(color.dim(`  Tunnel: localhost:${tunnelPort} → workspace:${tunnelInfo.tunnelPort}`));
  io.log('');

  const ssh2 = await runtime.loadSSH2();
  let sshCleanup: () => void;

  if (ssh2) {
    const { Client } = ssh2;
    const sshClient = new Client();
    const tunnel: { server: ReturnType<typeof createServer> | null } = { server: null };
    let tunnelReady = false;
    let tunnelError: string | null = null;

    const tunnelPromise = new Promise<void>((resolve, reject) => {
      sshClient.on('ready', () => {
        tunnel.server = runtime.createServer((localSocket) => {
          sshClient.forwardOut('127.0.0.1', tunnelPort, 'localhost', tunnelInfo.tunnelPort, (err, stream) => {
            if (err) {
              localSocket.end();
              return;
            }
            localSocket.pipe(stream).pipe(localSocket);
          });
        });

        tunnel.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            tunnelError = `Port ${tunnelPort} is already in use. Close any other applications using this port.`;
          } else {
            tunnelError = err.message;
          }
          reject(new Error(tunnelError));
        });

        tunnel.server.listen(tunnelPort, '127.0.0.1', () => {
          tunnelReady = true;
          resolve();
        });
      });

      sshClient.on('error', (err) => {
        tunnelError = getSshErrorMessage(tunnelInfo.host, tunnelInfo.port, err);
        reject(new Error(tunnelError));
      });

      sshClient.on('close', () => {
        if (!tunnelReady) {
          if (!tunnelError) {
            tunnelError = `SSH connection to ${tunnelInfo.host}:${tunnelInfo.port} closed unexpectedly. The workspace may not have SSH enabled or the port may be blocked.`;
          }
          reject(new Error(tunnelError));
        }
      });

      sshClient.connect({
        host: tunnelInfo.host,
        port: tunnelInfo.port,
        username: tunnelInfo.user,
        password: tunnelInfo.password,
        readyTimeout: 10000,
        hostVerifier: () => true,
      });
    });

    try {
      await Promise.race([
        tunnelPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('SSH connection timeout')), 15000)),
      ]);
    } catch (err) {
      io.error(color.red(`Failed to establish tunnel: ${err instanceof Error ? err.message : String(err)}`));
      sshClient.end();
      io.exit(1);
    }

    sshCleanup = () => {
      if (tunnel.server) tunnel.server.close();
      sshClient.end();
    };
  } else {
    const askpassPath = runtime.createAskpassScript(tunnelInfo.password);
    const sshArgs = runtime.buildSystemSshArgs({
      host: tunnelInfo.host,
      port: tunnelInfo.port,
      username: tunnelInfo.user,
      localPort: tunnelPort,
      remotePort: tunnelInfo.tunnelPort,
    });
    sshArgs.push('-N');
    sshArgs.push(`${tunnelInfo.user}@${tunnelInfo.host}`);

    const child = runtime.spawnProcess('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY || ':0',
      },
    });

    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(true), 3000);
      child.on('error', (err) => {
        clearTimeout(timeout);
        io.error(color.red(`Failed to launch ssh: ${err.message}`));
        resolve(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== null && code !== 0) {
          io.error(color.red(`SSH exited with code ${code}. Check credentials and connectivity.`));
        }
        resolve(false);
      });
      child.stderr?.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message && !message.includes('Warning:')) {
          io.log(color.dim(`  ssh: ${message}`));
        }
      });
    });

    if (!connected) {
      try {
        fs.unlinkSync(askpassPath);
      } catch {
        // ignore
      }
      io.exit(1);
    }

    sshCleanup = () => {
      child.kill();
      try {
        fs.unlinkSync(askpassPath);
      } catch {
        // ignore
      }
    };
  }

  io.log(color.green('✓ SSH tunnel established!'));
  io.log('');

  const cleanup = () => {
    io.log('');
    io.log(color.dim('Shutting down...'));
    sshCleanup();
    io.exit(0);
  };
  runtime.onSignal('SIGINT', cleanup);
  runtime.onSignal('SIGTERM', cleanup);

  if (tunnelInfo.authUrl) {
    io.log('');
    io.log(color.green('Ready! Open this URL in your browser to complete authentication:'));
    io.log('');
    io.log(color.cyan(tunnelInfo.authUrl));
    io.log('');
    io.log(color.dim(`The browser will redirect to localhost:${tunnelPort}, which tunnels to the workspace.`));
    io.log(color.dim(`The ${displayName} CLI in the workspace will receive the callback and complete auth.`));
    io.log('');
  } else {
    io.log('');
    io.log(color.yellow('OAuth URL not available. Please start authentication from the dashboard.'));
    io.log('');
  }

  io.log(color.cyan(`Waiting for authentication... (timeout: ${options.timeout}s)`));

  const startTime = runtime.now();
  let authenticated = false;

  while (!authenticated && runtime.now() - startTime < timeoutMs) {
    await runtime.sleep(3000);

    try {
      const authStatusUrl = new URL(`${cloudUrl}/api/auth/codex-helper/auth-status/${workspaceId}`);
      if (options.token) {
        authStatusUrl.searchParams.set('token', options.token);
      }
      authStatusUrl.searchParams.set('provider', provider);

      const statusResponse = await runtime.fetch(authStatusUrl.toString(), {
        method: 'GET',
        headers,
        credentials: 'include',
      });

      if (statusResponse.ok) {
        const statusData = (await statusResponse.json()) as { authenticated: boolean };
        if (statusData.authenticated) {
          authenticated = true;
        }
      }
    } catch {
      // ignore polling errors
    }

    const elapsed = Math.floor((runtime.now() - startTime) / 1000);
    if (!authenticated && elapsed > 0 && elapsed % 30 === 0) {
      io.log(`  Still waiting... (${elapsed}s)`);
    }
  }

  sshCleanup();

  if (authenticated) {
    io.log('');
    io.log(color.green('═══════════════════════════════════════════════════'));
    io.log(color.green('          Authentication Complete!'));
    io.log(color.green('═══════════════════════════════════════════════════'));
    io.log('');
    io.log(`Your ${displayName} account is now connected to the workspace.`);
    io.log('You can close this terminal and return to the dashboard.');
    io.log('');
    return;
  }

  io.error(color.red('Timeout waiting for authentication.'));
  io.log('');
  io.log('If you completed sign-in, the workspace may not have received');
  io.log('the callback. Check if the SSH tunnel was working correctly.');
  io.exit(1);
}
