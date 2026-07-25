/**
 * Boot helpers for the three-PTY tic-tac-toe E2E.
 *
 * Unlike the unit suites (fake WebSocket, injected stdout), this drives the
 * attach clients through a **real PTY**. That matters: `view`, `drive`, and
 * `passthrough` all gate behaviour on `stdout.isTTY` — the status line is only
 * painted on a TTY, and the whole class of bug this suite guards (a status line
 * wider than the pane wrapping, scrolling the screen, and stacking into the
 * agent's output) is invisible through a pipe.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const PTY_RUN = path.join(HERE, 'pty-run.py');
export const RELAY_CLI = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'index.js');

/** Locate a built relaycast engine `serve` bin (same lookup as the fleet E2E). */
export function resolveEngineServe(): string | null {
  const candidates = [
    process.env.RELAYCAST_ENGINE_DIR
      ? path.join(process.env.RELAYCAST_ENGINE_DIR, 'packages', 'engine', 'dist', 'bin', 'serve.js')
      : null,
    path.resolve(REPO_ROOT, '..', 'relaycast', 'packages', 'engine', 'dist', 'bin', 'serve.js'),
  ].filter((p): p is string => p !== null);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function resolveBrokerBinary(): string | null {
  const candidates = [
    process.env.BROKER_BINARY_PATH ?? null,
    path.join(REPO_ROOT, 'target', 'release', 'agent-relay-broker'),
  ].filter((p): p is string => p !== null);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface Preflight {
  ok: boolean;
  reason: string;
  engineServe?: string;
  brokerBinary?: string;
}

/**
 * Check the prerequisites. Like the fleet E2E, the suite **skips cleanly**
 * rather than failing when a local relaycast engine or broker binary is
 * missing — the default `npm test` must not require them.
 */
export function preflight(): Preflight {
  if (!existsSync(RELAY_CLI)) {
    return { ok: false, reason: 'relay CLI not built; run `npm run build:core`' };
  }
  if (!hasPython3()) {
    return { ok: false, reason: 'python3 not found; it allocates the PTYs this suite drives' };
  }
  const engineServe = resolveEngineServe();
  if (!engineServe) {
    return {
      ok: false,
      reason: 'relaycast engine serve bin not found; set RELAYCAST_ENGINE_DIR to a built checkout',
    };
  }
  const brokerBinary = resolveBrokerBinary();
  if (!brokerBinary) {
    return { ok: false, reason: 'broker binary not found; run `cargo build --release`' };
  }
  return { ok: true, reason: 'ok', engineServe, brokerBinary };
}

function hasPython3(): boolean {
  const probe = spawnSyncQuiet('python3', ['-c', 'import pty']);
  return probe === 0;
}

function spawnSyncQuiet(cmd: string, args: string[]): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- sync probe only
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const res = spawnSync(cmd, args, { stdio: 'ignore' });
  return res.status ?? 1;
}

/**
 * Strip ambient `RELAY_*` / `AGENT_RELAY_*` config so a developer's real
 * workspace is never joined by a test broker, and point the broker at the
 * local engine.
 */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RELAY_') || key.startsWith('AGENT_RELAY_') || key.startsWith('RELAYCAST_')) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...extra };
}

export async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(
  check: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; label: string; intervalMs?: number }
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.label}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
}

export interface EngineHandle {
  baseUrl: string;
  stop(): void;
}

export async function startEngine(serveBin: string, tmpRoot: string): Promise<EngineHandle> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [serveBin, '--port', String(port), '--db', path.join(tmpRoot, 'relaycast.db'), '--env', 'test'],
    { env: cleanEnv({ HOME: tmpRoot }), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  await waitFor(
    async () => {
      try {
        return (await fetch(`${baseUrl}/`)).status > 0;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000, label: 'relaycast engine ready' }
  );

  return {
    baseUrl,
    stop() {
      child.kill('SIGKILL');
    },
  };
}

export interface BrokerHandle {
  url: string;
  apiKey: string;
  /** POST /api/send — publish a relay message as `from` to `to`. */
  send(to: string, from: string, text: string): Promise<Response>;
  /** GET the agent's rendered screen. */
  snapshot(name: string): Promise<{ screen?: string; rows?: number; cols?: number }>;
  spawnAgent(name: string, task: string): Promise<void>;
  stop(): void;
}

/**
 * Start a broker in `projectDir` pointed at the local engine.
 *
 * NOTE: each run needs a **fresh** engine DB. The broker enrolls its node under
 * the project directory name, and re-enrolling an already-known name fails with
 * `node_name_conflict` — after which the engine has no delivery-ready provider
 * for the node and defers every message ("provider not delivery-ready"), which
 * looks exactly like relay messaging being silently broken.
 */
export async function startBroker(
  projectDir: string,
  engineBaseUrl: string,
  home: string
): Promise<BrokerHandle> {
  const env = cleanEnv({
    HOME: home,
    RELAYCAST_BASE_URL: engineBaseUrl,
    BROKER_BINARY_PATH: resolveBrokerBinary() ?? '',
    // Point spawned agents at the freshly built MCP server rather than
    // `npx -y agent-relay mcp`, which would fetch the published package.
    AGENT_RELAY_MCP_COMMAND: `node ${path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'agent-relay-mcp.js')}`,
  });

  await runCli(['node', 'up', '--background'], projectDir, env);

  const connectionPath = path.join(projectDir, '.agentworkforce', 'relay', 'connection.json');
  await waitFor(() => existsSync(connectionPath), {
    timeoutMs: 30_000,
    label: 'broker connection.json',
  });
  const connection = JSON.parse(readFileSync(connectionPath, 'utf-8')) as {
    url: string;
    api_key: string;
  };

  const headers = { 'X-API-Key': connection.api_key, 'Content-Type': 'application/json' };

  return {
    url: connection.url,
    apiKey: connection.api_key,
    send: (to, from, text) =>
      fetch(`${connection.url}/api/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to, from, text }),
      }),
    async snapshot(name) {
      const res = await fetch(`${connection.url}/api/spawned/${encodeURIComponent(name)}/snapshot`, {
        headers: { 'X-API-Key': connection.api_key },
      });
      return (await res.json()) as { screen?: string; rows?: number; cols?: number };
    },
    async spawnAgent(name, task) {
      await runCli(['node', 'agent', 'spawn', 'claude', `--name=${name}`, '--task', task], projectDir, env);
    },
    stop() {
      try {
        spawn(process.execPath, [RELAY_CLI, 'node', 'down', '--force'], {
          cwd: projectDir,
          env,
          stdio: 'ignore',
        }).unref();
      } catch {
        // best effort
      }
    },
  };
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY_CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`relay ${args.join(' ')} exited ${code}: ${out}`))
    );
  });
}

/** An attach client running inside a real PTY, capturing raw bytes. */
export interface PtyClient {
  capturePath: string;
  size(): number;
  /** Raw captured bytes, exactly as the terminal received them. */
  read(): Buffer;
  /** Send keystrokes to the client (e.g. `\x03` to detach). */
  type(data: string): void;
  stop(): void;
  readonly child: ChildProcess;
}

/** Attach to `name` in `mode` inside a real PTY of the given size. */
export function attachInPty(opts: {
  name: string;
  mode: 'view' | 'drive' | 'passthrough';
  cols: number;
  rows: number;
  capturePath: string;
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): PtyClient {
  const child = spawn(
    'python3',
    [
      PTY_RUN,
      '--out',
      opts.capturePath,
      '--cols',
      String(opts.cols),
      '--rows',
      String(opts.rows),
      '--',
      process.execPath,
      RELAY_CLI,
      'node',
      'agent',
      'attach',
      opts.name,
      '--mode',
      opts.mode,
    ],
    { cwd: opts.projectDir, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  return {
    capturePath: opts.capturePath,
    child,
    size: () => (existsSync(opts.capturePath) ? statSync(opts.capturePath).size : 0),
    read: () => (existsSync(opts.capturePath) ? readFileSync(opts.capturePath) : Buffer.alloc(0)),
    type: (data) => child.stdin?.write(data),
    stop: () => child.kill('SIGKILL'),
  };
}

/**
 * Replay a raw capture through a headless terminal emulator and return the
 * visible screen, one string per row.
 *
 * Byte-level assertions cannot tell "the status line was painted once" from
 * "it was painted six times and scrolled the agent's output away" — both are
 * the same bytes on the wire. Only an emulator sees what the human sees.
 */
export async function renderScreen(
  capture: Buffer,
  cols: number,
  rows: number
): Promise<string[]> {
  const { Terminal } = await import('@xterm/headless');
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(new Uint8Array(capture), resolve));
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    out.push((buf.getLine(y)?.translateToString(true) ?? '').trimEnd());
  }
  return out;
}

/**
 * Replay a capture and return everything the pane ever showed — scrollback
 * included — as one string.
 *
 * Content assertions must run on this, never on the raw capture. A TUI paints
 * with absolute cursor addressing, so a phrase the human plainly reads
 * ("Relay message from PlayerA") is generally *not* a contiguous byte run in
 * the stream: it arrives interleaved with positioning and colour sequences.
 * Only after an emulator lays it back out on a grid does it become searchable
 * text.
 */
export async function renderTranscript(
  capture: Buffer,
  cols: number,
  rows: number,
  scrollback = 20_000
): Promise<string> {
  const { Terminal } = await import('@xterm/headless');
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(new Uint8Array(capture), resolve));
  const lines: string[] = [];
  // Both buffers matter: a full-screen TUI lives in the alternate buffer while
  // the pre-alt-screen output (and anything printed after it exits) is in the
  // normal one.
  for (const buf of [term.buffer.normal, term.buffer.active]) {
    for (let y = 0; y < buf.length; y += 1) {
      lines.push(buf.getLine(y)?.translateToString(true).trimEnd() ?? '');
    }
  }
  return lines.join('\n');
}
