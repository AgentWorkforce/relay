import { Relay } from '../core.js';
import { formatRelayMessage, type Message } from '../types.js';
import {
  CodexJsonRpcClient,
  type CodexInitializeOptions,
  type CodexInitializeResponse,
  type CodexJsonRpcNotification,
  type JsonObject,
  type JsonValue,
  spawnCodexAppServer,
} from './codex-jsonrpc.js';

export const MINIMUM_CODEX_APP_SERVER_VERSION = '0.124.0';

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export type CodexMcpServerConfig = JsonObject & {
  command: string;
  args?: string[];
};

export interface CodexAdapterOptions {
  /** Discriminator for the top-level communicate onRelay() auto-detect helper. */
  framework?: 'codex';
  cwd?: string;
  model?: string;
  modelProvider?: string;
  serviceTier?: JsonValue;
  approvalPolicy?: JsonValue;
  approvalsReviewer?: JsonValue;
  sandbox?: JsonValue;
  permissionProfile?: JsonValue;
  config?: JsonObject;
  serviceName?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  personality?: JsonValue;
  ephemeral?: boolean;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  resumeThreadId?: string;
  resumePath?: string;
  excludeTurns?: boolean;

  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  experimentalApi?: boolean;
  minimumCodexVersion?: string | false;

  ensureRelaycastMcp?: boolean;
  relaycastMcpServer?: CodexMcpServerConfig;

  clientFactory?: () => CodexJsonRpcClientLike;
  clientInfo?: CodexInitializeOptions['clientInfo'];
  notificationOptOutMethods?: string[];
  onNotification?: (notification: CodexJsonRpcNotification) => void | Promise<void>;
}

export interface CodexForkOptions extends Omit<
  CodexAdapterOptions,
  'clientFactory' | 'framework' | 'resumeThreadId' | 'resumePath'
> {
  name?: string;
  relay?: RelayLike;
}

export interface CodexJsonRpcClientLike {
  initialize(options?: CodexInitializeOptions): Promise<CodexInitializeResponse>;
  request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  onNotification(listener: (notification: CodexJsonRpcNotification) => void | Promise<void>): () => void;
  close(): Promise<void>;
}

export interface CodexTurn {
  id: string;
  status?: string;
}

export interface CodexThread {
  id: string;
}

export interface CodexThreadStartResponse {
  thread: CodexThread;
}

export interface CodexTurnStartResponse {
  turn: CodexTurn;
}

export interface CodexTurnSteerResponse {
  [key: string]: unknown;
}

export interface CodexTurnInterruptResponse {
  [key: string]: unknown;
}

export interface CodexHandle {
  readonly name: string;
  readonly ready: Promise<void>;
  readonly threadId: string | undefined;
  readonly currentTurnId: string | undefined;

  send(text: string): Promise<CodexTurnStartResponse>;
  steer(text: string): Promise<CodexTurnSteerResponse>;
  interrupt(): Promise<CodexTurnInterruptResponse | undefined>;
  fork(options?: CodexForkOptions): Promise<CodexHandle>;
  close(): Promise<void>;
  onNotification(listener: (notification: CodexJsonRpcNotification) => void | Promise<void>): () => void;
}

type RelayLike = {
  inbox(): Promise<Message[]>;
};

type ListMcpServerStatusResponse = {
  data: Array<{ name: string }>;
  nextCursor?: string | null;
};

type CodexThreadResponse = {
  thread: CodexThread;
};

type CodexNotificationParams = {
  threadId?: string;
  turnId?: string;
  turn?: CodexTurn;
};

type CodexHandleState = {
  sharedClient?: SharedCodexJsonRpcClient;
  client?: CodexJsonRpcClientLike;
  ownsClient?: boolean;
  threadId?: string;
  ready?: Promise<void>;
  autoStart?: boolean;
};

type SharedCodexJsonRpcClient = {
  client: CodexJsonRpcClientLike;
  ownsClient: boolean;
  references: number;
};

const DEFAULT_RELAYCAST_MCP_SERVER: CodexMcpServerConfig = {
  command: 'agent-relay',
  args: ['mcp'],
};

function textInput(text: string): CodexUserInput {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function threadOverrides(options: CodexAdapterOptions | CodexForkOptions): Record<string, unknown> {
  return pruneUndefined({
    model: options.model,
    modelProvider: options.modelProvider,
    serviceTier: options.serviceTier,
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy,
    approvalsReviewer: options.approvalsReviewer,
    sandbox: options.sandbox,
    permissionProfile: options.permissionProfile,
    config: options.config,
    baseInstructions: options.baseInstructions,
    developerInstructions: options.developerInstructions,
    personality: options.personality,
  });
}

function buildThreadStartParams(options: CodexAdapterOptions): Record<string, unknown> {
  return pruneUndefined({
    ...threadOverrides(options),
    serviceName: options.serviceName,
    ephemeral: options.ephemeral,
    experimentalRawEvents: options.experimentalRawEvents ?? false,
    persistExtendedHistory: options.persistExtendedHistory ?? true,
  });
}

function buildThreadResumeParams(options: CodexAdapterOptions): Record<string, unknown> {
  return pruneUndefined({
    ...threadOverrides(options),
    threadId: options.resumeThreadId,
    path: options.resumePath,
    excludeTurns: options.excludeTurns ?? true,
    persistExtendedHistory: options.persistExtendedHistory ?? true,
  });
}

function buildThreadForkParams(threadId: string, options: CodexForkOptions): Record<string, unknown> {
  return pruneUndefined({
    ...threadOverrides(options),
    threadId,
    ephemeral: options.ephemeral ?? true,
    excludeTurns: options.excludeTurns ?? true,
    persistExtendedHistory: options.persistExtendedHistory ?? true,
  });
}

async function drainInbox(relay: RelayLike): Promise<string | undefined> {
  const messages = await relay.inbox();
  if (messages.length === 0) {
    return undefined;
  }

  return `New messages from other agents:\n${messages.map((message) => formatRelayMessage(message)).join('\n')}`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function extractVersion(userAgent: string): string | undefined {
  return userAgent.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
}

export function assertMinimumCodexVersion(userAgent: string, minimumVersion: string | false): void {
  if (minimumVersion === false) {
    return;
  }

  const detected = extractVersion(userAgent);
  if (!detected) {
    throw new Error(`Could not determine codex app-server version from userAgent: ${userAgent}`);
  }

  if (compareVersions(detected, minimumVersion) < 0) {
    throw new Error(
      `codex app-server ${detected} is older than the supported minimum ${minimumVersion}. ` +
        'Upgrade Codex before using the communicate adapter.'
    );
  }
}

function createDefaultClient(options: CodexAdapterOptions): CodexJsonRpcClientLike {
  return new CodexJsonRpcClient(
    spawnCodexAppServer({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    }),
    {
      requestTimeoutMs: options.requestTimeoutMs,
    }
  );
}

export class CodexRelayHandle implements CodexHandle {
  readonly ready: Promise<void>;

  private readonly client: CodexJsonRpcClientLike;
  private readonly sharedClient: SharedCodexJsonRpcClient;
  private readonly unsubscribeClientNotifications: () => void;
  private readonly notificationListeners = new Set<
    (notification: CodexJsonRpcNotification) => void | Promise<void>
  >();

  private activeTurnId: string | undefined;
  private nextTurnPrefix: string | undefined;
  private inboxQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private currentThreadId: string | undefined;

  constructor(
    readonly name: string,
    private readonly options: CodexAdapterOptions,
    private readonly relay: RelayLike,
    state: CodexHandleState = {}
  ) {
    if (state.sharedClient) {
      this.sharedClient = state.sharedClient;
      this.sharedClient.references += 1;
    } else {
      const client = state.client ?? options.clientFactory?.() ?? createDefaultClient(options);
      this.sharedClient = {
        client,
        ownsClient: state.ownsClient ?? !state.client,
        references: 1,
      };
    }

    this.client = this.sharedClient.client;
    this.currentThreadId = state.threadId;
    this.unsubscribeClientNotifications = this.client.onNotification((notification) =>
      this.handleNotification(notification)
    );

    if (state.ready) {
      this.ready = state.ready;
    } else if (state.autoStart === false) {
      this.ready = Promise.resolve();
    } else {
      this.ready = this.start();
    }
  }

  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  get currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  async send(text: string): Promise<CodexTurnStartResponse> {
    const threadId = await this.requireThreadId();
    const prompt = this.consumeNextTurnPrefix(text);
    const response = await this.client.request<CodexTurnStartResponse>('turn/start', {
      threadId,
      input: [textInput(prompt)],
    });

    this.activeTurnId = response.turn.id;
    return response;
  }

  async steer(text: string): Promise<CodexTurnSteerResponse> {
    const threadId = await this.requireThreadId();
    if (!this.activeTurnId) {
      throw new Error(`Cannot steer Codex thread ${threadId}; there is no active turn.`);
    }

    return this.client.request<CodexTurnSteerResponse>('turn/steer', {
      threadId,
      input: [textInput(text)],
      expectedTurnId: this.activeTurnId,
    });
  }

  async interrupt(): Promise<CodexTurnInterruptResponse | undefined> {
    const threadId = await this.requireThreadId();
    if (!this.activeTurnId) {
      return undefined;
    }

    const turnId = this.activeTurnId;
    this.activeTurnId = undefined;
    return this.client.request<CodexTurnInterruptResponse>('turn/interrupt', {
      threadId,
      turnId,
    });
  }

  async fork(options: CodexForkOptions = {}): Promise<CodexHandle> {
    const sourceThreadId = await this.requireThreadId();
    const response = await this.client.request<CodexThreadResponse>(
      'thread/fork',
      buildThreadForkParams(sourceThreadId, options)
    );
    const forkName = options.name ?? this.name;
    const forkRelay = options.relay ?? new Relay(forkName);

    return new CodexRelayHandle(
      forkName,
      {
        ...this.options,
        ...options,
        clientFactory: undefined,
        framework: 'codex',
      },
      forkRelay,
      {
        sharedClient: this.sharedClient,
        threadId: response.thread.id,
        autoStart: false,
      }
    );
  }

  onNotification(listener: (notification: CodexJsonRpcNotification) => void | Promise<void>): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribeClientNotifications();
    await this.ready.catch(() => undefined);

    if (this.currentThreadId) {
      await this.client
        .request('thread/unsubscribe', { threadId: this.currentThreadId })
        .catch(() => undefined);
    }

    this.sharedClient.references -= 1;
    if (this.sharedClient.ownsClient && this.sharedClient.references === 0) {
      await this.client.close();
    }
  }

  private async start(): Promise<void> {
    const initializeResponse = await this.client.initialize({
      clientInfo: this.options.clientInfo,
      capabilities: {
        experimentalApi: this.options.experimentalApi ?? false,
        optOutNotificationMethods: this.options.notificationOptOutMethods ?? null,
      },
      timeoutMs: this.options.initializeTimeoutMs,
    });
    assertMinimumCodexVersion(
      initializeResponse.userAgent,
      this.options.minimumCodexVersion ?? MINIMUM_CODEX_APP_SERVER_VERSION
    );

    if (this.options.ensureRelaycastMcp !== false) {
      await this.ensureRelaycastMcp();
    }

    const response =
      this.options.resumeThreadId || this.options.resumePath
        ? await this.client.request<CodexThreadResponse>(
            'thread/resume',
            buildThreadResumeParams(this.options)
          )
        : await this.client.request<CodexThreadStartResponse>(
            'thread/start',
            buildThreadStartParams(this.options)
          );

    this.currentThreadId = response.thread.id;
  }

  private async requireThreadId(): Promise<string> {
    await this.ready;
    if (!this.currentThreadId) {
      throw new Error('Codex thread is not ready.');
    }
    return this.currentThreadId;
  }

  private consumeNextTurnPrefix(text: string): string {
    if (!this.nextTurnPrefix) {
      return text;
    }

    const prefix = this.nextTurnPrefix;
    this.nextTurnPrefix = undefined;
    return `${prefix}\n\n${text}`;
  }

  private appendNextTurnPrefix(text: string): void {
    this.nextTurnPrefix = this.nextTurnPrefix ? `${this.nextTurnPrefix}\n\n${text}` : text;
  }

  private async ensureRelaycastMcp(): Promise<void> {
    let cursor: string | undefined;
    do {
      const response = await this.client.request<ListMcpServerStatusResponse>('mcpServerStatus/list', {
        cursor,
        detail: 'toolsAndAuthOnly',
      });
      if (response.data.some((server) => server.name === 'relaycast')) {
        return;
      }
      cursor = response.nextCursor ?? undefined;
    } while (cursor);

    await this.client.request('config/value/write', {
      keyPath: 'mcp_servers.relaycast',
      value: this.options.relaycastMcpServer ?? DEFAULT_RELAYCAST_MCP_SERVER,
      mergeStrategy: 'upsert',
    });
    await this.client.request('config/mcpServer/reload');
  }

  private enqueueInboxTask(task: () => Promise<void>): Promise<void> {
    this.inboxQueue = this.inboxQueue.then(task, task);
    return this.inboxQueue;
  }

  private async flushInboxToActiveTurn(): Promise<void> {
    await this.enqueueInboxTask(async () => {
      if (!this.currentThreadId || !this.activeTurnId) {
        return;
      }

      const prompt = await drainInbox(this.relay);
      if (!prompt) {
        return;
      }

      const expectedTurnId = this.activeTurnId;
      try {
        await this.client.request('turn/steer', {
          threadId: this.currentThreadId,
          input: [textInput(prompt)],
          expectedTurnId,
        });
      } catch (error) {
        this.appendNextTurnPrefix(prompt);
        process.emitWarning(
          `Could not steer Codex turn with relay messages: ${error instanceof Error ? error.message : String(error)}`,
          'CodexRelayWarning'
        );
      }
    });
  }

  private async flushInboxToNextTurn(): Promise<void> {
    await this.enqueueInboxTask(async () => {
      const prompt = await drainInbox(this.relay);
      if (prompt) {
        this.appendNextTurnPrefix(prompt);
      }
    });
  }

  private async handleNotification(notification: CodexJsonRpcNotification): Promise<void> {
    await Promise.resolve(this.options.onNotification?.(notification)).catch((error) => {
      process.emitWarning(
        `Codex onNotification callback failed: ${error instanceof Error ? error.message : String(error)}`,
        'CodexRelayWarning'
      );
    });
    for (const listener of [...this.notificationListeners]) {
      await Promise.resolve(listener(notification)).catch((error) => {
        process.emitWarning(
          `Codex notification listener failed: ${error instanceof Error ? error.message : String(error)}`,
          'CodexRelayWarning'
        );
      });
    }

    const params = notification.params as CodexNotificationParams | undefined;
    if (!params?.threadId || params.threadId !== this.currentThreadId) {
      return;
    }

    if (notification.method === 'turn/started') {
      this.activeTurnId = params.turn?.id ?? params.turnId ?? this.activeTurnId;
      return;
    }

    if (notification.method === 'item/completed') {
      await this.flushInboxToActiveTurn();
      return;
    }

    if (notification.method === 'turn/completed') {
      if (!params.turn?.id || params.turn.id === this.activeTurnId) {
        this.activeTurnId = undefined;
      }
      await this.flushInboxToNextTurn();
    }
  }
}

/**
 * Attach relay communication to Codex through `codex app-server` JSON-RPC.
 * @param name - Agent name for relay registration.
 * @param options - Codex app-server thread and transport options.
 * @param relay - Optional pre-configured Relay instance.
 * @returns A Codex handle with ready/send/steer/interrupt/fork/close methods.
 */
export function onRelay(
  name: string,
  options: CodexAdapterOptions = {},
  relay: RelayLike = new Relay(name)
): CodexHandle {
  return new CodexRelayHandle(name, options, relay);
}
