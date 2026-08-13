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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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

/** The only origins a locally-started broker can legitimately be reached on. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;

/**
 * Parse a broker URL and rebuild it from a fixed host literal and an integer
 * port, rejecting anything that is not plain HTTP to loopback.
 *
 * The harness only ever talks to a broker it just started on this machine, so
 * a non-loopback origin means the state on disk is stale or wrong — failing
 * loudly beats silently firing test traffic (with an API key attached) at
 * whatever host the file happens to name.
 *
 * The returned string is assembled from a literal drawn from
 * {@link LOOPBACK_HOSTS} and a range-checked integer, never from the file's own
 * characters. That is what makes the result genuinely untainted rather than
 * merely inspected.
 */
export function requireLoopbackUrl(raw: unknown, source: string): string {
  const fail = (why: string): never => {
    throw new Error(`${source}: refusing to use broker url — ${why}`);
  };

  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return fail(`not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:') return fail(`expected http:, got ${url.protocol}`);

  const host = LOOPBACK_HOSTS.find((candidate) => candidate === url.hostname);
  if (!host) return fail(`expected a loopback host, got ${url.hostname}`);

  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail(`expected a port in 1-65535, got ${JSON.stringify(url.port)}`);
  }
  return `http://${host}:${port}`;
}

export interface BrokerHandle {
  url: string;
  apiKey: string;
  /** POST /api/send — publish a relay message as `from` to `to`. */
  send(to: string, from: string, text: string): Promise<Response>;
  /** GET the agent's rendered screen. */
  snapshot(name: string): Promise<{ screen?: string; rows?: number; cols?: number }>;
  spawnAgent(name: string, task: string): Promise<void>;
  /** Await this before deleting the project dir — see the implementation. */
  stop(): Promise<void>;
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
    // Point spawned agents at the freshly built MCP server rather than the
    // installed Relay binary, which would execute code outside this checkout.
    AGENT_RELAY_MCP_COMMAND: `node ${path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'agent-relay-mcp.js')}`,
  });

  await runCli(['node', 'up', '--background'], projectDir, env);

  const connectionPath = path.join(projectDir, '.agentworkforce', 'relay', 'connection.json');
  await waitFor(() => existsSync(connectionPath), {
    timeoutMs: 30_000,
    label: 'broker connection.json',
  });
  const parsed = JSON.parse(readFileSync(connectionPath, 'utf-8')) as {
    url: string;
    api_key: string;
  };
  // Normalize before anything is fetched. `connection.json` is on-disk state,
  // so its `url` is untrusted input to every request below; pinning it to a
  // loopback origin means a stale or tampered file can only ever point the
  // harness at a local broker, never at an arbitrary host.
  const brokerUrl = requireLoopbackUrl(parsed.url, connectionPath);
  const apiKey = String(parsed.api_key ?? '');

  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  return {
    url: brokerUrl,
    apiKey,
    send: (to, from, text) =>
      fetch(`${brokerUrl}/api/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to, from, text }),
      }),
    async snapshot(name) {
      const res = await fetch(`${brokerUrl}/api/spawned/${encodeURIComponent(name)}/snapshot`, {
        headers: { 'X-API-Key': apiKey },
      });
      return (await res.json()) as { screen?: string; rows?: number; cols?: number };
    },
    async spawnAgent(name, task) {
      await runCli(['node', 'agent', 'spawn', 'claude', `--name=${name}`, '--task', task], projectDir, env);
    },
    // Must be awaited before the caller deletes `projectDir`: `node down`
    // identifies the daemon from `.agentworkforce/relay/connection.json`, so a
    // teardown that removes the tree first leaves the broker — and every Claude
    // worker under it — running past the end of the suite.
    async stop() {
      try {
        await runCli(['node', 'down', '--force'], projectDir, env);
      } catch {
        // Best effort: a broker that already died fails this, which is fine.
      }
    },
  };
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY_CLI, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
export async function renderScreen(capture: Buffer, cols: number, rows: number): Promise<string[]> {
  const { Terminal } = await import('@xterm/headless');
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(new Uint8Array(capture), resolve));
  return readScreen(term, rows);
}

/** The slice of `@xterm/headless`'s Terminal that {@link readScreen} needs. */
interface ReadableTerminal {
  buffer: { active: { getLine(y: number): { translateToString(trim: boolean): string } | undefined } };
}

/**
 * Read a headless terminal's visible grid as one trimmed string per row.
 *
 * Shared so the capture-replay path and the synthetic status-line path cannot
 * drift in how they read a screen.
 */
export function readScreen(term: ReadableTerminal, rows: number): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    out.push((buf.getLine(y)?.translateToString(true) ?? '').trimEnd());
  }
  return out;
}

/** One relay message the broker actually delivered. */
export interface RelayMessage {
  from: string;
  target: string;
  body: string;
}

export interface EventRecorder {
  /** Every delivered chat message, in arrival order. */
  messages(): RelayMessage[];
  /** Frame counts by `kind` — `worker_stream` here is live PTY output. */
  kinds(): Record<string, number>;
  stop(): void;
}

/**
 * Record the broker's event stream for the life of a scenario.
 *
 * Assertions about *protocol* traffic belong here, not on a rendered pane. Two
 * reasons a terminal replay cannot answer "did this message ever arrive?":
 * a TUI paints with absolute cursor addressing, so a phrase the human plainly
 * reads is not a contiguous byte run in the stream; and a full-screen harness
 * lives in the alternate screen buffer, which keeps no scrollback — once it
 * repaints, the earlier message is genuinely gone from the grid.
 *
 * The panes are still the right place to assert how things *look*; this is the
 * right place to assert what was *delivered*.
 */
export async function recordEvents(brokerUrl: string, apiKey: string): Promise<EventRecorder> {
  const { default: WebSocket } = await import('ws');
  // Re-validate: `recordEvents` is exported, so it must not assume its caller
  // already pinned the origin to loopback. The result is rebuilt from a host
  // literal and an integer port, so swapping the scheme keeps it untainted.
  const origin = requireLoopbackUrl(brokerUrl, 'recordEvents').replace('http://', 'ws://');
  const socket = new WebSocket(`${origin}/ws`, { headers: { 'X-API-Key': apiKey } });

  const messages: RelayMessage[] = [];
  // A Map, not an object: `kind` is an arbitrary string off the wire, and
  // `kinds[kind] = …` on a plain object lets a frame with `"kind":"__proto__"`
  // reach `Object.prototype`.
  const kinds = new Map<string, number>();

  socket.on('message', (data: Buffer) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = typeof frame.kind === 'string' ? frame.kind : '(unknown)';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (kind === 'relay_inbound') {
      messages.push({
        from: String(frame.from ?? ''),
        target: String(frame.target ?? ''),
        body: String(frame.body ?? ''),
      });
    }
  });
  socket.on('error', () => {});

  await new Promise<void>((resolve, reject) => {
    // A broker that accepts the TCP connection and then closes (an auth
    // rejection arrives that way) would otherwise never settle this promise,
    // hanging `beforeAll` until the hook timeout with no useful diagnostic.
    const onClose = (code: number) =>
      reject(new Error(`broker closed the event socket before it opened (code ${code})`));
    socket.once('close', onClose);
    socket.once('error', reject);
    socket.once('open', () => {
      socket.off('close', onClose);
      resolve();
    });
  });

  return {
    messages: () => [...messages],
    // `fromEntries` defines own properties, so a `__proto__` kind stays inert.
    kinds: () => Object.fromEntries(kinds),
    stop: () => socket.close(),
  };
}
