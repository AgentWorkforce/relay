/**
 * Shared relay-pty spawning utilities.
 *
 * Extracted from HostedRunner to be reused by Connector and any other
 * component that needs to spawn CLI agents via relay-pty.
 *
 * The three main capabilities:
 *   1. Find the relay-pty binary
 *   2. Spawn a relay-pty process wrapping a CLI
 *   3. Connect to the injection socket and send messages
 */

import { createConnection, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Tracked relay-pty worker process. */
export interface PtyWorker {
  name: string;
  cli: string;
  socketPath: string;
  outboxDir: string;
  process: ChildProcess;
  socket?: Socket;
  socketConnected: boolean;
  outboxWatcher?: FSWatcher;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingFiles: Set<string>;
}

export interface SpawnOptions {
  /** Base directory for sockets, outbox, logs */
  baseDir: string;
  /** Working directory for the spawned CLI */
  cwd?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Extra environment variables for the spawned process */
  env?: Record<string, string>;
  /** Run headless (pipe stdio) vs interactive (inherit stdin/stdout) */
  headless?: boolean;
  /** Logger function */
  log?: (msg: string) => void;
}

/**
 * Returns CLI-specific permission bypass flags.
 */
export function getPermissionFlags(cli: string): string[] {
  switch (cli) {
    case 'claude': return ['--dangerously-skip-permissions'];
    case 'codex': return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'gemini': return ['--yolo'];
    default: return [];
  }
}

/**
 * Find the relay-pty binary on disk.
 *
 * Search order:
 *   1. RELAY_PTY_PATH environment variable
 *   2. Common local build paths
 *   3. `which relay-pty` (PATH lookup)
 *   4. @agent-relay/utils resolver
 */
export async function findRelayPtyBinary(): Promise<string | null> {
  if (process.env.RELAY_PTY_PATH && existsSync(process.env.RELAY_PTY_PATH)) {
    return process.env.RELAY_PTY_PATH;
  }

  const candidates = [
    path.join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
    path.join(os.homedir(), '.npm', 'bin', 'relay-pty'),
    path.resolve(import.meta.dirname ?? '.', '..', '..', '..', 'relay-pty', 'target', 'release', 'relay-pty'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  try {
    const { execSync } = await import('node:child_process');
    const result = execSync('which relay-pty', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {}

  try {
    const { findRelayPtyBinary: findBin } = await import('@agent-relay/utils/relay-pty-path');
    return findBin(import.meta.dirname ?? '.');
  } catch {}

  return null;
}

/**
 * Spawn a relay-pty process wrapping a CLI command.
 *
 * Returns a PtyWorker representing the spawned process, or null on failure.
 * After spawning, call `connectToInjectionSocket()` to enable message injection.
 */
export async function spawnRelayPtyProcess(
  name: string,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<PtyWorker | null> {
  const log = options.log ?? (() => {});
  const headless = options.headless ?? true;
  const socketPath = path.join(options.baseDir, 'sockets', `${name}.sock`);
  const outboxDir = path.join(options.baseDir, 'outbox', name);
  const logPath = path.join(options.baseDir, 'logs', `${name}.log`);

  try { unlinkSync(socketPath); } catch {}
  mkdirSync(path.dirname(socketPath), { recursive: true });
  mkdirSync(outboxDir, { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });

  // Canonical outbox symlink at ~/.agent-relay/outbox/<name>
  const canonicalOutbox = path.join(os.homedir(), '.agent-relay', 'outbox', name);
  try {
    mkdirSync(path.dirname(canonicalOutbox), { recursive: true });
    if (canonicalOutbox !== outboxDir) {
      try { unlinkSync(canonicalOutbox); } catch {}
      symlinkSync(outboxDir, canonicalOutbox);
    }
  } catch {}

  const relayPtyBin = await findRelayPtyBinary();
  if (!relayPtyBin) {
    log('relay-pty binary not found');
    return null;
  }

  const ptyArgs = [
    '--name', name,
    '--socket', socketPath,
    '--idle-timeout', '500',
    '--json-output',
    '--rows', '24',
    '--cols', '80',
    '--log-level', options.debug ? 'debug' : 'warn',
    '--log-file', logPath,
    '--outbox', outboxDir,
    '--',
    command,
    ...args,
  ];

  log(`Spawning: ${relayPtyBin} ... -- ${command} ${args.join(' ')}`);

  const { spawn } = await import('node:child_process');
  const proc = spawn(relayPtyBin, ptyArgs, {
    stdio: headless
      ? ['pipe', 'pipe', 'pipe']
      : ['inherit', 'inherit', 'pipe'],
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      AGENT_RELAY_NAME: name,
      RELAY_AGENT_NAME: name,
      AGENT_RELAY_OUTBOX: canonicalOutbox,
      ...options.env,
      TERM: process.env.TERM || 'xterm-256color',
    },
  });

  const worker: PtyWorker = {
    name,
    cli: command,
    socketPath,
    outboxDir,
    process: proc,
    socketConnected: false,
    debounceTimers: new Map(),
    pendingFiles: new Set(),
  };

  return worker;
}

/**
 * Connect to a relay-pty worker's injection socket.
 *
 * Retries up to `maxAttempts` times with increasing delay.
 * Sets `worker.socket` and `worker.socketConnected` on success.
 */
export async function connectToInjectionSocket(
  worker: PtyWorker,
  options?: { maxAttempts?: number; baseDelay?: number; log?: (msg: string) => void; stopped?: () => boolean },
): Promise<void> {
  const MAX = options?.maxAttempts ?? 20;
  const DELAY = options?.baseDelay ?? 300;
  const log = options?.log ?? (() => {});
  const stopped = options?.stopped ?? (() => false);

  async function attempt(n: number): Promise<void> {
    if (n >= MAX) {
      log(`Socket connect failed for ${worker.name} after ${MAX} attempts`);
      return;
    }

    if (!existsSync(worker.socketPath)) {
      await new Promise(r => setTimeout(r, DELAY * Math.min(n + 1, 5)));
      return attempt(n + 1);
    }

    return new Promise<void>((resolve) => {
      const socket = createConnection(worker.socketPath);

      socket.on('connect', () => {
        worker.socket = socket;
        worker.socketConnected = true;
        log(`Injection socket connected: ${worker.name}`);
        resolve();
      });

      socket.on('data', (data) => {
        for (const line of data.toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r.type === 'inject_result') {
              log(`Inject ${r.id?.substring(0, 8)}: ${r.status}`);
            }
          } catch {}
        }
      });

      socket.on('error', () => {
        worker.socketConnected = false;
        worker.socket = undefined;
        if (n < MAX - 1) {
          setTimeout(() => attempt(n + 1).then(resolve), DELAY * Math.min(n + 1, 5));
        } else {
          resolve();
        }
      });

      socket.on('close', () => {
        worker.socketConnected = false;
        worker.socket = undefined;
        if (!stopped() && worker.process.exitCode === null) {
          setTimeout(() => attempt(0).then(() => {}), 1000);
        }
      });
    });
  }

  return attempt(0);
}

/**
 * Inject a message into a relay-pty worker via its injection socket.
 */
export function injectMessage(
  worker: PtyWorker,
  from: string,
  body: string,
  messageId: string,
  log?: (msg: string) => void,
): boolean {
  if (!worker.socket || !worker.socketConnected) {
    log?.(`Cannot inject to ${worker.name}: socket not connected`);
    return false;
  }

  const request = JSON.stringify({
    type: 'inject',
    id: messageId,
    from,
    body,
    priority: 0,
  }) + '\n';

  worker.socket.write(request);
  log?.(`Injected: ${from} → ${worker.name} (${body.length}B)`);
  return true;
}

/**
 * Release a worker: send shutdown command, then SIGTERM/SIGKILL.
 */
export function releaseWorker(worker: PtyWorker, log?: (msg: string) => void): void {
  log?.(`Releasing: ${worker.name}`);

  if (worker.socket && worker.socketConnected) {
    worker.socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  }

  setTimeout(() => {
    if (worker.process.exitCode === null) {
      worker.process.kill('SIGTERM');
      setTimeout(() => {
        if (worker.process.exitCode === null) worker.process.kill('SIGKILL');
      }, 5000);
    }
  }, 10000);
}

/**
 * Clean up a worker's resources (watcher, timers, socket, socket file).
 */
export function cleanupWorker(worker: PtyWorker, workers?: Map<string, PtyWorker>): void {
  worker.outboxWatcher?.close();
  for (const t of worker.debounceTimers.values()) clearTimeout(t);
  worker.socket?.destroy();
  try { unlinkSync(worker.socketPath); } catch {}
  workers?.delete(worker.name);
}
