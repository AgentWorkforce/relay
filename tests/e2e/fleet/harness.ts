import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const NODE_A_FILE = path.join(HERE, 'nodes', 'node-a.ts');
export const NODE_B_FILE = path.join(HERE, 'nodes', 'node-b.ts');

const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'index.js');

/**
 * Locate a built relaycast engine `serve` bin. CI sets RELAYCAST_ENGINE_DIR to a
 * checkout of AgentWorkforce/relaycast pinned to the `feat/fleet-rollout-flag`
 * SHA (relaycast#194) that carries the E2E compat fixes; locally we resolve the
 * same branch from the sibling fleet worktrees (so local == CI).
 */
function resolveEngineServe(): string | null {
  const candidates: string[] = [];
  if (process.env.RELAYCAST_ENGINE_DIR) {
    candidates.push(
      path.join(process.env.RELAYCAST_ENGINE_DIR, 'packages', 'engine', 'dist', 'bin', 'serve.js')
    );
  }
  for (const dir of ['fleet-rollout-flag', 'fleet-mailbox']) {
    candidates.push(
      path.resolve(
        REPO_ROOT,
        '..',
        'relaycast-worktrees',
        dir,
        'packages',
        'engine',
        'dist',
        'bin',
        'serve.js'
      )
    );
  }
  candidates.push(
    path.resolve(REPO_ROOT, '..', 'relaycast', 'packages', 'engine', 'dist', 'bin', 'serve.js')
  );
  return candidates.find((p) => existsSync(p)) ?? null;
}

function resolveBrokerBinary(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    process.env.BROKER_BINARY_PATH,
    process.env.AGENT_RELAY_BIN,
    path.join(REPO_ROOT, 'target', 'release', `agent-relay-broker${ext}`),
    path.join(REPO_ROOT, 'target', 'debug', `agent-relay-broker${ext}`),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface Preflight {
  ok: boolean;
  reason: string;
  engineServe?: string;
  brokerBinary?: string;
}

/** Verify every prerequisite for the live two-node stack is present. */
export function preflight(): Preflight {
  if (!existsSync(CLI_ENTRY)) {
    return { ok: false, reason: `relay CLI not built (${CLI_ENTRY}); run \`npm run build:core\`` };
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
    return {
      ok: false,
      reason: 'agent-relay-broker binary not found; set BROKER_BINARY_PATH or build target/release',
    };
  }
  return { ok: true, reason: 'ok', engineServe, brokerBinary };
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
      last = value;
    } catch (err) {
      last = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`waitFor timed out${opts.label ? ` (${opts.label})` : ''}; last=${JSON.stringify(last)}`);
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A hermetic env for spawned broker/sidecar processes: the ambient agent-relay
 * session env (RELAY_ and AGENT_RELAY_ vars) is stripped so the broker never
 * tries to rejoin the operator's real workspace. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: extra.HOME ?? process.env.HOME,
    LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR,
  };
  return { ...base, ...extra };
}

export interface EngineHandle {
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
  fetchJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }>;
}

export async function startEngine(
  serveBin: string,
  tmpRoot: string,
  extraEnv: Record<string, string> = {}
): Promise<EngineHandle> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [serveBin, '--port', String(port), '--db', path.join(tmpRoot, 'relaycast.db'), '--env', 'test'],
    {
      env: cleanEnv({ HOME: tmpRoot, ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  const fetchJson = async (pathname: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${pathname}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  await waitFor(
    async () => {
      try {
        const res = await fetch(`${baseUrl}/`);
        return res.status > 0;
      } catch {
        return false;
      }
    },
    { timeoutMs: 20_000, label: 'engine ready' }
  );

  return {
    baseUrl,
    port,
    fetchJson,
    async stop() {
      child.kill('SIGKILL');
    },
  };
}

export async function createWorkspace(engine: EngineHandle, name: string): Promise<string> {
  const { status, body } = await engine.fetchJson('/v1/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (status >= 300) throw new Error(`createWorkspace ${status}`);
  return body.data.api_key as string;
}

export async function enableFleet(engine: EngineHandle, workspaceKey: string): Promise<void> {
  const { status } = await engine.fetchJson('/v1/workspace/fleet-nodes', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({ enabled: true }),
  });
  if (status >= 300) throw new Error(`enableFleet ${status}`);
}

export async function enrollNode(
  engine: EngineHandle,
  workspaceKey: string,
  nodeId: string,
  name: string,
  capabilities: string[]
): Promise<string> {
  const { status, body } = await engine.fetchJson('/v1/nodes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({ node_id: nodeId, name, capabilities, max_agents: 8 }),
  });
  if (status >= 300) throw new Error(`enrollNode ${status}: ${JSON.stringify(body)}`);
  return body.data.token as string;
}

export interface NodeRosterEntry {
  id: string;
  name: string;
  capabilities: Array<{ name: string }>;
  status: string;
  live: boolean;
  handlers_live: boolean;
  load: number;
  active_agents: number;
  max_agents: number;
}

export async function getNodes(
  engine: EngineHandle,
  workspaceKey: string,
  query: { capability?: string; name?: string } = {}
): Promise<NodeRosterEntry[]> {
  const qs = new URLSearchParams();
  if (query.capability) qs.set('capability', query.capability);
  if (query.name) qs.set('name', query.name);
  const suffix = qs.toString() ? `?${qs}` : '';
  const { body } = await engine.fetchJson(`/v1/nodes${suffix}`, {
    headers: { authorization: `Bearer ${workspaceKey}` },
  });
  return (body.data ?? []) as NodeRosterEntry[];
}

/** A single `agent-relay fleet serve` process (broker + sidecar), fully
 * isolated under its own project dir + state. */
export class FleetNode {
  child: ChildProcess | null = null;
  readonly projectDir: string;
  readonly logPath: string;
  private lastLog = '';

  constructor(
    private readonly opts: {
      name: string;
      /** The enrolled node id — must equal the broker's machine-id, so we
       * pre-seed the machine-id file below. */
      nodeId: string;
      nodeFile: string;
      nodeToken: string;
      workspaceKey: string;
      engineBaseUrl: string;
      brokerBinary: string;
      tmpRoot: string;
      brokerPort: number;
    }
  ) {
    this.projectDir = path.join(opts.tmpRoot, `node-${opts.name}`);
    mkdirSync(path.join(this.projectDir, '.agentworkforce', 'relay'), { recursive: true });
    this.home = path.join(this.projectDir, 'home');
    mkdirSync(this.home, { recursive: true });
    this.logPath = path.join(this.projectDir, 'serve.log');
    // The broker reads its node id from `<data_local_dir>/agent-relay/machine-id`
    // (macOS: ~/Library/Application Support, Linux: ~/.local/share). Seed both so
    // the broker's `node.register` node_id matches the enrolled token's node id —
    // otherwise the engine rejects the register (node_id_mismatch) and the
    // capability→action binding never happens.
    for (const rel of [
      ['Library', 'Application Support', 'agent-relay', 'machine-id'],
      ['.local', 'share', 'agent-relay', 'machine-id'],
    ]) {
      const file = path.join(this.home, ...rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${opts.nodeId}\n`);
    }
  }

  private readonly home: string;

  start(): void {
    const o = this.opts;
    const stateDir = path.join(this.projectDir, '.agentworkforce', 'relay');
    this.child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'fleet',
        'serve',
        o.nodeFile,
        '--name',
        o.name,
        '--workspace',
        o.workspaceKey,
        '--base-url',
        o.engineBaseUrl,
      ],
      {
        cwd: REPO_ROOT,
        env: cleanEnv({
          HOME: this.home,
          BROKER_BINARY_PATH: o.brokerBinary,
          RELAYCAST_BASE_URL: o.engineBaseUrl,
          RELAY_BASE_URL: o.engineBaseUrl,
          RELAY_NODE_TOKEN: o.nodeToken,
          RELAY_WORKSPACE_KEY: o.workspaceKey,
          RELAY_API_KEY: o.workspaceKey,
          AGENT_RELAY_PROJECT: this.projectDir,
          AGENT_RELAY_STATE_DIR: stateDir,
          AGENT_RELAY_BROKER_PORT: String(o.brokerPort),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    // Persist the sidecar's output to serve.log (append across restarts) so the
    // CI "upload node logs on failure" step has something to attach.
    const record = (d: Buffer) => {
      const s = d.toString();
      this.lastLog += s;
      try {
        appendFileSync(this.logPath, s);
      } catch {
        /* best effort */
      }
    };
    this.child.stdout?.on('data', record);
    this.child.stderr?.on('data', record);
  }

  get log(): string {
    return this.lastLog;
  }

  /** Kill the whole node host: the `fleet serve` sidecar AND the broker it
   * spawned. SIGKILLing only the sidecar orphans the broker (it keeps the node
   * online + holds the state-dir flock), which breaks a later restart. */
  async stop(): Promise<void> {
    // Kill the broker first, by the pid it wrote to connection.json.
    const connPath = path.join(this.projectDir, '.agentworkforce', 'relay', 'connection.json');
    try {
      const conn = JSON.parse(readFileSync(connPath, 'utf-8')) as { pid?: number };
      if (typeof conn.pid === 'number') {
        try {
          process.kill(conn.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no connection file */
    }

    if (this.child) {
      const child = this.child;
      this.child = null;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
        setTimeout(resolve, 2_000);
      });
    }
    // Give the engine a moment to observe the dropped node control WS.
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function registerAgent(
  engine: EngineHandle,
  workspaceKey: string,
  name: string
): Promise<string> {
  const { status, body } = await engine.fetchJson('/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({ name }),
  });
  if (status >= 300) throw new Error(`registerAgent ${status}: ${JSON.stringify(body)}`);
  return (body.data.token ?? body.data.agent_token) as string;
}

export async function invokeAction(
  engine: EngineHandle,
  agentToken: string,
  action: string,
  input: Record<string, unknown>
): Promise<{ status: number; invocationId?: string; body: any }> {
  const { status, body } = await engine.fetchJson(`/v1/actions/${action}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ input }),
  });
  return { status, invocationId: body?.data?.invocation_id, body };
}

export async function getInvocation(
  engine: EngineHandle,
  agentToken: string,
  action: string,
  invocationId: string
): Promise<{ status: string; output?: any; dispatched_node_id?: string }> {
  const { body } = await engine.fetchJson(`/v1/actions/${action}/invocations/${invocationId}`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  return body.data ?? {};
}

export async function createTrigger(
  engine: EngineHandle,
  workspaceKey: string,
  trigger: { channel?: string; pattern?: string; mention?: string; action_name: string }
): Promise<string> {
  const { status, body } = await engine.fetchJson('/v1/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify(trigger),
  });
  if (status >= 300) throw new Error(`createTrigger ${status}: ${JSON.stringify(body)}`);
  return body.data.id as string;
}

export async function joinChannel(
  engine: EngineHandle,
  agentToken: string,
  channel: string
): Promise<number> {
  const { status } = await engine.fetchJson(`/v1/channels/${channel}/join`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentToken}` },
  });
  return status;
}

export async function postMessage(
  engine: EngineHandle,
  agentToken: string,
  channel: string,
  text: string
): Promise<number> {
  const { status } = await engine.fetchJson(`/v1/channels/${channel}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ text }),
  });
  return status;
}

export async function listMessages(
  engine: EngineHandle,
  agentToken: string,
  channel: string
): Promise<Array<{ text: string }>> {
  const { body } = await engine.fetchJson(`/v1/channels/${channel}/messages`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  const data = body.data;
  const items = Array.isArray(data) ? data : (data?.messages ?? []);
  return items as Array<{ text: string }>;
}

/** Release (delete) an agent, freeing its location — used to model a resumable
 * agent being released before a resume re-spawn. */
export async function releaseAgent(
  engine: EngineHandle,
  workspaceKey: string,
  name: string
): Promise<number> {
  const { status } = await engine.fetchJson(`/v1/agents/${name}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${workspaceKey}` },
  });
  return status;
}

export async function sendDm(
  engine: EngineHandle,
  agentToken: string,
  to: string,
  text: string
): Promise<{ status: number; body: any }> {
  return engine.fetchJson('/v1/dm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ to, text }),
  });
}

/** List an agent's own deliveries. Reading triggers the engine's TTL sweep, so
 * polling this is how the mailbox TTL dead-letter becomes observable. */
export async function listDeliveries(
  engine: EngineHandle,
  agentToken: string,
  status?: string
): Promise<Array<{ id: string; status: string; seq: number; msg_id: string }>> {
  const qs = status ? `?status=${status}` : '';
  const { body } = await engine.fetchJson(`/v1/deliveries${qs}`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  const data = body.data;
  return (Array.isArray(data) ? data : (data?.deliveries ?? [])) as Array<{
    id: string;
    status: string;
    seq: number;
    msg_id: string;
  }>;
}

/** A live agent WS connection that records the typed events it receives — the
 * only way a sender observes the realtime `delivery.failed` notification. */
export class AgentEventListener {
  private readonly ws: WebSocket;
  readonly events: Array<Record<string, unknown>> = [];
  constructor(wsBaseUrl: string, agentToken: string) {
    this.ws = new WebSocket(`${wsBaseUrl}/v1/ws`, { headers: { authorization: `Bearer ${agentToken}` } });
    this.ws.on('message', (data) => {
      try {
        this.events.push(JSON.parse(data.toString()));
      } catch {
        /* ignore non-JSON frames */
      }
    });
    this.ws.on('error', () => {});
  }
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.type === type);
  }
  /** Strictly-increasing per-agent sequence numbers across all received events. */
  seqs(): number[] {
    return this.events.map((e) => e.agent_seq).filter((s): s is number => typeof s === 'number');
  }
  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }
  /** Ask the engine to replay everything after `lastSeenSeq` (the resync cursor
   * the node-restart reconcile relies on for exactly-once redelivery). */
  resync(lastSeenSeq: number): void {
    this.send({ type: 'resync', last_seen_seq: lastSeenSeq });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export function makeTmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'fleet-e2e-'));
}

export function cleanupTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
