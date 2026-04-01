/**
 * High-level facade for the Agent Relay SDK.
 *
 * Provides a clean, property-based API on top of the lower-level
 * {@link AgentRelayClient} protocol client.
 *
 * @example
 * ```ts
 * import { AgentRelay } from "@agent-relay/sdk";
 *
 * const relay = new AgentRelay();
 *
 * relay.onMessageReceived = (message) => console.log(message);
 * relay.onAgentSpawned = (agent) => console.log("spawned", agent.name);
 *
 * const codex = await relay.codex.spawn();
 * const human = relay.human({ name: "System" });
 * await human.sendMessage({ to: codex.name, text: "Hello!" });
 *
 * const agents = await relay.listAgents();
 * for (const a of agents) await a.release();
 * await relay.shutdown();
 * ```
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RelayCast } from '@relaycast/sdk';

import { AgentRelayClient, type AgentRelaySpawnOptions } from './client.js';
import { AgentRelayProtocolError } from './transport.js';
import type { SendMessageInput, SpawnPtyInput } from './types.js';
import type {
  AgentRuntime,
  BrokerEvent,
  BrokerStatus,
  HeadlessProvider,
  MessageInjectionMode,
  RestartPolicy,
} from './protocol.js';
import {
  followLogs as followLogsFromFile,
  getLogs as getLogsFromFile,
  listLoggedAgents as listLoggedAgentsFromFile,
  type FollowLogsOptions,
  type LogFollowHandle,
  type LogsResult,
} from './logs.js';

function isUnsupportedOperation(error: unknown): error is AgentRelayProtocolError {
  return error instanceof AgentRelayProtocolError && error.code === 'unsupported_operation';
}

function buildUnsupportedOperationMessage(
  from: string,
  input: {
    to: string;
    text: string;
    threadId?: string;
    data?: Record<string, unknown>;
    mode?: MessageInjectionMode;
  }
): Message {
  return {
    eventId: 'unsupported_operation',
    from,
    to: input.to,
    text: input.text,
    threadId: input.threadId,
    data: input.data,
    mode: input.mode,
  };
}

interface WorkspaceRegistryEntry {
  relaycastApiKey?: string;
  relayfileUrl?: string;
  createdAt?: string;
  agents?: string[];
}

type WorkspaceRegistry = Record<string, WorkspaceRegistryEntry>;

const WORKSPACE_ID_PREFIX = 'rw_';
const WORKSPACE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function normalizeWorkspaceId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function generateWorkspaceId(): string {
  const alphabetLength = WORKSPACE_ID_ALPHABET.length;
  const maxUnbiasedValue = Math.floor(256 / alphabetLength) * alphabetLength;
  let suffix = '';

  while (suffix.length < 8) {
    const bytes = randomBytes(8 - suffix.length);
    for (const byte of bytes) {
      if (byte >= maxUnbiasedValue) continue;
      suffix += WORKSPACE_ID_ALPHABET[byte % alphabetLength];
      if (suffix.length === 8) break;
    }
  }

  return `${WORKSPACE_ID_PREFIX}${suffix}`;
}

function toWorkspaceRegistryEntry(value: unknown): WorkspaceRegistryEntry {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const record = value as Record<string, unknown>;
  const relaycastApiKey =
    typeof record.relaycastApiKey === 'string' && record.relaycastApiKey.trim()
      ? record.relaycastApiKey.trim()
      : undefined;
  const relayfileUrl =
    typeof record.relayfileUrl === 'string' && record.relayfileUrl.trim()
      ? record.relayfileUrl.trim()
      : undefined;
  const createdAt =
    typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt.trim() : undefined;
  const agents = Array.isArray(record.agents)
    ? record.agents
        .filter((agent): agent is string => typeof agent === 'string')
        .map((agent) => agent.trim())
        .filter((agent) => agent.length > 0)
    : undefined;

  return {
    ...(relaycastApiKey ? { relaycastApiKey } : {}),
    ...(relayfileUrl ? { relayfileUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(agents && agents.length > 0 ? { agents } : {}),
  };
}

// ── Public types ────────────────────────────────────────────────────────────

export interface Message {
  eventId: string;
  from: string;
  to: string;
  text: string;
  threadId?: string;
  data?: Record<string, unknown>;
  mode?: MessageInjectionMode;
}

export type AgentStatus = 'spawning' | 'ready' | 'idle' | 'exited';
export type DeliveryWaitStatus = 'ack' | 'failed' | 'timeout';
export type DeliveryStateStatus = 'queued' | 'injected' | 'active' | 'verified' | 'failed';
export interface DeliveryWaitResult {
  eventId: string;
  status: DeliveryWaitStatus;
  targets: string[];
}
export interface DeliveryState {
  eventId: string;
  to: string;
  status: DeliveryStateStatus;
  updatedAt: number;
}

export interface SpawnLifecycleContext {
  name: string;
  cli: string;
  channels: string[];
  task?: string;
}

export interface SpawnLifecycleSuccessContext extends SpawnLifecycleContext {
  runtime: AgentRuntime;
}

export interface SpawnLifecycleErrorContext extends SpawnLifecycleContext {
  error: unknown;
}

export interface SpawnLifecycleHooks {
  onStart?: (context: SpawnLifecycleContext) => void | Promise<void>;
  onSuccess?: (context: SpawnLifecycleSuccessContext) => void | Promise<void>;
  onError?: (context: SpawnLifecycleErrorContext) => void | Promise<void>;
}

export interface ReleaseLifecycleContext {
  name: string;
  reason?: string;
}

export interface ReleaseLifecycleErrorContext extends ReleaseLifecycleContext {
  error: unknown;
}

export interface ReleaseLifecycleHooks {
  onStart?: (context: ReleaseLifecycleContext) => void | Promise<void>;
  onSuccess?: (context: ReleaseLifecycleContext) => void | Promise<void>;
  onError?: (context: ReleaseLifecycleErrorContext) => void | Promise<void>;
}

export interface ReleaseOptions extends ReleaseLifecycleHooks {
  reason?: string;
}

export interface SpawnOptions extends SpawnLifecycleHooks {
  args?: string[];
  channels?: string[];
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;
  idleThresholdSecs?: number;
  restartPolicy?: RestartPolicy;
  /** When true, skip injecting the relay MCP configuration and protocol prompt into the spawned agent.
   *  Useful for minor tasks where relay messaging is not needed, saving tokens. */
  skipRelayPrompt?: boolean;
}

export interface SpawnAndWaitOptions extends SpawnOptions {
  timeoutMs?: number;
  waitForMessage?: boolean;
}

type AgentOutputPayload = { stream: string; chunk: string };
type AgentOutputCallback = ((chunk: string) => void) | ((data: AgentOutputPayload) => void);

export interface Agent {
  readonly name: string;
  readonly runtime: AgentRuntime;
  readonly channels: string[];
  /** Current lifecycle status of the agent. */
  readonly status: AgentStatus;
  /** Set when the agent exits. Available after `onAgentExited` fires. */
  exitCode?: number;
  /** Set when the agent exits via signal. Available after `onAgentExited` fires. */
  exitSignal?: string;
  /** Set when the agent requests exit via /exit. Available after `onAgentExitRequested` fires. */
  exitReason?: string;
  release(reasonOrOptions?: string | ReleaseOptions): Promise<void>;
  waitForReady(timeoutMs?: number): Promise<void>;
  /** Wait for the agent process to exit on its own.
   *  @param timeoutMs — optional timeout in ms. Resolves with `"timeout"` if exceeded,
   *  `"exited"` if the agent exited naturally, or `"released"` if released externally. */
  waitForExit(timeoutMs?: number): Promise<'exited' | 'timeout' | 'released'>;
  /** Wait for the agent to go idle (no PTY output for the configured threshold).
   *  @param timeoutMs — optional timeout in ms. Resolves with `"idle"` when first idle event fires,
   *  `"timeout"` if timeoutMs elapses first, or `"exited"` if the agent exits. */
  waitForIdle(timeoutMs?: number): Promise<'idle' | 'timeout' | 'exited'>;
  sendMessage(input: {
    to: string;
    text: string;
    threadId?: string;
    priority?: number;
    data?: Record<string, unknown>;
    mode?: MessageInjectionMode;
  }): Promise<Message>;
  subscribe(channels: string[]): Promise<void>;
  unsubscribe(channels: string[]): Promise<void>;
  /** Register a callback for PTY output from this agent. Returns an unsubscribe function.
   * @param options.stream — if provided, only invoke callback when the event stream matches (e.g. 'stdout', 'stderr')
   * @param options.mode — 'chunk' for raw string callbacks, 'structured' for { stream, chunk } callbacks. Auto-detected if omitted.
   */
  onOutput(
    callback: AgentOutputCallback,
    options?: { stream?: string; mode?: 'chunk' | 'structured' }
  ): () => void;
}

export interface HumanHandle {
  readonly name: string;
  ensureRegistered(): Promise<string>;
  sendMessage(input: {
    to: string;
    text: string;
    threadId?: string;
    priority?: number;
    data?: Record<string, unknown>;
    mode?: MessageInjectionMode;
  }): Promise<Message>;
}

export class HumanRegistrationError extends Error {
  readonly requestedName: string;
  readonly cause?: unknown;

  constructor(requestedName: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'HumanRegistrationError';
    this.requestedName = requestedName;
    this.cause = cause;
  }
}

export interface AgentSpawner {
  spawn(options?: SpawnerSpawnOptions): Promise<Agent>;
}

export interface SpawnerSpawnOptions extends SpawnLifecycleHooks {
  name?: string;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  /** When true, skip injecting the relay MCP configuration and protocol prompt into the spawned agent.
   *  Useful for minor tasks where relay messaging is not needed, saving tokens. */
  skipRelayPrompt?: boolean;
}

export type EventHook<T> = ((value: T) => void) | null;

export interface AgentRelayOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  brokerName?: string;
  channels?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /**
   * Unified workspace ID shared across relayfile, relayauth claims, and
   * relaycast key lookup.
   */
  workspaceId?: string;
  /**
   * Display name for an auto-created Relaycast workspace.
   * If omitted, the unified workspace ID is used.
   *
   * @deprecated Since v1.x this field falls back to workspaceId when omitted,
   * changing prior behavior where it was required for workspace naming.
   * Callers relying on distinct naming should set this explicitly.
   */
  workspaceName?: string;
  /**
   * Base URL for the Relaycast API.
   * Defaults to RELAYCAST_BASE_URL env var or https://api.relaycast.dev.
   */
  relaycastBaseUrl?: string;
}

type OutputListener = {
  callback: AgentOutputCallback;
  mode: 'chunk' | 'structured';
  stream?: string;
};

type InternalAgent = Agent & {
  _setChannels: (channels: string[]) => void;
};

type HumanIdentityKind = 'human' | 'system';
type HumanRegistrationState = {
  canonicalName?: string;
  pending?: Promise<string>;
};

// ── AgentRelay facade ───────────────────────────────────────────────────────

export class AgentRelay {
  // Event hooks — assign a callback or null to clear.
  onMessageReceived: EventHook<Message> = null;
  onMessageSent: EventHook<Message> = null;
  onAgentSpawned: EventHook<Agent> = null;
  onAgentReleased: EventHook<Agent> = null;
  onAgentExited: EventHook<Agent> = null;
  onAgentReady: EventHook<Agent> = null;
  onWorkerOutput: EventHook<{ name: string; stream: string; chunk: string }> = null;
  onDeliveryUpdate: EventHook<BrokerEvent> = null;
  onAgentExitRequested: EventHook<{ name: string; reason: string }> = null;
  onAgentIdle: EventHook<{ name: string; idleSecs: number }> = null;
  onChannelSubscribed: ((agent: string, channels: string[]) => void) | null = null;
  onChannelUnsubscribed: ((agent: string, channels: string[]) => void) | null = null;

  // ── Public accessors ────────────────────────────────────────────────────

  /** The resolved Relaycast workspace API key (available after first spawn). */
  get workspaceKey(): string | undefined {
    return this.relayApiKey;
  }

  /** Observer URL for the auto-created workspace (available after first spawn). */
  get observerUrl(): string | undefined {
    if (!this.relayApiKey) return undefined;
    return `https://agentrelay.dev/observer?key=${this.relayApiKey}`;
  }

  // Shorthand spawners
  readonly codex: AgentSpawner;
  readonly claude: AgentSpawner;
  readonly gemini: AgentSpawner;
  readonly opencode: AgentSpawner;

  private readonly clientOptions: AgentRelaySpawnOptions;
  private readonly defaultChannels: string[];
  private readonly requestedWorkspaceId?: string;
  private readonly workspaceName?: string;
  private readonly relaycastBaseUrl?: string;
  private relayApiKey?: string;
  private resolvedWorkspaceId?: string;
  private client?: AgentRelayClient;
  private startPromise?: Promise<AgentRelayClient>;
  private unsubEvent?: () => void;
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly knownAgents = new Map<string, Agent>();
  private readonly readyAgents = new Set<string>();
  private readonly messageReadyAgents = new Set<string>();
  private readonly exitedAgents = new Set<string>();
  private readonly idleAgents = new Set<string>();
  private readonly deliveryStates = new Map<string, DeliveryState>();
  private readonly outputListeners = new Map<string, Set<OutputListener>>();
  private readonly humanRegistrations = new Map<string, HumanRegistrationState>();
  private readonly exitResolvers = new Map<
    string,
    { resolve: (reason: 'exited' | 'released') => void; token: number }
  >();
  private exitResolverSeq = 0;
  private readonly idleResolvers = new Map<
    string,
    { resolve: (reason: 'idle' | 'timeout' | 'exited') => void; token: number }
  >();
  private idleResolverSeq = 0;

  constructor(options: AgentRelayOptions = {}) {
    const requestedWorkspaceId = normalizeWorkspaceId(options.workspaceId);
    this.defaultChannels = options.channels ?? ['general'];
    this.requestedWorkspaceId = requestedWorkspaceId;
    this.workspaceName = options.workspaceName;
    if (options.workspaceName && !options.workspaceId) {
      console.warn(
        '[AgentRelay] workspaceName without workspaceId is deprecated and will be removed in a future major version. ' +
          'Set workspaceId explicitly to avoid silent behavior changes.'
      );
    }
    this.relaycastBaseUrl = options.relaycastBaseUrl;
    this.clientOptions = {
      binaryPath: options.binaryPath,
      binaryArgs: options.binaryArgs,
      brokerName: options.brokerName ?? options.workspaceName ?? requestedWorkspaceId,
      channels: this.defaultChannels,
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
    };

    this.codex = this.createSpawner('codex', 'Codex', 'pty');
    this.claude = this.createSpawner('claude', 'Claude', 'pty');
    this.gemini = this.createSpawner('gemini', 'Gemini', 'pty');
    this.opencode = this.createSpawner('opencode', 'OpenCode', 'headless');
  }

  private getWorkspaceRegistryPath(): string {
    return path.join(this.clientOptions.cwd ?? process.cwd(), '.relay', 'workspaces.json');
  }

  private readWorkspaceRegistry(): WorkspaceRegistry {
    const registryPath = this.getWorkspaceRegistryPath();
    if (!existsSync(registryPath)) {
      return {};
    }

    let raw: string;
    try {
      raw = readFileSync(registryPath, 'utf8').trim();
    } catch {
      return {};
    }
    if (!raw) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Registry file is corrupted (partial write, disk full, concurrent access).
      // Return empty registry so callers can re-create it.
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const registry: WorkspaceRegistry = {};
    for (const [workspaceId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedId = normalizeWorkspaceId(workspaceId);
      if (!normalizedId) continue;
      registry[normalizedId] = toWorkspaceRegistryEntry(entry);
    }
    return registry;
  }

  private writeWorkspaceRegistry(registry: WorkspaceRegistry): void {
    const registryPath = this.getWorkspaceRegistryPath();
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private persistWorkspaceMapping(workspaceId: string, apiKey: string): void {
    const registry = this.readWorkspaceRegistry();
    const existing = registry[workspaceId] ?? {};
    registry[workspaceId] = {
      ...existing,
      relaycastApiKey: apiKey,
      relayfileUrl: existing.relayfileUrl,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      agents: existing.agents ?? [],
    };
    this.writeWorkspaceRegistry(registry);
  }

  private findMappedWorkspaceIdByApiKey(apiKey: string): string | undefined {
    const registry = this.readWorkspaceRegistry();
    for (const [workspaceId, entry] of Object.entries(registry)) {
      if (entry.relaycastApiKey === apiKey) {
        return workspaceId;
      }
    }
    return undefined;
  }

  private getResolvedWorkspaceId(): string | undefined {
    return this.resolvedWorkspaceId ?? this.requestedWorkspaceId;
  }

  private getRelaycastBaseUrl(): string {
    return (
      this.relaycastBaseUrl ??
      this.clientOptions.env?.RELAYCAST_BASE_URL ??
      process.env.RELAYCAST_BASE_URL ??
      'https://api.relaycast.dev'
    );
  }

  private applyWorkspaceEnv(workspaceId: string, apiKey: string): void {
    const env: NodeJS.ProcessEnv = {
      ...(this.clientOptions.env ?? process.env),
      RELAY_API_KEY: apiKey,
      RELAYFILE_WORKSPACE: workspaceId,
      RELAY_DEFAULT_WORKSPACE: workspaceId,
      RELAY_WORKSPACE_ID: workspaceId,
      RELAY_WORKSPACES_JSON: JSON.stringify([{ workspace_id: workspaceId, api_key: apiKey }]),
    };
    if (this.relaycastBaseUrl) {
      env.RELAYCAST_BASE_URL = this.relaycastBaseUrl;
    }
    this.clientOptions.env = env;
  }

  private async createMappedRelaycastWorkspace(workspaceId: string): Promise<string> {
    const created = await RelayCast.createWorkspace(
      this.workspaceName ?? workspaceId,
      this.getRelaycastBaseUrl()
    );
    return created.apiKey;
  }

  /**
   * Subscribe to broker stderr output. Listener is wired immediately if the
   * client is already started, otherwise it is attached when the client starts.
   * Returns an unsubscribe function.
   */
  onBrokerStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }

  // ── Spawning ────────────────────────────────────────────────────────────

  async spawnPty(input: SpawnPtyInput & SpawnLifecycleHooks): Promise<Agent> {
    const client = await this.ensureStarted();
    if (!input.channels || input.channels.length === 0) {
      console.warn(
        `[AgentRelay] spawnPty("${input.name}"): no channels specified, defaulting to "general". ` +
          'Set explicit channels for workflow isolation.'
      );
    }
    const channels = input.channels ?? ['general'];
    const lifecycleContext: SpawnLifecycleContext = {
      name: input.name,
      cli: input.cli,
      channels,
      task: input.task,
    };
    await this.invokeLifecycleHook(input.onStart, lifecycleContext, `spawnPty("${input.name}") onStart`);
    let result: { name: string; runtime: AgentRuntime };
    try {
      result = await client.spawnPty({
        name: input.name,
        cli: input.cli,
        args: input.args,
        channels,
        task: input.task,
        model: input.model,
        cwd: input.cwd,
        team: input.team,
        shadowOf: input.shadowOf,
        shadowMode: input.shadowMode,
        idleThresholdSecs: input.idleThresholdSecs,
        restartPolicy: input.restartPolicy,
        skipRelayPrompt: input.skipRelayPrompt,
      });
    } catch (error) {
      await this.invokeLifecycleHook(
        input.onError,
        {
          ...lifecycleContext,
          error,
        },
        `spawnPty("${input.name}") onError`
      );
      throw error;
    }
    this.resetAgentLifecycleState(result.name);
    const agent = this.makeAgent(result.name, result.runtime, channels);
    this.knownAgents.set(agent.name, agent);
    await this.invokeLifecycleHook(
      input.onSuccess,
      {
        ...lifecycleContext,
        name: result.name,
        runtime: result.runtime,
      },
      `spawnPty("${input.name}") onSuccess`
    );
    return agent;
  }

  async spawn(name: string, cli: string, task?: string, options?: SpawnOptions): Promise<Agent> {
    return this.spawnPty({
      name,
      cli,
      task,
      args: options?.args,
      channels: options?.channels,
      model: options?.model,
      cwd: options?.cwd,
      team: options?.team,
      shadowOf: options?.shadowOf,
      shadowMode: options?.shadowMode,
      idleThresholdSecs: options?.idleThresholdSecs,
      restartPolicy: options?.restartPolicy,
      skipRelayPrompt: options?.skipRelayPrompt,
      onStart: options?.onStart,
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    });
  }

  async spawnAndWait(name: string, cli: string, task: string, options?: SpawnAndWaitOptions): Promise<Agent> {
    const { timeoutMs, waitForMessage, ...spawnOptions } = options ?? {};
    await this.spawn(name, cli, task, spawnOptions);
    if (waitForMessage) {
      return this.waitForAgentMessage(name, timeoutMs ?? 60_000);
    }
    return this.waitForAgentReady(name, timeoutMs ?? 60_000);
  }

  // ── Human source ────────────────────────────────────────────────────────

  async registerHuman(opts: { name: string }): Promise<HumanHandle> {
    const handle = this.createHumanHandle(opts.name, 'human', true);
    await handle.ensureRegistered();
    return handle;
  }

  human(opts: { name: string; ensureRegistered: true }): Promise<HumanHandle>;
  human(opts: { name: string; ensureRegistered?: false | undefined }): HumanHandle;
  human(opts: { name: string; ensureRegistered?: boolean }): HumanHandle | Promise<HumanHandle> {
    const handle = this.createHumanHandle(opts.name, 'human', true);
    if (opts.ensureRegistered) {
      return handle.ensureRegistered().then(() => handle);
    }
    return handle;
  }

  private createHumanHandle(
    requestedName: string,
    kind: HumanIdentityKind,
    autoEnsureRegistration: boolean
  ): HumanHandle {
    const normalizedRequestedName = this.normalizeHumanRequestedName(requestedName);
    const stateKey = this.humanRegistrationKey(normalizedRequestedName, kind);
    const resolveName = () => this.humanRegistrations.get(stateKey)?.canonicalName ?? normalizedRequestedName;

    return {
      get name() {
        return resolveName();
      },
      ensureRegistered: async () => {
        if (!autoEnsureRegistration) {
          return resolveName();
        }
        return this.ensureHumanRegistered(normalizedRequestedName, kind);
      },
      sendMessage: async (input) => {
        const client = await this.ensureStarted();
        const from = autoEnsureRegistration
          ? await this.ensureHumanRegistered(normalizedRequestedName, kind)
          : resolveName();
        let result: Awaited<ReturnType<typeof client.sendMessage>>;
        try {
          result = await client.sendMessage({
            to: input.to,
            text: input.text,
            from,
            threadId: input.threadId,
            priority: input.priority,
            data: input.data,
            mode: input.mode,
          });
        } catch (error) {
          if (isUnsupportedOperation(error)) {
            return buildUnsupportedOperationMessage(from, input);
          }
          throw error;
        }
        if (result?.event_id === 'unsupported_operation') {
          return buildUnsupportedOperationMessage(from, input);
        }

        const eventId = result?.event_id ?? randomBytes(8).toString('hex');
        const msg: Message = {
          eventId,
          from,
          to: input.to,
          text: input.text,
          threadId: input.threadId,
          data: input.data,
          mode: input.mode,
        };
        this.onMessageSent?.(msg);
        return msg;
      },
    };
  }

  system(): HumanHandle {
    return this.createHumanHandle('system', 'system', false);
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  /**
   * Broadcast a message to all connected agents.
   * @param text — the message body
   * @param options — optional sender name (defaults to "human:orchestrator")
   */
  async broadcast(text: string, options?: { from?: string }): Promise<Message> {
    const from = options?.from ?? 'human:orchestrator';
    return this.human({ name: from }).sendMessage({ to: '*', text });
  }

  async sendAndWaitForDelivery(input: SendMessageInput, timeoutMs = 30_000): Promise<DeliveryWaitResult> {
    const client = await this.ensureStarted();
    const result = await client.sendMessage(input);

    if (!result.targets.length) {
      return { eventId: result.event_id, status: 'failed', targets: [] };
    }

    return new Promise<DeliveryWaitResult>((resolve) => {
      let resolved = false;
      const ackedTargets = new Set<string>();
      // eslint-disable-next-line prefer-const
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          unsubscribe?.();
          resolve({ eventId: result.event_id, status: 'timeout', targets: result.targets });
        }
      }, timeoutMs);

      unsubscribe = client.onEvent((event) => {
        if (resolved) return;

        if (
          event.kind === 'delivery_ack' &&
          event.event_id === result.event_id &&
          result.targets.includes(event.name)
        ) {
          ackedTargets.add(event.name);
          if (ackedTargets.size >= result.targets.length) {
            resolved = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve({ eventId: result.event_id, status: 'ack', targets: result.targets });
          }
        }

        if (
          event.kind === 'delivery_failed' &&
          event.event_id === result.event_id &&
          result.targets.includes(event.name)
        ) {
          resolved = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve({ eventId: result.event_id, status: 'failed', targets: result.targets });
        }
      });
    });
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    const client = await this.ensureStarted();
    const list = await client.listAgents();
    return list.map((entry) => {
      const existing = this.knownAgents.get(entry.name);
      if (existing) return existing;
      const agent = this.makeAgent(entry.name, entry.runtime, entry.channels);
      this.knownAgents.set(agent.name, agent);
      return agent;
    });
  }

  /** Pre-register a batch of agents with Relaycast before steps execute. */
  async preflightAgents(agents: Array<{ name: string; cli: string }>): Promise<void> {
    const client = await this.ensureStarted();
    await client.preflight(agents);
  }

  /** List agents with PIDs from the broker (for worker registration). */
  async listAgentsRaw(): Promise<Array<{ name: string; pid?: number }>> {
    const client = await this.ensureStarted();
    return client.listAgents();
  }

  // ── Status ────────────────────────────────────────────────────────────

  async getStatus(): Promise<BrokerStatus> {
    const client = await this.ensureStarted();
    return client.getStatus();
  }

  async subscribe(opts: { agent: string; channels: string[] }): Promise<void> {
    const client = await this.ensureStarted();
    await client.subscribeChannels(opts.agent, opts.channels);
    this.addAgentChannels(opts.agent, opts.channels);
  }

  async unsubscribe(opts: { agent: string; channels: string[] }): Promise<void> {
    const client = await this.ensureStarted();
    await client.unsubscribeChannels(opts.agent, opts.channels);
    this.removeAgentChannels(opts.agent, opts.channels);
  }

  getDeliveryState(eventId: string): DeliveryState | undefined {
    return this.deliveryStates.get(eventId);
  }

  // ── Logs ──────────────────────────────────────────────────────────────

  /**
   * Read the last N lines of an agent's log file.
   *
   * @example
   * ```ts
   * const logs = await relay.getLogs("Worker1", { lines: 100 });
   * if (logs.found) console.log(logs.content);
   * ```
   */
  async getLogs(agentName: string, options?: { lines?: number }): Promise<LogsResult> {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, '.agent-relay', 'team', 'worker-logs');
    return getLogsFromFile(agentName, { logsDir, lines: options?.lines });
  }

  /** List all agents that have log files. */
  async listLoggedAgents(): Promise<string[]> {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, '.agent-relay', 'team', 'worker-logs');
    return listLoggedAgentsFromFile(logsDir);
  }

  /**
   * Follow an agent's local log file with history bootstrap + incremental updates.
   *
   * @example
   * ```ts
   * const handle = relay.followLogs("Worker1", {
   *   historyLines: 100,
   *   onEvent(event) {
   *     if (event.type === "log") console.log(event.content);
   *   },
   * });
   *
   * // Later:
   * handle.unsubscribe();
   * ```
   */
  followLogs(agentName: string, options: Omit<FollowLogsOptions, 'logsDir'>): LogFollowHandle {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, '.agent-relay', 'team', 'worker-logs');
    return followLogsFromFile(agentName, { ...options, logsDir });
  }

  // ── Wait helpers ──────────────────────────────────────────────────────

  /**
   * Wait for any one of the given agents to exit. Returns the first agent
   * that exits along with its exit reason.
   *
   * @example
   * ```ts
   * const { agent, result } = await AgentRelay.waitForAny([worker1, worker2], 60_000);
   * console.log(`${agent.name} finished: ${result}`);
   * ```
   */
  static async waitForAny(
    agents: Agent[],
    timeoutMs?: number
  ): Promise<{ agent: Agent; result: 'exited' | 'timeout' | 'released' }> {
    if (agents.length === 0) {
      throw new Error('waitForAny requires at least one agent');
    }
    return Promise.race(
      agents.map(async (agent) => {
        const result = await agent.waitForExit(timeoutMs);
        return { agent, result };
      })
    );
  }

  /**
   * Resolves when the agent process has started and connected to the broker.
   * The agent's CLI may not yet be ready to receive messages.
   * Use `waitForAgentMessage()` for full readiness.
   */
  async waitForAgentReady(name: string, timeoutMs = 60_000): Promise<Agent> {
    const client = await this.ensureStarted();
    const existing = this.knownAgents.get(name);
    if (existing && this.readyAgents.has(name)) {
      return existing;
    }

    return new Promise<Agent>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        unsubscribe();
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };

      const resolveWith = (agent: Agent) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(agent);
      };

      const rejectWith = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const unsubscribe = client.onEvent((event) => {
        if (event.kind !== 'worker_ready' || event.name !== name) {
          return;
        }
        const agent = this.ensureAgentHandle(event.name, event.runtime);
        this.readyAgents.add(event.name);
        this.exitedAgents.delete(event.name);
        resolveWith(agent);
      });

      timeout = setTimeout(() => {
        rejectWith(new Error(`Timed out waiting for worker_ready for '${name}' after ${timeoutMs}ms`));
      }, timeoutMs);

      const known = this.knownAgents.get(name);
      if (known && this.readyAgents.has(name)) {
        resolveWith(known);
      }
    });
  }

  async waitForAgentMessage(name: string, timeoutMs = 60_000): Promise<Agent> {
    const client = await this.ensureStarted();
    const existing = this.knownAgents.get(name);
    if (existing && this.messageReadyAgents.has(name)) {
      return existing;
    }

    return new Promise<Agent>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        unsubscribe();
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };

      const resolveWith = (agent: Agent) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(agent);
      };

      const rejectWith = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const unsubscribe = client.onEvent((event) => {
        if (event.kind === 'relay_inbound' && event.from === name) {
          this.messageReadyAgents.add(name);
          this.exitedAgents.delete(name);
          resolveWith(this.ensureAgentHandle(name));
          return;
        }
        if (event.kind === 'agent_exited' && event.name === name) {
          rejectWith(new Error(`Agent '${name}' exited before sending its first relay message`));
          return;
        }
        if (event.kind === 'agent_released' && event.name === name) {
          rejectWith(new Error(`Agent '${name}' was released before sending its first relay message`));
        }
      });

      timeout = setTimeout(() => {
        rejectWith(
          new Error(`Timed out waiting for first relay message from '${name}' after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      const known = this.knownAgents.get(name);
      if (known && this.messageReadyAgents.has(name)) {
        resolveWith(known);
      }
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.unsubEvent) {
      this.unsubEvent();
      this.unsubEvent = undefined;
    }
    let client = this.client;
    if (!client && this.startPromise) {
      try {
        client = await this.startPromise;
      } catch {
        client = undefined;
      }
    }
    if (client) {
      await client.shutdown();
      if (this.client === client) {
        this.client = undefined;
      }
    }
    this.startPromise = undefined;
    this.knownAgents.clear();
    this.readyAgents.clear();
    this.messageReadyAgents.clear();
    this.exitedAgents.clear();
    this.idleAgents.clear();
    this.deliveryStates.clear();
    this.outputListeners.clear();
    for (const entry of this.exitResolvers.values()) {
      entry.resolve('released');
    }
    this.exitResolvers.clear();
    for (const entry of this.idleResolvers.values()) {
      entry.resolve('exited');
    }
    this.idleResolvers.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private ensureAgentHandle(name: string, runtime: AgentRuntime = 'pty', channels: string[] = []): Agent {
    const existing = this.knownAgents.get(name);
    if (existing) {
      return existing;
    }
    const agent = this.makeAgent(name, runtime, channels);
    this.knownAgents.set(name, agent);
    return agent;
  }

  private updateDeliveryState(
    eventId: string,
    to: string,
    status: DeliveryStateStatus,
    updatedAt: number
  ): void {
    this.deliveryStates.set(eventId, { eventId, to, status, updatedAt });
  }

  private resolveEventTimestamp(candidate?: unknown): number {
    return typeof candidate === 'number' ? candidate : Date.now();
  }

  private addAgentChannels(name: string, channels: string[]): void {
    const agent = this.knownAgents.get(name) as InternalAgent | undefined;
    if (!agent || channels.length === 0) return;
    const next = [...new Set([...agent.channels, ...channels])];
    agent._setChannels(next);
  }

  private removeAgentChannels(name: string, channels: string[]): void {
    const agent = this.knownAgents.get(name) as InternalAgent | undefined;
    if (!agent || channels.length === 0) return;
    const removed = new Set(channels);
    agent._setChannels(agent.channels.filter((channel) => !removed.has(channel)));
  }

  /** Resolve a target to a channel name. If `to` is `#channel`, use that
   *  channel. If it's a known agent name, use the agent's first channel.
   *  Otherwise fall back to the relay's default channel. */
  private resolveChannel(to: string): string {
    if (to.startsWith('#')) return to.slice(1);
    const agent = this.knownAgents.get(to);
    if (agent && agent.channels.length > 0) return agent.channels[0];
    return this.defaultChannels[0];
  }

  private inferOutputMode(callback: AgentOutputCallback): 'chunk' | 'structured' {
    const source = callback.toString().trim().replace(/\s+/g, ' ');
    if (source.startsWith('({') || source.startsWith('async ({') || source.startsWith('function ({')) {
      return 'structured';
    }
    return 'chunk';
  }

  private dispatchOutput(name: string, stream: string, chunk: string): void {
    const listeners = this.outputListeners.get(name);
    if (!listeners) return;
    for (const listener of listeners) {
      if (listener.stream !== undefined && listener.stream !== stream) continue;
      if (listener.mode === 'structured') {
        (listener.callback as (data: AgentOutputPayload) => void)({ stream, chunk });
      } else {
        (listener.callback as (chunk: string) => void)(chunk);
      }
    }
  }

  /**
   * Ensure a Relaycast workspace API key is available.
   * Resolution order:
   *   1. Already resolved (cached from a previous call)
   *   2. RELAY_API_KEY in options.env
   *   3. RELAY_API_KEY in process.env
   *   4. Auto-create a fresh workspace via the Relaycast REST API
   */
  private async ensureRelaycastApiKey(): Promise<void> {
    if (this.relayApiKey) {
      const workspaceId = this.getResolvedWorkspaceId();
      if (workspaceId) {
        this.applyWorkspaceEnv(workspaceId, this.relayApiKey);
        try { this.persistWorkspaceMapping(workspaceId, this.relayApiKey); } catch { /* non-critical */ }
      } else {
        this.wireRelaycastBaseUrl();
      }
      return;
    }

    const envKey = this.clientOptions.env?.RELAY_API_KEY ?? process.env.RELAY_API_KEY;
    const requestedWorkspaceId = this.requestedWorkspaceId;
    if (requestedWorkspaceId) {
      const registry = this.readWorkspaceRegistry();
      const mappedKey = registry[requestedWorkspaceId]?.relaycastApiKey;
      const resolvedKey =
        mappedKey ?? envKey ?? (await this.createMappedRelaycastWorkspace(requestedWorkspaceId));
      this.relayApiKey = resolvedKey;
      this.resolvedWorkspaceId = requestedWorkspaceId;
      this.applyWorkspaceEnv(requestedWorkspaceId, resolvedKey);
      try { this.persistWorkspaceMapping(requestedWorkspaceId, resolvedKey); } catch { /* non-critical */ }
      return;
    }

    const resolvedWorkspaceId = envKey
      ? (this.findMappedWorkspaceIdByApiKey(envKey) ?? generateWorkspaceId())
      : generateWorkspaceId();
    const resolvedKey = envKey ?? (await this.createMappedRelaycastWorkspace(resolvedWorkspaceId));

    this.relayApiKey = resolvedKey;
    this.resolvedWorkspaceId = resolvedWorkspaceId;
    this.applyWorkspaceEnv(resolvedWorkspaceId, resolvedKey);
    try { this.persistWorkspaceMapping(resolvedWorkspaceId, resolvedKey); } catch { /* non-critical */ }
  }

  /** Inject relaycastBaseUrl into broker env. Explicit option wins over inherited env. */
  private wireRelaycastBaseUrl(): void {
    if (this.relaycastBaseUrl && this.clientOptions.env) {
      this.clientOptions.env.RELAYCAST_BASE_URL = this.relaycastBaseUrl;
    }
  }

  private humanRegistrationKey(name: string, kind: HumanIdentityKind): string {
    return `${kind}:${name}`;
  }

  private normalizeHumanRequestedName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new HumanRegistrationError(name, 'Human registration requires a non-empty name.');
    }
    return normalized;
  }

  private async ensureHumanRegistered(name: string, kind: HumanIdentityKind): Promise<string> {
    const stateKey = this.humanRegistrationKey(name, kind);
    const existing = this.humanRegistrations.get(stateKey);
    if (existing?.canonicalName) {
      return existing.canonicalName;
    }
    if (existing?.pending) {
      return existing.pending;
    }

    const state = existing ?? {};
    const pending = (async () => {
      try {
        await this.ensureStarted();
        if (!this.relayApiKey) {
          throw new HumanRegistrationError(
            name,
            `Failed to register human identity "${name}": no Relaycast workspace key is available.`
          );
        }

        const relaycast = new RelayCast({
          apiKey: this.relayApiKey,
          ...(this.relaycastBaseUrl ? { baseUrl: this.relaycastBaseUrl } : {}),
        });

        const registration =
          kind === 'system'
            ? await relaycast.system({ name })
            : await relaycast.agents.registerAgent({ name, type: 'human', strict: false });
        state.canonicalName = registration.name;
        return registration.name;
      } catch (error) {
        if (error instanceof HumanRegistrationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new HumanRegistrationError(
          name,
          `Failed to register human identity "${name}": ${message}`,
          error
        );
      } finally {
        state.pending = undefined;
      }
    })();

    state.pending = pending;
    this.humanRegistrations.set(stateKey, state);
    return pending;
  }

  private async ensureStarted(): Promise<AgentRelayClient> {
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.ensureRelaycastApiKey()
      .then(() =>
        AgentRelayClient.spawn({
          ...this.clientOptions,
          onStderr: (line) => {
            for (const listener of this.stderrListeners) {
              try {
                listener(line);
              } catch {
                /* ignore */
              }
            }
          },
        })
      )
      .then((c) => {
        // Use the workspace key the broker actually connected with.
        // This ensures SDK and workers are always on the same workspace.
        if (c.workspaceKey) {
          this.relayApiKey = c.workspaceKey;
          const workspaceId = this.getResolvedWorkspaceId();
          if (workspaceId) {
            this.applyWorkspaceEnv(workspaceId, c.workspaceKey);
            try { this.persistWorkspaceMapping(workspaceId, c.workspaceKey); } catch { /* non-critical */ }
          }
        }
        this.wireEvents(c);
        this.client = c;
        this.startPromise = undefined;
        return c;
      })
      .catch((err) => {
        this.client = undefined;
        this.startPromise = undefined;
        throw err;
      });

    return this.startPromise;
  }

  private wireEvents(client: AgentRelayClient): void {
    // eslint-disable-next-line complexity
    this.unsubEvent = client.onEvent((event: BrokerEvent) => {
      switch (event.kind) {
        case 'relay_inbound': {
          if (this.knownAgents.has(event.from)) {
            this.messageReadyAgents.add(event.from);
            this.exitedAgents.delete(event.from);
          }
          const msg: Message = {
            eventId: event.event_id,
            from: event.from,
            to: event.target,
            text: event.body,
            threadId: event.thread_id,
            mode: event.injection_mode ?? event.mode,
          };
          this.onMessageReceived?.(msg);
          break;
        }
        case 'agent_spawned': {
          const agent = this.ensureAgentHandle(event.name, event.runtime);
          this.readyAgents.delete(event.name);
          this.messageReadyAgents.delete(event.name);
          this.exitedAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          this.onAgentSpawned?.(agent);
          break;
        }
        case 'agent_released': {
          const agent = this.knownAgents.get(event.name) ?? this.ensureAgentHandle(event.name, 'pty', []);
          this.exitedAgents.add(event.name);
          this.readyAgents.delete(event.name);
          this.messageReadyAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          this.onAgentReleased?.(agent);
          this.knownAgents.delete(event.name);
          this.outputListeners.delete(event.name);
          this.exitResolvers.get(event.name)?.resolve('released');
          this.exitResolvers.delete(event.name);
          this.idleResolvers.get(event.name)?.resolve('exited');
          this.idleResolvers.delete(event.name);
          break;
        }
        case 'agent_exited': {
          const agent = this.knownAgents.get(event.name) ?? this.ensureAgentHandle(event.name, 'pty', []);
          this.exitedAgents.add(event.name);
          this.readyAgents.delete(event.name);
          this.messageReadyAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          // Populate exit info before firing the hook
          (agent as { exitCode?: number }).exitCode = event.code;
          (agent as { exitSignal?: string }).exitSignal = event.signal;
          this.onAgentExited?.(agent);
          this.knownAgents.delete(event.name);
          this.outputListeners.delete(event.name);
          this.exitResolvers.get(event.name)?.resolve('exited');
          this.exitResolvers.delete(event.name);
          this.idleResolvers.get(event.name)?.resolve('exited');
          this.idleResolvers.delete(event.name);
          break;
        }
        case 'agent_exit': {
          const agent = this.knownAgents.get(event.name) ?? this.ensureAgentHandle(event.name, 'pty', []);
          (agent as { exitReason?: string }).exitReason = event.reason;
          this.onAgentExitRequested?.({ name: event.name, reason: event.reason });
          break;
        }
        case 'worker_ready': {
          const agent = this.ensureAgentHandle(event.name, event.runtime);
          this.readyAgents.add(event.name);
          this.exitedAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          this.onAgentReady?.(agent);
          break;
        }
        case 'channel_subscribed': {
          this.addAgentChannels(event.name, event.channels);
          this.onChannelSubscribed?.(event.name, event.channels);
          break;
        }
        case 'channel_unsubscribed': {
          this.removeAgentChannels(event.name, event.channels);
          this.onChannelUnsubscribed?.(event.name, event.channels);
          break;
        }
        case 'delivery_queued': {
          this.updateDeliveryState(
            event.event_id,
            event.name,
            'queued',
            this.resolveEventTimestamp(event.timestamp)
          );
          break;
        }
        case 'delivery_injected': {
          this.updateDeliveryState(
            event.event_id,
            event.name,
            'injected',
            this.resolveEventTimestamp(event.timestamp)
          );
          break;
        }
        case 'delivery_active': {
          this.updateDeliveryState(event.event_id, event.name, 'active', this.resolveEventTimestamp());
          break;
        }
        case 'delivery_verified': {
          this.updateDeliveryState(event.event_id, event.name, 'verified', this.resolveEventTimestamp());
          break;
        }
        case 'delivery_failed': {
          this.updateDeliveryState(event.event_id, event.name, 'failed', this.resolveEventTimestamp());
          break;
        }
        case 'worker_stream': {
          // Agent producing output is no longer idle
          this.idleAgents.delete(event.name);
          this.onWorkerOutput?.({
            name: event.name,
            stream: event.stream,
            chunk: event.chunk,
          });
          // Dispatch to per-agent output listeners
          this.dispatchOutput(event.name, event.stream, event.chunk);
          break;
        }
        case 'agent_idle': {
          this.idleAgents.add(event.name);
          this.onAgentIdle?.({
            name: event.name,
            idleSecs: event.idle_secs,
          });
          // Resolve idle waiters
          this.idleResolvers.get(event.name)?.resolve('idle');
          this.idleResolvers.delete(event.name);
          break;
        }
      }
      if (event.kind.startsWith('delivery_')) {
        this.onDeliveryUpdate?.(event);
      }
    });
  }

  private makeAgent(name: string, runtime: AgentRuntime, channels: string[]): Agent {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const relay = this;
    let agentChannels = [...channels];
    const agent: InternalAgent = {
      name,
      runtime,
      get channels() {
        return [...agentChannels];
      },
      get status(): AgentStatus {
        if (relay.exitedAgents.has(name)) return 'exited';
        if (relay.idleAgents.has(name)) return 'idle';
        if (relay.readyAgents.has(name)) return 'ready';
        return 'spawning';
      },
      exitCode: undefined,
      exitSignal: undefined,
      async release(reasonOrOptions?: string | ReleaseOptions) {
        const releaseOptions = relay.normalizeReleaseOptions(reasonOrOptions);
        const releaseContext: ReleaseLifecycleContext = {
          name,
          reason: releaseOptions.reason,
        };
        if (!relay.knownAgents.has(name)) {
          await relay.invokeLifecycleHook(
            releaseOptions.onStart,
            releaseContext,
            `release("${name}") onStart`
          );
          await relay.invokeLifecycleHook(
            releaseOptions.onSuccess,
            releaseContext,
            `release("${name}") onSuccess`
          );
          return;
        }
        const client = await relay.ensureStarted();
        await relay.invokeLifecycleHook(releaseOptions.onStart, releaseContext, `release("${name}") onStart`);
        try {
          await client.release(name, releaseOptions.reason);
          await relay.invokeLifecycleHook(
            releaseOptions.onSuccess,
            releaseContext,
            `release("${name}") onSuccess`
          );
        } catch (error) {
          if (error instanceof AgentRelayProtocolError && error.code === 'agent_not_found') {
            relay.exitedAgents.add(name);
            relay.readyAgents.delete(name);
            relay.messageReadyAgents.delete(name);
            relay.idleAgents.delete(name);
            relay.knownAgents.delete(name);
            relay.outputListeners.delete(name);
            relay.exitResolvers.get(name)?.resolve('released');
            relay.exitResolvers.delete(name);
            relay.idleResolvers.get(name)?.resolve('exited');
            relay.idleResolvers.delete(name);
            await relay.invokeLifecycleHook(
              releaseOptions.onSuccess,
              releaseContext,
              `release("${name}") onSuccess`
            );
            return;
          }
          await relay.invokeLifecycleHook(
            releaseOptions.onError,
            {
              ...releaseContext,
              error,
            },
            `release("${name}") onError`
          );
          throw error;
        }
      },
      async waitForReady(timeoutMs = 60_000) {
        await relay.waitForAgentReady(name, timeoutMs);
      },
      waitForExit(timeoutMs?: number) {
        return new Promise<'exited' | 'timeout' | 'released'>((resolve) => {
          // If already gone, resolve immediately
          if (!relay.knownAgents.has(name)) {
            resolve('exited');
            return;
          }
          // Non-blocking poll: timeoutMs === 0 means "check now, return immediately"
          if (timeoutMs === 0) {
            resolve('timeout');
            return;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const token = ++relay.exitResolverSeq;
          relay.exitResolvers.set(name, {
            resolve(reason) {
              if (timer) clearTimeout(timer);
              resolve(reason);
            },
            token,
          });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              // Only delete if this is still our resolver (not one from a later call)
              const current = relay.exitResolvers.get(name);
              if (current?.token === token) {
                relay.exitResolvers.delete(name);
              }
              resolve('timeout');
            }, timeoutMs);
          }
        });
      },
      waitForIdle(timeoutMs?: number) {
        return new Promise<'idle' | 'timeout' | 'exited'>((resolve) => {
          if (!relay.knownAgents.has(name)) {
            resolve('exited');
            return;
          }
          if (timeoutMs === 0) {
            resolve('timeout');
            return;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const token = ++relay.idleResolverSeq;
          relay.idleResolvers.set(name, {
            resolve(reason) {
              if (timer) clearTimeout(timer);
              resolve(reason);
            },
            token,
          });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              const current = relay.idleResolvers.get(name);
              if (current?.token === token) {
                relay.idleResolvers.delete(name);
              }
              resolve('timeout');
            }, timeoutMs);
          }
        });
      },
      async sendMessage(input) {
        const client = await relay.ensureStarted();
        let result: Awaited<ReturnType<typeof client.sendMessage>>;
        try {
          result = await client.sendMessage({
            to: input.to,
            text: input.text,
            from: name,
            threadId: input.threadId,
            priority: input.priority,
            data: input.data,
            mode: input.mode,
          });
        } catch (error) {
          if (isUnsupportedOperation(error)) {
            return buildUnsupportedOperationMessage(name, input);
          }
          throw error;
        }
        if (result?.event_id === 'unsupported_operation') {
          return buildUnsupportedOperationMessage(name, input);
        }
        const eventId = result?.event_id ?? randomBytes(8).toString('hex');
        const msg: Message = {
          eventId,
          from: name,
          to: input.to,
          text: input.text,
          threadId: input.threadId,
          data: input.data,
          mode: input.mode,
        };
        relay.onMessageSent?.(msg);
        return msg;
      },
      async subscribe(channelsToAdd: string[]) {
        await relay.subscribe({ agent: name, channels: channelsToAdd });
      },
      async unsubscribe(channelsToRemove: string[]) {
        await relay.unsubscribe({ agent: name, channels: channelsToRemove });
      },
      onOutput(
        callback: AgentOutputCallback,
        options?: { stream?: string; mode?: 'chunk' | 'structured' }
      ): () => void {
        let listeners = relay.outputListeners.get(name);
        if (!listeners) {
          listeners = new Set();
          relay.outputListeners.set(name, listeners);
        }
        const listener: OutputListener = {
          callback,
          mode: options?.mode ?? relay.inferOutputMode(callback),
          stream: options?.stream,
        };
        listeners.add(listener);
        return () => {
          listeners!.delete(listener);
          if (listeners!.size === 0) {
            relay.outputListeners.delete(name);
          }
        };
      },
      _setChannels(nextChannels: string[]) {
        agentChannels = [...nextChannels];
      },
    };
    return agent;
  }

  private createSpawner(cli: string, defaultName: string, runtime: AgentRuntime): AgentSpawner {
    return {
      spawn: async (options?) => {
        const name = options?.name ?? defaultName;
        const channels = options?.channels ?? ['general'];
        const args = options?.args ?? [];

        const task = options?.task;
        if (runtime === 'pty') {
          return this.spawnPty({
            name,
            cli,
            args,
            channels,
            task,
            model: options?.model,
            cwd: options?.cwd,
            skipRelayPrompt: options?.skipRelayPrompt,
            onStart: options?.onStart,
            onSuccess: options?.onSuccess,
            onError: options?.onError,
          });
        }

        const client = await this.ensureStarted();
        const lifecycleContext: SpawnLifecycleContext = {
          name,
          cli,
          channels,
          task,
        };
        await this.invokeLifecycleHook(options?.onStart, lifecycleContext, `spawn("${name}") onStart`);
        let result: { name: string; runtime: AgentRuntime };
        try {
          result = await client.spawnProvider({
            name,
            provider: cli as HeadlessProvider,
            transport: 'headless',
            args,
            channels,
            task,
            skipRelayPrompt: options?.skipRelayPrompt,
          });
        } catch (error) {
          await this.invokeLifecycleHook(
            options?.onError,
            {
              ...lifecycleContext,
              error,
            },
            `spawn("${name}") onError`
          );
          throw error;
        }

        this.resetAgentLifecycleState(result.name);
        const agent = this.makeAgent(result.name, result.runtime, channels);
        this.knownAgents.set(agent.name, agent);
        await this.invokeLifecycleHook(
          options?.onSuccess,
          {
            ...lifecycleContext,
            name: result.name,
            runtime: result.runtime,
          },
          `spawn("${name}") onSuccess`
        );
        return agent;
      },
    };
  }

  private async invokeLifecycleHook<T>(
    hook: ((context: T) => void | Promise<void>) | undefined,
    context: T,
    label: string
  ): Promise<void> {
    if (!hook) {
      return;
    }
    try {
      await hook(context);
    } catch (error) {
      console.warn(`[AgentRelay] ${label} hook threw`, error);
    }
  }

  private resetAgentLifecycleState(name: string): void {
    this.readyAgents.delete(name);
    this.messageReadyAgents.delete(name);
    this.exitedAgents.delete(name);
    this.idleAgents.delete(name);
  }

  private normalizeReleaseOptions(reasonOrOptions?: string | ReleaseOptions): ReleaseOptions {
    if (typeof reasonOrOptions === 'string' || reasonOrOptions === undefined) {
      return { reason: reasonOrOptions };
    }
    return reasonOrOptions;
  }
}
