import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import WebSocket, { type RawData } from 'ws';

import type { AgentRelayAgent } from '@agent-relay/sdk';
import { formatBrokerNotFoundError, getBrokerBinaryPath } from '@agent-relay/harness-driver/broker-path';

const DEFAULT_BASE_URL = 'https://cast.agentrelay.com';
const HEARTBEAT_INTERVAL_MS = 15_000;
const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;
const SAFETY_POLL_INTERVAL_MS = 30_000;
const REGISTER_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_LINE_BYTES = 1_000_000;
const MAX_CODEX_MESSAGE_BYTES = 120_000;
const LEDGER_LOCK_TIMEOUT_MS = 5_000;
const INJECTED_REASONS = new Set(['dm', 'mention', 'thread_reply', 'thread-reply']);

export type OnRelayHarness = 'codex' | 'claude';

export interface OnRelayTarget {
  harness: OnRelayHarness;
  sessionId: string;
}

export interface DeliveryMessage {
  id: string;
  text: string;
  from: { name?: string };
}

export interface DeliveryItem {
  id: string;
  state: string;
  availableAt?: string;
  message: DeliveryMessage;
  metadata?: Record<string, unknown>;
}

export interface DeliveryRelay {
  inbox: {
    list(input?: { agentName?: string; limit?: number }): Promise<{ items: DeliveryItem[] }>;
    ack(input: { inboxItemId: string; state?: 'delivered' | 'read' }): Promise<unknown>;
    fail(input: { inboxItemId: string; error: string; retry?: boolean }): Promise<unknown>;
    defer(input: { inboxItemId: string; availableAt: string; reason?: string }): Promise<unknown>;
  };
}

export interface OnRelayIdentity {
  id: string;
  name: string;
  token: string;
  relay: DeliveryRelay;
}

export interface NodeIdentity {
  nodeId: string;
  nodeName: string;
  token: string;
}

export type InjectionOutcome =
  | { kind: 'injected' }
  | { kind: 'retry'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'in-doubt'; reason: string };

export type DeliveryInjector = (input: {
  text: string;
  messageId: string;
  sessionId: string;
}) => Promise<InjectionOutcome>;

interface LedgerEntry {
  state: 'injecting' | 'injected' | 'in-doubt' | 'rejected';
  updatedAt: string;
  reason?: string;
}

interface LedgerFile {
  version: 1;
  deliveries: Record<string, LedgerEntry>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeHarness(value: string | undefined): OnRelayHarness | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claudecode') {
    return 'claude';
  }
  return undefined;
}

export interface ResolveOnRelayTargetOptions {
  harness?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  detectedHarness?: string;
  discoverClaudeSession?: () => Promise<string | undefined>;
}

/** Resolve the current harness/session without guessing a session owned by another process. */
export async function resolveOnRelayTarget(
  options: ResolveOnRelayTargetOptions = {}
): Promise<OnRelayTarget> {
  const env = options.env ?? process.env;
  const explicitHarness = nonEmpty(options.harness);
  const codexSession =
    nonEmpty(env.CODEX_THREAD_ID) ??
    nonEmpty(env.CODEX_SESSION_ID) ??
    (env.AI_HIST_CURRENT_SOURCE === 'codex' ? nonEmpty(env.AI_HIST_CURRENT_SESSION_ID) : undefined);
  const claudeSession =
    nonEmpty(env.CLAUDE_CODE_SESSION_ID) ??
    (env.AI_HIST_CURRENT_SOURCE === 'claude' ? nonEmpty(env.AI_HIST_CURRENT_SESSION_ID) : undefined);

  let harness = normalizeHarness(explicitHarness);
  if (explicitHarness && !harness && explicitHarness !== 'auto') {
    throw new Error(`Unsupported harness "${explicitHarness}". Use codex, claude, or auto.`);
  }
  harness ??=
    normalizeHarness(nonEmpty(env.RELAY_ON_RELAY_HARNESS)) ??
    normalizeHarness(nonEmpty(env.AGENT_RELAY_HARNESS)) ??
    normalizeHarness(nonEmpty(env.AGENT_RELAY_ORCHESTRATOR_HARNESS));
  if (!harness && codexSession && !claudeSession) harness = 'codex';
  if (!harness && claudeSession && !codexSession) harness = 'claude';
  harness ??= normalizeHarness(options.detectedHarness);

  if (!harness) {
    throw new Error(
      'Could not detect Codex or Claude Code. Pass --harness codex|claude and --session-id <id>.'
    );
  }

  let sessionId =
    nonEmpty(options.sessionId) ??
    nonEmpty(env.RELAY_ON_RELAY_SESSION_ID) ??
    (harness === 'codex' ? codexSession : claudeSession);
  if (!sessionId && harness === 'claude') {
    sessionId = await (options.discoverClaudeSession ?? discoverCurrentClaudeSession)();
  }
  // Broker-spawned agents commonly expose their provider session through the
  // attestation variable. Use it only as a last resort and only when it has the
  // UUID shape both first-party routes require.
  if (!sessionId && isUuid(env.RELAY_ATTEST_SESSION_ID ?? '')) {
    sessionId = env.RELAY_ATTEST_SESSION_ID;
  }
  if (!sessionId) {
    throw new Error(
      `Could not determine the ${harness} session id. Pass --session-id or set ${
        harness === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID'
      }.`
    );
  }
  if (!isUuid(sessionId)) {
    throw new Error(`The ${harness} session id must be a UUID.`);
  }
  return { harness, sessionId };
}

export function normalizeAgentName(value: string): string {
  const name = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(name) || name.includes('--')) {
    throw new Error('Agent name must be 2-48 lowercase letters, digits, or single dashes.');
  }
  if (name.length < 2) {
    throw new Error('Agent name must be 2-48 lowercase letters, digits, or single dashes.');
  }
  return name;
}

export function validateOnRelayBaseUrl(value: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? DEFAULT_BASE_URL);
  } catch {
    throw new Error('The Relaycast base URL is invalid.');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
  ) {
    throw new Error('The Relaycast base URL must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  return parsed.origin;
}

export interface MintNodeTokenOptions {
  baseUrl: string;
  agentToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Port of relay-desktop's POST /v1/agent/node-token exchange. */
export async function mintNodeToken(options: MintNodeTokenOptions): Promise<NodeIdentity> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/v1/agent/node-token`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${options.agentToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-relaycast-harness': 'agent-relay-on-relay',
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Relaycast refused the node token request (HTTP ${response.status}).`);
    }
    const envelope = (await response.json()) as unknown;
    const record = asRecord(envelope);
    const data = asRecord(record.data ?? record);
    const nodeId = stringField(data, 'node_id');
    const nodeName = stringField(data, 'node_name');
    const token = stringField(data, 'token');
    if (!nodeId || !nodeName || !token) {
      throw new Error('Relaycast returned an unreadable node token.');
    }
    return { nodeId, nodeName, token };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function sendAgentHeartbeat(options: MintNodeTokenOptions): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/v1/agents/heartbeat`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${options.agentToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-relaycast-harness': 'agent-relay-on-relay',
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' && record[key] ? record[key] : undefined;
}

export function nodeSocketUrl(baseUrl: string, token: string, version: string): string {
  const url = new URL('/v1/node/ws', `${baseUrl}/`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('token', token);
  url.searchParams.set('origin_surface', 'headless');
  url.searchParams.set('origin_client', 'agent-relay');
  url.searchParams.set('origin_version', version);
  return url.toString();
}

export function nodeRegisterFrame(node: NodeIdentity, version: string, id: string): Record<string, unknown> {
  return {
    v: 1,
    id,
    type: 'node.register',
    node_id: node.nodeId,
    name: node.nodeName,
    capabilities: [],
    max_agents: 1,
    tags: ['implicit', 'direct', 'sdk', 'headless'],
    version: `agent-relay/${version}`,
    resume_cursor: null,
  };
}

export function nodeHeartbeatFrame(node: NodeIdentity, version: string): Record<string, unknown> {
  return {
    v: 1,
    type: 'node.heartbeat',
    load: null,
    active_agents: 1,
    handlers_live: false,
    node_id: node.nodeId,
    name: node.nodeName,
    capabilities: [],
    max_agents: 1,
    version: `agent-relay/${version}`,
  };
}

export function reconnectBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 5));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

interface PushChannelOptions {
  baseUrl: string;
  agentToken: string;
  version: string;
  signal: AbortSignal;
  onWake: () => void;
  onState?: (state: 'connecting' | 'live' | 'waiting') => void;
  onError?: (message: string) => void;
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string) => WebSocket;
  random?: () => number;
}

class NodeRegistrationFailure extends Error {}

/** Realtime wake channel; delivery ownership remains in the durable HTTP queue. */
export async function runPushChannel(options: PushChannelOptions): Promise<void> {
  let attempt = 0;
  while (!options.signal.aborted) {
    options.onState?.('connecting');
    try {
      const node = await mintNodeToken({
        baseUrl: options.baseUrl,
        agentToken: options.agentToken,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      });
      const registered = await openPushSocket(node, options);
      // A live socket resets the retry epoch; its eventual close is retry 1.
      attempt = registered ? 1 : attempt + 1;
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof NodeRegistrationFailure) throw error;
      options.onError?.(safeErrorMessage(error));
      attempt += 1;
    }
    if (options.signal.aborted) return;
    options.onWake();
    options.onState?.('waiting');
    await abortableDelay(reconnectBackoffMs(attempt, options.random), options.signal);
  }
}

function openPushSocket(node: NodeIdentity, options: PushChannelOptions): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const registerId = `register-${node.nodeId}-${randomUUID()}`;
    const socket = (options.websocketFactory ?? ((url) => new WebSocket(url)))(
      nodeSocketUrl(options.baseUrl, node.token, options.version)
    );
    let registered = false;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const registrationTimeout = setTimeout(() => {
      options.onError?.('Node registration timed out; reconnecting.');
      socket.terminate();
    }, REGISTER_TIMEOUT_MS);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(registrationTimeout);
      if (heartbeat) clearInterval(heartbeat);
      options.signal.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve(registered);
    };
    const stop = () => {
      try {
        socket.close(1000, 'shutdown');
      } catch {
        socket.terminate();
      }
      finish();
    };
    options.signal.addEventListener('abort', stop, { once: true });

    socket.on('open', () => {
      socket.send(JSON.stringify(nodeRegisterFrame(node, options.version, registerId)));
    });
    socket.on('message', (raw: RawData) => {
      let frame: Record<string, unknown>;
      try {
        frame = asRecord(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (frame.type === 'reply' && frame.id === registerId) {
        registered = true;
        clearTimeout(registrationTimeout);
        options.onState?.('live');
        options.onWake();
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(nodeHeartbeatFrame(node, options.version)));
          }
        }, HEARTBEAT_INTERVAL_MS);
        return;
      }
      if (frame.type === 'error' && frame.id === registerId) {
        finish(new NodeRegistrationFailure('Relaycast rejected the node registration.'));
        socket.terminate();
        return;
      }
      if (frame.type === 'deliver') options.onWake();
    });
    socket.on('error', () => {
      options.onError?.('Relaycast node socket error; reconnecting.');
    });
    socket.on('close', () => finish());
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'request aborted';
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Hold the broker's cross-platform kernel lock for one complete delivery drain.
 * The stable lock file is never unlinked, so every listener for this ledger
 * contends on the same inode and the kernel releases ownership after a crash.
 */
async function withKernelLedgerLock<T>(ledgerFile: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const binary = getBrokerBinaryPath();
  if (!binary) throw new Error(formatBrokerNotFoundError());
  const lockFile = `${ledgerFile}.lock`;
  const child = spawn(
    binary,
    [
      'journal-lock',
      '--file',
      lockFile,
      '--journal-file',
      ledgerFile,
      '--timeout-ms',
      String(LEDGER_LOCK_TIMEOUT_MS),
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] }
  );
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  let exited = false;
  void exit.then(() => {
    exited = true;
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      operation();
    };
    const deadline = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error(`The on-relay ledger lock did not respond for ${lockFile}.`));
      });
    }, LEDGER_LOCK_TIMEOUT_MS + 2_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(0, newline) === 'locked') {
        settle(resolve);
      } else {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`The on-relay ledger lock returned an invalid handshake for ${lockFile}.`));
        });
      }
    });
    child.once('error', (error) => {
      settle(() => reject(new Error(`Could not start the on-relay ledger lock: ${safeErrorMessage(error)}`)));
    });
    void exit.then((code) => {
      settle(() => {
        if (code === 4) {
          reject(new Error(`Timed out waiting for another on-relay listener using ${lockFile}.`));
        } else if (code === 3) {
          reject(new Error(`The on-relay ledger lock has an unrecognized format: ${lockFile}.`));
        } else if (code === 2) {
          reject(
            new Error(`The broker binary does not support the on-relay ledger lock; upgrade agent-relay.`)
          );
        } else {
          reject(new Error(`The on-relay ledger lock exited before acquisition (${code ?? 'unknown'}).`));
        }
      });
    });
  });

  const release = async (): Promise<void> => {
    if (exited) {
      const code = await exit;
      if (code !== 0) throw new Error(`The on-relay ledger lock was lost before release.`);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.stdin!.once('error', finish);
      void exit.then(finish);
      try {
        child.stdin!.end(finish);
      } catch {
        finish();
      }
    });
    const code = await exit;
    if (code !== 0) throw new Error(`The on-relay ledger lock was lost before release.`);
  };

  try {
    const result = await action();
    await release();
    return result;
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}

export class DeliveryLedger {
  private entries = new Map<string, LedgerEntry>();

  constructor(readonly filePath: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = new Map();
        return;
      }
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new Error(`The on-relay delivery ledger is corrupt: ${this.filePath}`);
    }
    const record = asRecord(decoded);
    if (record.version !== 1) {
      throw new Error(`The on-relay delivery ledger has an unsupported version: ${this.filePath}`);
    }
    const entries = new Map<string, LedgerEntry>();
    for (const [id, value] of Object.entries(asRecord(record.deliveries))) {
      const entry = asRecord(value);
      const state = entry.state;
      const updatedAt = entry.updatedAt;
      if (
        (state === 'injecting' || state === 'injected' || state === 'in-doubt' || state === 'rejected') &&
        typeof updatedAt === 'string'
      ) {
        entries.set(id, {
          state,
          updatedAt,
          ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
        });
      }
    }
    this.entries = entries;
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    return withKernelLedgerLock(this.filePath, async () => {
      await this.load();
      return action();
    });
  }

  get(id: string): LedgerEntry['state'] | undefined {
    return this.entries.get(id)?.state;
  }

  reason(id: string): string | undefined {
    return this.entries.get(id)?.reason;
  }

  async record(id: string, state: LedgerEntry['state'], reason?: string): Promise<void> {
    const next = new Map(this.entries);
    next.set(id, {
      state,
      updatedAt: new Date().toISOString(),
      ...(reason ? { reason: reason.slice(0, 500) } : {}),
    });
    await this.save(next);
    this.entries = next;
  }

  async forget(id: string): Promise<void> {
    if (!this.entries.has(id)) return;
    const next = new Map(this.entries);
    next.delete(id);
    await this.save(next);
    this.entries = next;
  }

  private async save(entries: Map<string, LedgerEntry>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const deliveries = Object.fromEntries(entries);
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, deliveries } satisfies LedgerFile, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await rename(temporary, this.filePath);
  }
}

export function defaultOnRelayStateFile(name: string, agentId: string, env = process.env): string {
  const root =
    nonEmpty(env.XDG_STATE_HOME) ?? path.join(nonEmpty(env.HOME) ?? os.homedir(), '.agentworkforce');
  const suffix = createHash('sha256').update(agentId).digest('hex').slice(0, 12);
  return path.join(root, 'relay', 'on-relay', `${name}-${suffix}.json`);
}

export function messageReference(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 12);
}

function safeLabel(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === '[' || character === ']' || codePoint < 0x20 || codePoint === 0x7f
        ? '?'
        : character;
    })
    .join('');
}

export function labeledDeliveryText(item: DeliveryItem, agentName: string): string {
  const sender = item.message.from.name ? `@${safeLabel(item.message.from.name)}` : 'a teammate';
  const messageId = item.message.id || item.id;
  return `[via Agent Relay — from ${sender} to @${agentName} · ref ${messageReference(
    messageId
  )}]\n\n${item.message.text}`;
}

function deliveryReason(item: DeliveryItem): string | undefined {
  return typeof item.metadata?.reason === 'string' ? item.metadata.reason : undefined;
}

export interface DeliveryDrainerOptions {
  relay: DeliveryRelay;
  ledger: DeliveryLedger;
  injector: DeliveryInjector;
  agentName: string;
  sessionId: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Serial durable queue consumer. A delivery is never injected twice concurrently. */
export class DeliveryDrainer {
  private running?: Promise<void>;
  private requested = false;
  private readonly retryAfter = new Map<string, number>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: DeliveryDrainerOptions) {}

  request(): Promise<void> {
    this.requested = true;
    this.running ??= this.run().finally(() => {
      this.running = undefined;
      if (this.requested && !this.options.signal?.aborted) void this.request();
    });
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.requested && !this.options.signal?.aborted) {
      this.requested = false;
      await this.drainOnce();
    }
  }

  async drainOnce(): Promise<void> {
    await this.options.ledger.exclusive(async () => {
      const result = await this.options.relay.inbox.list({
        agentName: this.options.agentName,
        limit: 50,
      });
      for (const item of result.items) {
        if (this.options.signal?.aborted) return;
        const availableAt = item.availableAt === undefined ? undefined : Date.parse(item.availableAt);
        if (
          (item.state === 'deferred' && availableAt === undefined) ||
          (availableAt !== undefined && (!Number.isFinite(availableAt) || availableAt > Date.now()))
        ) {
          continue;
        }
        if (item.state !== 'queued' && item.state !== 'delivered' && item.state !== 'deferred') continue;
        try {
          await this.handle(item);
        } catch (error) {
          this.options.warn?.(`Delivery ${item.id} could not be handled: ${safeErrorMessage(error)}`);
        }
      }
    });
  }

  private async handle(item: DeliveryItem): Promise<void> {
    const remembered = this.options.ledger.get(item.id);
    if (remembered === 'injected') {
      if (await this.ack(item.id)) await this.options.ledger.forget(item.id);
      return;
    }
    if (remembered === 'injecting' || remembered === 'in-doubt') {
      await this.failInDoubt(item.id);
      return;
    }
    if (remembered === 'rejected') {
      await this.failRejected(item.id, this.options.ledger.reason(item.id) ?? 'delivery rejected');
      return;
    }
    if ((this.retryAfter.get(item.id) ?? 0) > Date.now()) return;
    const reason = deliveryReason(item);
    if (!INJECTED_REASONS.has(reason ?? '') || !item.message.text.trim()) {
      await this.ack(item.id);
      return;
    }
    if (item.message.from.name?.trim().replace(/^@/, '').toLowerCase() === this.options.agentName) {
      await this.ack(item.id);
      return;
    }

    // Persist the in-flight barrier before the external side effect. A crash
    // after this point is in doubt and is never resent, matching relay-desktop.
    await this.options.ledger.record(item.id, 'injecting');
    let outcome: InjectionOutcome;
    try {
      outcome = await this.options.injector({
        text: labeledDeliveryText(item, this.options.agentName),
        messageId: item.message.id || item.id,
        sessionId: this.options.sessionId,
      });
    } catch {
      outcome = { kind: 'in-doubt', reason: 'the harness injection route failed ambiguously' };
    }
    if (outcome.kind === 'injected') {
      this.attempts.delete(item.id);
      this.retryAfter.delete(item.id);
      await this.options.ledger.record(item.id, 'injected');
      if (!(await this.ack(item.id))) {
        this.options.warn?.(`Injected delivery ${item.id}; acknowledgement will retry.`);
        return;
      }
      await this.options.ledger.forget(item.id);
      this.options.log?.(`Injected delivery ${item.id} from @${item.message.from.name ?? 'unknown'}.`);
      return;
    }
    if (outcome.kind === 'in-doubt') {
      this.attempts.delete(item.id);
      this.retryAfter.delete(item.id);
      await this.options.ledger.record(item.id, 'in-doubt');
      await this.failInDoubt(item.id, outcome.reason);
      this.options.warn?.(`Delivery ${item.id} may have arrived and will not be resent.`);
      return;
    }
    if (outcome.kind === 'rejected') {
      this.attempts.delete(item.id);
      this.retryAfter.delete(item.id);
      await this.options.ledger.record(item.id, 'rejected', outcome.reason);
      await this.failRejected(item.id, outcome.reason);
      this.options.warn?.(`Delivery ${item.id} was rejected (${outcome.reason}).`);
      return;
    }
    await this.options.ledger.forget(item.id);
    const attempt = (this.attempts.get(item.id) ?? 0) + 1;
    this.attempts.set(item.id, attempt);
    const availableAt = Date.now() + Math.min(30_000, 3_000 * 2 ** (attempt - 1));
    this.retryAfter.set(item.id, availableAt);
    try {
      await this.options.relay.inbox.defer({
        inboxItemId: item.id,
        availableAt: new Date(availableAt).toISOString(),
        reason: outcome.reason.slice(0, 500),
      });
    } catch {
      // The local timer still throttles this item. A later queue poll retries it.
    }
    this.options.warn?.(`Could not inject delivery ${item.id}; retrying (${outcome.reason}).`);
  }

  private async ack(id: string): Promise<boolean> {
    try {
      await this.options.relay.inbox.ack({ inboxItemId: id, state: 'read' });
      return true;
    } catch {
      return false;
    }
  }

  private async failInDoubt(id: string, reason = 'in doubt, not resent'): Promise<void> {
    try {
      await this.options.relay.inbox.fail({ inboxItemId: id, error: reason.slice(0, 500), retry: false });
      await this.options.ledger.forget(id);
    } catch {
      // The durable ledger is the duplicate guard; a future drain retries this
      // terminal transition without repeating the external injection.
    }
  }

  private async failRejected(id: string, reason: string): Promise<void> {
    try {
      await this.options.relay.inbox.fail({ inboxItemId: id, error: reason.slice(0, 500), retry: false });
      await this.options.ledger.forget(id);
    } catch {
      // Keep the terminal record until Relaycast confirms the failure.
    }
  }
}

interface RunOnRelayListenerOptions {
  identity: OnRelayIdentity;
  target: OnRelayTarget;
  baseUrl: string;
  stateFile?: string;
  version: string;
  signal: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  injector?: DeliveryInjector;
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string) => WebSocket;
  pollIntervalMs?: number;
}

/** Run until aborted, closing the push socket and finishing the active drain on shutdown. */
export async function runOnRelayListener(options: RunOnRelayListenerOptions): Promise<void> {
  const ledger = new DeliveryLedger(
    options.stateFile ?? defaultOnRelayStateFile(options.identity.name, options.identity.id)
  );
  await ledger.load();
  const injector =
    options.injector ??
    createHarnessInjector({ harness: options.target.harness, sessionId: options.target.sessionId });
  const drainer = new DeliveryDrainer({
    relay: options.identity.relay,
    ledger,
    injector,
    agentName: options.identity.name,
    sessionId: options.target.sessionId,
    signal: options.signal,
    log: options.log,
    warn: options.warn,
  });

  const requestDrain = () => {
    void drainer
      .request()
      .catch((error) => options.warn?.(`Delivery queue unavailable: ${safeErrorMessage(error)}`));
  };
  requestDrain();
  const polling = setInterval(requestDrain, options.pollIntervalMs ?? SAFETY_POLL_INTERVAL_MS);
  const heartbeatAgent = () => {
    void sendAgentHeartbeat({
      baseUrl: options.baseUrl,
      agentToken: options.identity.token,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    }).catch(() => {});
  };
  heartbeatAgent();
  const agentHeartbeat = setInterval(heartbeatAgent, AGENT_HEARTBEAT_INTERVAL_MS);
  const push = runPushChannel({
    baseUrl: options.baseUrl,
    agentToken: options.identity.token,
    version: options.version,
    signal: options.signal,
    onWake: requestDrain,
    onState: (state) => {
      if (state === 'live') options.log?.('Realtime delivery listener connected.');
    },
    onError: options.warn,
    fetchImpl: options.fetchImpl,
    websocketFactory: options.websocketFactory,
  });
  try {
    await Promise.race([push, waitForAbort(options.signal)]);
    if (!options.signal.aborted) await push;
  } finally {
    clearInterval(polling);
    clearInterval(agentHeartbeat);
    await drainer.request().catch(() => {});
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export interface HarnessInjectorOptions {
  harness: OnRelayHarness;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  claudeRegistryDir?: string;
}

export function createHarnessInjector(options: HarnessInjectorOptions): DeliveryInjector {
  if (options.harness === 'codex') {
    return (input) => injectCodex(input, options.env);
  }
  return (input) =>
    injectClaudeTerminal(input, {
      env: options.env,
      registryDir: options.claudeRegistryDir,
    });
}

interface CommandResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  errorCode?: string;
}

function runBoundedCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        env,
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        code: null,
        stdout: '',
        timedOut: false,
        errorCode: (error as NodeJS.ErrnoException).code,
      });
      return;
    }
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 64_000) stdout += chunk.toString('utf8').slice(0, 64_000 - stdout.length);
    });
    // Always drain stderr, but never surface it: some CLIs echo argv, which
    // would copy the incoming message into logs.
    child.stderr.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, stdout, timedOut, errorCode: (error as NodeJS.ErrnoException).code });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, timedOut });
    });
  });
}

export async function injectCodex(
  input: { text: string; messageId: string; sessionId: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<InjectionOutcome> {
  if (!isUuid(input.sessionId)) return { kind: 'retry', reason: 'invalid Codex thread id' };
  if (Buffer.byteLength(input.text) > MAX_CODEX_MESSAGE_BYTES) {
    return { kind: 'rejected', reason: 'message exceeds the portable codex queue argument limit' };
  }
  const command = nonEmpty(env.RELAY_CODEX_BIN) ?? 'codex';
  const result = await runBoundedCommand(
    command,
    ['queue', '--thread', input.sessionId, `--message=${input.text}`],
    20_000,
    env
  );
  if (result.timedOut) return { kind: 'in-doubt', reason: 'codex queue timed out' };
  if (result.code === 0) return { kind: 'injected' };
  if (result.errorCode === 'E2BIG') {
    return { kind: 'rejected', reason: 'message exceeds the portable codex queue argument limit' };
  }
  return { kind: 'retry', reason: result.code === null ? 'codex is not installed' : 'codex queue refused' };
}

interface ClaudeSessionRecord {
  sessionId: string;
  pid: number;
  socketPath: string;
  peerProtocol: number;
  procStart?: string;
}

function claudeRegistryDirectory(env: NodeJS.ProcessEnv): string {
  const root = nonEmpty(env.CLAUDE_CONFIG_DIR) ?? path.join(nonEmpty(env.HOME) ?? os.homedir(), '.claude');
  return path.join(root, 'sessions');
}

function parseClaudeSession(data: string): ClaudeSessionRecord | undefined {
  let value: Record<string, unknown>;
  try {
    value = asRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
  const sessionId = stringField(value, 'sessionId');
  const socketPath = stringField(value, 'messagingSocketPath');
  const pid = value.pid;
  if (!sessionId || !isUuid(sessionId) || !socketPath || typeof pid !== 'number' || pid <= 0)
    return undefined;
  return {
    sessionId,
    pid,
    socketPath,
    peerProtocol: typeof value.peerProtocol === 'number' ? value.peerProtocol : 0,
    ...(value.procStart !== undefined ? { procStart: String(value.procStart) } : {}),
  };
}

async function linuxProcessStart(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value
      .slice(value.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function liveClaudeSession(
  sessionId: string,
  registryDir: string
): Promise<ClaudeSessionRecord | undefined> {
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let record: ClaudeSessionRecord | undefined;
    try {
      record = parseClaudeSession(await readFile(path.join(registryDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!record || record.sessionId !== sessionId || !processAlive(record.pid)) continue;
    if (record.procStart) {
      const currentStart = await linuxProcessStart(record.pid);
      if (currentStart && currentStart !== record.procStart) continue;
    }
    return record;
  }
  return undefined;
}

async function claudePeerToken(
  session: ClaudeSessionRecord,
  registryDir: string
): Promise<string | undefined> {
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!file.startsWith(`${session.pid}.`) || !file.endsWith('.key')) continue;
    try {
      const record = asRecord(JSON.parse(await readFile(path.join(registryDir, file), 'utf8')));
      const token = stringField(record, 'peerToken');
      if (!token) continue;
      if (
        record.procStart !== undefined &&
        session.procStart !== undefined &&
        String(record.procStart) === session.procStart
      ) {
        return token;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function claudePeerFrames(token: string, messageId: string, text: string): string {
  const auth = JSON.stringify({ type: 'auth', token });
  const message = JSON.stringify({
    type: 'user',
    msg_id: messageId,
    uuid: randomUUID().toUpperCase(),
    priority: 'next',
    message: { role: 'user', content: text },
  });
  if (Buffer.byteLength(message) > MAX_LINE_BYTES) {
    throw new Error(`message exceeds Claude Code's ${MAX_LINE_BYTES}-byte inbox limit`);
  }
  return `${auth}\n${message}\n`;
}

export async function injectClaudeTerminal(
  input: { text: string; messageId: string; sessionId: string },
  options: { env?: NodeJS.ProcessEnv; registryDir?: string } = {}
): Promise<InjectionOutcome> {
  const env = options.env ?? process.env;
  const registryDir = options.registryDir ?? claudeRegistryDirectory(env);
  const session = await liveClaudeSession(input.sessionId, registryDir);
  if (!session) return { kind: 'retry', reason: 'Claude Code session is not running' };
  if (session.peerProtocol !== 1) {
    return { kind: 'retry', reason: `unsupported Claude Code peer protocol ${session.peerProtocol}` };
  }
  const token = await claudePeerToken(session, registryDir);
  if (!token) return { kind: 'retry', reason: 'Claude Code inbox key is unavailable' };
  let frames: string;
  try {
    frames = claudePeerFrames(token, input.messageId, input.text);
  } catch (error) {
    return { kind: 'rejected', reason: safeErrorMessage(error) };
  }
  return new Promise((resolve) => {
    let connected = false;
    let writing = false;
    let settled = false;
    const socket = net.createConnection({ path: session.socketPath });
    const finish = (outcome: InjectionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish(
        connected || writing
          ? { kind: 'in-doubt', reason: 'Claude Code inbox timed out while sending' }
          : { kind: 'retry', reason: 'Claude Code inbox did not accept a connection' }
      );
    }, 5_000);
    socket.once('connect', () => {
      connected = true;
      writing = true;
      // Peer protocol 1 has no acceptance receipt. Match relay-desktop: a
      // completed write means the turn was handed to Claude Code's inbox.
      socket.end(frames, 'utf8', () => finish({ kind: 'injected' }));
    });
    socket.once('error', () => {
      finish(
        writing
          ? { kind: 'in-doubt', reason: 'Claude Code inbox connection broke while sending' }
          : { kind: 'retry', reason: 'could not reach the Claude Code inbox' }
      );
    });
  });
}

async function discoverCurrentClaudeSession(): Promise<string | undefined> {
  const registryDir = claudeRegistryDirectory(process.env);
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return undefined;
  }
  const ancestors = [...(await ancestorPids(process.ppid))];
  const candidates: ClaudeSessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(registryDir, file);
    try {
      const record = parseClaudeSession(await readFile(fullPath, 'utf8'));
      if (!record || !processAlive(record.pid)) continue;
      candidates.push(record);
    } catch {
      continue;
    }
  }
  const owned = candidates
    .map((record) => ({ record, distance: ancestors.indexOf(record.pid) }))
    .filter(({ distance }) => distance >= 0)
    .sort((a, b) => a.distance - b.distance);
  return owned[0]?.record.sessionId;
}

async function ancestorPids(startPid: number): Promise<Set<number>> {
  const result = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1 && !result.has(pid); depth += 1) {
    result.add(pid);
    const next = await parentPid(pid);
    if (!next || next === pid) break;
    pid = next;
  }
  return result;
}

async function parentPid(pid: number): Promise<number | undefined> {
  const result = await runBoundedCommand('ps', ['-o', 'ppid=', '-p', String(pid)], 1_000, process.env);
  if (result.code !== 0) return undefined;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Narrow the full SDK client to the durable delivery surface used here. */
export function asDeliveryRelay(relay: AgentRelayAgent): DeliveryRelay {
  return relay as unknown as DeliveryRelay;
}
