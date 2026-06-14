import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const NODE_A_FILE = path.join(HERE, 'nodes', 'node-a.ts');
export const NODE_B_FILE = path.join(HERE, 'nodes', 'node-b.ts');

const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'index.js');

/**
 * Locate a built relaycast engine `serve` bin. CI sets RELAYCAST_ENGINE_DIR to
 * a checkout of AgentWorkforce/relaycast (feat/fleet-mailbox or a descendant);
 * locally we fall back to the sibling fleet worktrees.
 */
function resolveEngineServe(): string | null {
  const candidates: string[] = [];
  if (process.env.RELAYCAST_ENGINE_DIR) {
    candidates.push(path.join(process.env.RELAYCAST_ENGINE_DIR, 'packages', 'engine', 'dist', 'bin', 'serve.js'));
  }
  for (const dir of ['fleet-rollout-flag', 'fleet-mailbox']) {
    candidates.push(path.resolve(REPO_ROOT, '..', 'relaycast-worktrees', dir, 'packages', 'engine', 'dist', 'bin', 'serve.js'));
  }
  candidates.push(path.resolve(REPO_ROOT, '..', 'relaycast', 'packages', 'engine', 'dist', 'bin', 'serve.js'));
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
    return { ok: false, reason: 'relaycast engine serve bin not found; set RELAYCAST_ENGINE_DIR to a built checkout' };
  }
  const brokerBinary = resolveBrokerBinary();
  if (!brokerBinary) {
    return { ok: false, reason: 'agent-relay-broker binary not found; set BROKER_BINARY_PATH or build target/release' };
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
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
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

export async function startEngine(serveBin: string, tmpRoot: string): Promise<EngineHandle> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serveBin, '--port', String(port), '--db', path.join(tmpRoot, 'relaycast.db'), '--env', 'test'], {
    env: cleanEnv({ HOME: tmpRoot }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  const fetchJson = async (pathname: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${pathname}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  await waitFor(async () => {
    try {
      const res = await fetch(`${baseUrl}/`);
      return res.status > 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 20_000, label: 'engine ready' });

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
  capabilities: string[],
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
  query: { capability?: string; name?: string } = {},
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
      dashboardPort: number;
    },
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
      [CLI_ENTRY, 'fleet', 'serve', o.nodeFile, '--name', o.name, '--workspace', o.workspaceKey, '--base-url', o.engineBaseUrl],
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
          AGENT_RELAY_DASHBOARD_PORT: String(o.dashboardPort),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child.stdout?.on('data', (d) => { this.lastLog += d.toString(); });
    this.child.stderr?.on('data', (d) => { this.lastLog += d.toString(); });
  }

  get log(): string {
    return this.lastLog;
  }

  /** Kill only the sidecar+broker process (simulates a node host dying). */
  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
      setTimeout(resolve, 2_000);
    });
  }
}

export async function registerAgent(engine: EngineHandle, workspaceKey: string, name: string): Promise<string> {
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
  input: Record<string, unknown>,
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
  invocationId: string,
): Promise<{ status: string; output?: any; dispatched_node_id?: string }> {
  const { body } = await engine.fetchJson(`/v1/actions/${action}/invocations/${invocationId}`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  return body.data ?? {};
}

export async function createTrigger(
  engine: EngineHandle,
  workspaceKey: string,
  trigger: { channel?: string; pattern?: string; mention?: string; action_name: string },
): Promise<string> {
  const { status, body } = await engine.fetchJson('/v1/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify(trigger),
  });
  if (status >= 300) throw new Error(`createTrigger ${status}: ${JSON.stringify(body)}`);
  return body.data.id as string;
}

export async function postMessage(engine: EngineHandle, agentToken: string, channel: string, text: string): Promise<number> {
  const { status } = await engine.fetchJson(`/v1/channels/${channel}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ text }),
  });
  return status;
}

export async function listMessages(engine: EngineHandle, agentToken: string, channel: string): Promise<Array<{ text: string }>> {
  const { body } = await engine.fetchJson(`/v1/channels/${channel}/messages`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  const data = body.data;
  const items = Array.isArray(data) ? data : data?.messages ?? [];
  return items as Array<{ text: string }>;
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
