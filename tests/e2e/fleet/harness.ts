import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
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
import { AgentClient, HttpClient } from '@relaycast/sdk';
import WebSocket from 'ws';

// Node <22 lacks a global WebSocket, which @relaycast/sdk's in-process
// AgentClient requires. The spawned CLI installs its own via runCli; this
// covers the test runner's own client on Node 20/21.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const NODE_A_FILE = path.join(HERE, 'nodes', 'node-a.ts');
export const NODE_B_FILE = path.join(HERE, 'nodes', 'node-b.ts');
export const CLOUD_ENROLLED_NODE_FILE = path.join(HERE, 'nodes', 'cloud-enrolled.ts');

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
    const srv = createNetServer();
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

/**
 * Mint an observer token for the workspace event stream. `stream:read` authorizes
 * the `/v1/ws` upgrade; per-event scopes (e.g. `deliveries:read`) gate which events
 * the socket receives. The node-provider engine no longer streams agent events over
 * an agent-token WS, so workspace observation goes through an observer token.
 */
export async function mintObserverToken(
  engine: EngineHandle,
  workspaceKey: string,
  scopes: string[]
): Promise<string> {
  const { status, body } = await engine.fetchJson('/v1/observer-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({ name: `obs-${Math.random().toString(36).slice(2, 10)}`, scopes }),
  });
  if (status >= 300) throw new Error(`mintObserverToken ${status}: ${JSON.stringify(body)}`);
  return body.data.token as string;
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

export interface CloudEnrollmentEndpoint {
  url: string;
  stop(): Promise<void>;
}

/**
 * Serve one Cloud enrollment exchange locally. The exchange itself is a small
 * stand-in for Cloud's control-plane endpoint; the returned node token was
 * minted by the real relaycast engine, so the subsequent broker registration
 * still exercises the real token-to-node binding and fails on node_id_mismatch.
 */
export async function startCloudEnrollmentEndpoint(input: {
  enrollmentToken: string;
  nodeId: string;
  nodeName: string;
  nodeToken: string;
  relayWorkspaceId: string;
  relaycastUrl: string;
}): Promise<CloudEnrollmentEndpoint> {
  const server = createHttpServer((request, response) => {
    let raw = '';
    request.setEncoding('utf-8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let token = '';
      try {
        token = String((JSON.parse(raw) as { enrollmentToken?: unknown }).enrollmentToken ?? '');
      } catch {
        // The 400 response below covers malformed JSON as an invalid exchange.
      }
      if (request.method !== 'POST' || token !== input.enrollmentToken) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid enrollment token' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          nodeId: input.nodeId,
          nodeName: input.nodeName,
          nodeToken: input.nodeToken,
          relayWorkspaceId: input.relayWorkspaceId,
          relaycastUrl: input.relaycastUrl,
          websocketUrl: `${input.relaycastUrl}/v1/node/ws`,
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('cloud enrollment endpoint did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/api/v1/fleet/register`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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
  tags?: string[];
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

/** A single `agent-relay node up` process (broker + sidecar), fully
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
      /** Pins the broker's `spawn:<harness>` capacity set (AGENT_RELAY_NODE_HARNESSES)
       * so two nodes on one host advertise distinct capabilities. */
      capacityHarnesses?: string;
      /** Exercise `cloud enroll` persistence + automatic `node up` pickup rather
       * than injecting the node token and pre-seeding the broker machine id. */
      usePersistedEnrollment?: boolean;
    }
  ) {
    this.projectDir = path.join(opts.tmpRoot, `node-${opts.name}`);
    mkdirSync(path.join(this.projectDir, '.agentworkforce', 'relay'), { recursive: true });
    this.home = path.join(this.projectDir, 'home');
    mkdirSync(this.home, { recursive: true });
    this.logPath = path.join(this.projectDir, 'serve.log');
    if (!opts.usePersistedEnrollment) {
      // Direct-token fixtures predate the Cloud enrollment store. Keep their
      // explicit machine-id setup so those scenarios remain focused on their
      // existing fleet behavior; the persisted-enrollment regression below
      // intentionally takes the unseeded path that failed in production.
      for (const rel of [
        ['Library', 'Application Support', 'agent-relay', 'machine-id'],
        ['.local', 'share', 'agent-relay', 'machine-id'],
      ]) {
        const file = path.join(this.home, ...rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${opts.nodeId}\n`);
      }
    }
  }

  private readonly home: string;

  /** Redeem through the real CLI so the production enrollment store writer and
   * subsequent `node up` resolver are both part of the regression boundary. */
  async cloudEnroll(enrollmentUrl: string, enrollmentToken: string): Promise<void> {
    if (!this.opts.usePersistedEnrollment) {
      throw new Error('cloudEnroll requires usePersistedEnrollment');
    }
    const child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'cloud',
        'enroll',
        '--token',
        enrollmentToken,
        '--enrollment-url',
        enrollmentUrl,
        '--name',
        this.opts.name,
      ],
      {
        cwd: REPO_ROOT,
        env: cleanEnv({ HOME: this.home, AGENT_RELAY_HOME: this.enrollmentHome }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (exitCode !== 0) {
      throw new Error(`cloud enroll exited ${exitCode}: ${output}`);
    }
    if (!output.includes(`Enrolled node "${this.opts.name}"`)) {
      throw new Error(`cloud enroll did not report success: ${output}`);
    }
  }

  private get enrollmentHome(): string {
    return path.join(this.home, '.agentworkforce', 'relay');
  }

  start(): void {
    const o = this.opts;
    const stateDir = path.join(this.projectDir, '.agentworkforce', 'relay');
    this.child = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        'node',
        'up',
        '--config',
        o.nodeFile,
        // `fleet serve --name` → `node up --broker-name` (the served node's name).
        '--broker-name',
        o.name,
        // `fleet serve --workspace` → `node up --workspace-key`.
        '--workspace-key',
        o.workspaceKey,
        // `node up` has no `--base-url`; the engine URL is carried by the
        // RELAY_BASE_URL / RELAYCAST_BASE_URL env vars set below (as it was for
        // `fleet serve --base-url`). Serve only — never auto-spawn teams.json
        // agents (there are none in this hermetic project dir).
        '--no-spawn',
      ],
      {
        cwd: REPO_ROOT,
        env: cleanEnv({
          HOME: this.home,
          BROKER_BINARY_PATH: o.brokerBinary,
          RELAYCAST_BASE_URL: o.engineBaseUrl,
          RELAY_BASE_URL: o.engineBaseUrl,
          ...(o.usePersistedEnrollment
            ? {
                AGENT_RELAY_HOME: this.enrollmentHome,
                // Supply the broker-self workspace membership without using
                // RELAY_WORKSPACE_KEY, which is intentionally an explicit
                // direct-workspace choice that disables enrollment pickup.
                RELAY_WORKSPACES_JSON: JSON.stringify([
                  { workspace_id: 'fleet-e2e', api_key: o.workspaceKey },
                ]),
              }
            : {
                RELAY_NODE_TOKEN: o.nodeToken,
                RELAY_WORKSPACE_KEY: o.workspaceKey,
                RELAY_API_KEY: o.workspaceKey,
              }),
          AGENT_RELAY_PROJECT: this.projectDir,
          AGENT_RELAY_STATE_DIR: stateDir,
          AGENT_RELAY_BROKER_PORT: String(o.brokerPort),
          ...(o.capacityHarnesses ? { AGENT_RELAY_NODE_HARNESSES: o.capacityHarnesses } : {}),
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

  /** Kill the whole node host: the `node up` sidecar AND the broker it
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

/** Invoke a node-scoped provider action on its owning node. Fleet-provider actions
 * materialize node-scoped (not workspace-global), so they are addressed by node. */
export async function invokeNodeAction(
  engine: EngineHandle,
  agentToken: string,
  nodeName: string,
  action: string,
  input: Record<string, unknown>
): Promise<{ status: number; invocationId?: string; body: any }> {
  const { status, body } = await engine.fetchJson(`/v1/nodes/${nodeName}/actions/${action}/invoke`, {
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

/** A workspace observer stream (`/v1/ws`, observer token) that records the typed
 * events it receives — how a workspace-level watcher observes realtime events such
 * as `delivery.failed`. Authenticate the token with the scopes the events require
 * (see {@link mintObserverToken}). */
export class ObserverStream {
  private readonly ws: WebSocket;
  readonly events: Array<Record<string, unknown>> = [];
  constructor(wsBaseUrl: string, observerToken: string) {
    this.ws = new WebSocket(`${wsBaseUrl}/v1/ws`, {
      headers: { authorization: `Bearer ${observerToken}` },
    });
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
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * A recipient agent driven through the public `@relaycast/sdk` {@link AgentClient} —
 * the node-provider engine delivers agent events over the node transport (the agent
 * mints a direct node token itself), so a real consumer observes its DMs this way
 * rather than over a raw agent WS. Reconnecting creates a fresh underlying client so
 * the per-agent delivery queue redelivers anything sent while it was offline.
 */
export class AgentStream {
  private client: AgentClient | null = null;
  private connected = false;
  readonly received: Array<{ text: string; conversationId: string }> = [];

  constructor(
    private readonly baseUrl: string,
    private readonly agentToken: string
  ) {}

  async connect(): Promise<void> {
    this.connected = false;
    const client = new AgentClient(new HttpClient({ baseUrl: this.baseUrl, apiKey: this.agentToken }), {
      ws: { reconnectJitter: false },
    });
    // The SDK attaches event handlers to the live socket, so connect() first.
    client.connect();
    client.on.connected(() => {
      this.connected = true;
    });
    client.on.dmReceived((event) => {
      this.received.push({ text: event.message.text, conversationId: event.conversationId });
    });
    this.client = client;
    await waitFor(async () => this.connected, {
      timeoutMs: 15_000,
      label: 'agent stream connected',
    });
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect();
    this.client = null;
  }

  /** Text of every DM received across all (re)connections, in arrival order. */
  texts(): string[] {
    return this.received.map((entry) => entry.text);
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
