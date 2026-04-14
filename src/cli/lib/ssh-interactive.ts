/**
 * SSH Interactive Session — Reusable SSH+PTY logic.
 *
 * Extracted from auth-ssh.ts so it can be shared between the `auth` command
 * (cloud API broker) and the `connect` command (direct Daytona broker).
 */

import { createServer } from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import { stripAnsiCodes, findMatchingError, type ErrorPattern } from '@agent-relay/config/cli-auth-config';
import { loadSSH2, createAskpassScript, buildSystemSshArgs, type AuthSshRuntime } from './auth-ssh.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SshConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface InteractiveSessionOptions {
  ssh: SshConnectionInfo;
  remoteCommand: string;
  successPatterns: RegExp[];
  errorPatterns: ErrorPattern[];
  timeoutMs: number;
  io: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  tunnelPort?: number;
  runtime?: Partial<AuthSshRuntime>;
}

export interface InteractiveSessionResult {
  exitCode: number | null;
  exitSignal: string | null;
  authDetected: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const color = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

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

// ── Main function ────────────────────────────────────────────────────────────

const DEFAULT_RUNTIME: Pick<
  AuthSshRuntime,
  'loadSSH2' | 'createAskpassScript' | 'buildSystemSshArgs' | 'spawnProcess' | 'createServer' | 'setTimeout'
> = {
  loadSSH2,
  createAskpassScript,
  buildSystemSshArgs,
  spawnProcess,
  createServer,
  setTimeout,
};

/**
 * Format a remote command for execution inside an ssh2 shell() PTY.
 *
 * Wraps the command in `exec sh -c '…'` so the PTY closes cleanly when the
 * target CLI exits (no shell-teardown race with a TUI's alt-screen flush)
 * while still letting `sh` parse leading prefix assignments like
 * `PATH=/foo/bin claude`. A bare `exec PATH=… claude` does not work in zsh
 * because zsh's exec builtin treats `PATH=…` as the command name instead of
 * a prefix assignment.
 */
export function formatShellInvocation(command: string): string {
  const escaped = command.replace(/'/g, `'\\''`);
  return `exec sh -c '${escaped}'\n`;
}

/**
 * Run an interactive SSH session with PTY.
 *
 * Connects via ssh2 (if available) or falls back to system ssh,
 * sets up a local port tunnel, and runs the remote command in a PTY.
 * Monitors output for success/error patterns.
 */
export async function runInteractiveSession(
  options: InteractiveSessionOptions
): Promise<InteractiveSessionResult> {
  const { ssh, remoteCommand, successPatterns, errorPatterns, timeoutMs, io, tunnelPort = 1455 } = options;

  const runtime = { ...DEFAULT_RUNTIME, ...options.runtime };

  const ssh2 = await runtime.loadSSH2();

  let execResult: InteractiveSessionResult | null = null;
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
        reject(new Error(getSshErrorMessage(ssh.host, ssh.port, err)));
      });

      sshClient.on('close', () => {
        if (!sshReady) {
          reject(new Error(`SSH connection to ${ssh.host}:${ssh.port} closed unexpectedly.`));
        }
      });
    });

    try {
      sshClient.connect({
        host: ssh.host,
        port: ssh.port,
        username: ssh.user,
        password: ssh.password,
        readyTimeout: 10000,
        hostVerifier: () => true,
      });

      await Promise.race([
        sshReadyPromise,
        new Promise<void>((_, reject) =>
          runtime.setTimeout(() => reject(new Error('SSH connection timeout')), 15000)
        ),
      ]);
    } catch (err) {
      io.error(color.red(`Failed to connect via SSH: ${err instanceof Error ? err.message : String(err)}`));
      if (tunnel.server) tunnel.server.close();
      sshClient.end();
      throw err;
    }

    const execInteractive = async (command: string, commandTimeoutMs: number) =>
      await new Promise<InteractiveSessionResult>((resolve, reject) => {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        const term = process.env.TERM || 'xterm-256color';

        // Use shell() instead of exec() — some CLIs (e.g. claude) only produce
        // output inside a proper login shell with full TTY environment.
        sshClient.shell({ term, cols, rows }, (err, stream) => {
          if (err) return reject(err);

          let exitCode: number | null = null;
          let exitSignal: string | null = null;
          let authDetected = false;
          let outputBuffer = '';
          // Don't match success/error patterns against shell MOTD — some
          // sandbox images print "Last logged in: …" which would match the
          // broad `/logged\s*in/i` success pattern before the target CLI
          // even runs.
          let patternMatchingEnabled = false;

          const stdin = process.stdin;
          const stdout = process.stdout;
          const stderr = process.stderr;

          const wasRaw = (stdin as unknown as { isRaw?: boolean }).isRaw ?? false;

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

            if (patternMatchingEnabled && !authDetected && successPatterns.length > 0) {
              const clean = stripAnsiCodes(outputBuffer);
              for (const pattern of successPatterns) {
                if (pattern.test(clean)) {
                  closeOnAuthSuccess();
                  break;
                }
              }
            }

            if (patternMatchingEnabled && !authDetected && errorPatterns.length > 0) {
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

          stdout.on('resize', onResize);
          stdin.on('data', onStdinData);

          try {
            stdin.setRawMode?.(true);
          } catch {
            // ignore
          }
          stdin.resume();

          const timer = runtime.setTimeout(() => {
            cleanup();
            try {
              stream.close();
            } catch {
              // ignore
            }
            reject(new Error(`Authentication timed out after ${Math.floor(commandTimeoutMs / 1000)}s`));
          }, commandTimeoutMs);

          stream.write(formatShellInvocation(command));
          // Reset the output buffer so pattern matching only considers output
          // produced by the command we just wrote, not the shell's MOTD.
          outputBuffer = '';
          patternMatchingEnabled = true;
        });
      });

    try {
      io.log(color.yellow('Starting interactive authentication...'));
      io.log(
        color.dim('Follow the prompts below. The session will close automatically when auth completes.')
      );
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
    // Fallback: system ssh
    const askpassPath = runtime.createAskpassScript(ssh.password);
    try {
      const sshArgs = runtime.buildSystemSshArgs({
        host: ssh.host,
        port: ssh.port,
        username: ssh.user,
        localPort: tunnelPort,
        remotePort: tunnelPort,
      });
      sshArgs.push('-tt');
      sshArgs.push(`${ssh.user}@${ssh.host}`);
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
        const fs = await import('node:fs');
        fs.unlinkSync(askpassPath);
      } catch {
        // ignore
      }
    }
  }

  // Authentication is only considered successful when the interactive session
  // reported a positive pattern match. A shell exit code of 0 is NOT trusted:
  // zsh stays alive after a failed `exec` in interactive mode, and a user
  // closing the session with Ctrl+D produces exit 0 even though nothing was
  // authenticated. Callers currently always supply `successPatterns`.
  return {
    exitCode: execError ? 1 : (execResult?.exitCode ?? null),
    exitSignal: execResult?.exitSignal ?? null,
    authDetected: execError === null && execResult?.authDetected === true,
  };
}
