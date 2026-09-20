/**
 * An agent session that relay did not launch.
 *
 * `docs/native-delivery-migration.md` ("The gate that does not exist yet")
 * asks for a scenario that starts a session OUTSIDE the broker and proves a
 * relay message reaches it unprompted. Everything relay can address today it
 * first spawned: a `WorkerHandle` owns a `Child` and a stdin writer
 * (`crates/broker/src/worker.rs`), and `queue_inbound_for_delivery_mode`
 * refuses any target `workers.has_worker` does not know
 * (`crates/broker/src/runtime/delivery.rs`). So the session has to be started
 * here, by the test, and handed to relay as an endpoint rather than a process.
 *
 * The host is an `opencode serve` — a headless agent server with an HTTP API.
 * It is started with its own XDG directories and `--pure`, so nothing it does
 * touches the operator's opencode config. `claude` and `codex` are deliberately
 * NOT used: launching either in an untrusted directory, or answering its
 * first-run prompt, writes the user's config (the doc's testing-hazard
 * section), and neither has a delivery route until phases 1 and 2 anyway.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Where the CLI is expected to live when it is not on PATH. */
const OPENCODE_FALLBACK = path.join(process.env.HOME ?? '', '.opencode', 'bin', 'opencode');

export interface UnlaunchedSession {
  /** HTTP base URL relay is given as the app-server endpoint. */
  endpoint: string;
  /** Session id created through the host's own API, before relay knew of it. */
  sessionId: string;
  /** PID of the host process. Its parent is this test, never the broker. */
  pid: number;
  /** Root of the isolated config/data tree; removed on stop. */
  configRoot: string;
  stop(): Promise<void>;
}

/** One text part of one message in a host session. */
export interface SessionTextPart {
  role: string;
  text: string;
}

export function resolveOpencodeBinary(): string | null {
  const configured = process.env.RELAY_UNLAUNCHED_OPENCODE_BIN?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  if (existsSync(OPENCODE_FALLBACK)) return OPENCODE_FALLBACK;
  return null;
}

/**
 * Start the host and create one session in it.
 *
 * Resolves only once the server has printed its listening URL, so the caller
 * never races the port. The port is read from that line rather than chosen in
 * advance: picking a free port and hoping it is still free when the server
 * binds is the classic flake in this repo's e2e suites.
 */
export async function startUnlaunchedSession(options: {
  binary: string;
  title: string;
  startupTimeoutMs?: number;
}): Promise<UnlaunchedSession> {
  const configRoot = mkdtempSync(path.join(tmpdir(), 'relay-unlaunched-'));
  const workdir = path.join(configRoot, 'work');
  mkdirSync(workdir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(configRoot, 'config'),
    XDG_DATA_HOME: path.join(configRoot, 'data'),
    XDG_STATE_HOME: path.join(configRoot, 'state'),
    XDG_CACHE_HOME: path.join(configRoot, 'cache'),
  };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    mkdirSync(env[key] as string, { recursive: true });
  }

  const child = spawn(options.binary, ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const cleanup = async () => {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(configRoot, { recursive: true, force: true });
  };

  let endpoint: string;
  try {
    endpoint = await readListeningUrl(child, options.startupTimeoutMs ?? 30_000);
  } catch (error) {
    await cleanup();
    throw error;
  }

  let sessionId: string;
  try {
    const created = await requestJson(`${endpoint}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: options.title }),
    });
    sessionId = String((created as { id?: unknown }).id ?? '');
    if (!sessionId) throw new Error(`host did not return a session id: ${JSON.stringify(created)}`);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    endpoint,
    sessionId,
    pid: child.pid as number,
    configRoot,
    stop: cleanup,
  };
}

/** Every text part of every message in the session, oldest first. */
export async function readSessionTextParts(
  session: UnlaunchedSession
): Promise<SessionTextPart[]> {
  const messages = (await requestJson(
    `${session.endpoint}/session/${encodeURIComponent(session.sessionId)}/message`
  )) as Array<{ info?: { role?: unknown }; parts?: Array<{ type?: unknown; text?: unknown }> }>;
  const parts: SessionTextPart[] = [];
  for (const message of messages ?? []) {
    const role = String(message.info?.role ?? '');
    for (const part of message.parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push({ role, text: part.text });
      }
    }
  }
  return parts;
}

/** Read a process's parent pid. Used to prove relay did not launch the host. */
export function parentPidOf(pid: number): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parsed = Number.parseInt(out.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

function readListeningUrl(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffered = '';
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(url as string);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = buffered.match(/listening on\s+(https?:\/\/\S+)/i);
      if (match) finish(null, match[1].replace(/\/+$/, ''));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `unlaunched session host exited before listening (code=${code} signal=${signal}): ${buffered.slice(-2_000)}`
        )
      );
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `unlaunched session host did not report a listening URL within ${timeoutMs}ms: ${buffered.slice(-2_000)}`
        )
      );
    }, timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}
