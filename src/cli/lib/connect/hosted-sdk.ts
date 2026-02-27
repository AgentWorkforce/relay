import { AgentRelay, RelayCast } from '@agent-relay/sdk';

export type HostedControlCommand =
  | HostedSpawnCommand
  | HostedReleaseCommand
  | HostedMessageCommand
  | HostedStatusCommand
  | HostedPingCommand;

export interface HostedSpawnCommand {
  type: 'spawn';
  name: string;
  cli: string;
  task?: string;
  model?: string;
  cwd?: string;
  channels?: string[];
  transport?: string;
  spawner?: string;
}

export interface HostedReleaseCommand {
  type: 'release';
  name: string;
  reason?: string;
}

export interface HostedMessageCommand {
  type: 'message';
  to: string;
  body: string;
  from?: string;
  threadId?: string;
}

export interface HostedStatusCommand {
  type: 'status';
}

export interface HostedPingCommand {
  type: 'ping';
}

interface RelayCastRegistration {
  token: string;
  name: string;
}

interface RelayCastEventMessage {
  text?: string;
  agentName?: string;
}

interface RelayCastMessageEvent {
  channel?: string;
  message?: RelayCastEventMessage;
}

interface RelayCastAgentClient {
  connect(): void;
  disconnect(): Promise<void>;
  subscribe(channels: string[]): void;
  send(channel: string, text: string): Promise<unknown>;
  channels?: {
    create(data: { name: string; topic?: string | null }): Promise<unknown>;
    join(name: string): Promise<unknown>;
  };
  on: {
    connected(handler: () => void): () => void;
    disconnected(handler: () => void): () => void;
    error(handler: () => void): () => void;
    messageCreated(handler: (event: RelayCastMessageEvent) => void): () => void;
  };
}

interface RelayCastLike {
  agents: {
    registerOrRotate(input: {
      name: string;
      type: 'agent';
      metadata?: Record<string, unknown>;
    }): Promise<RelayCastRegistration>;
  };
  as(token: string): RelayCastAgentClient;
}

interface LocalRelayAgent {
  name: string;
  release(reason?: string): Promise<void>;
  waitForReady(timeoutMs?: number): Promise<void>;
}

interface LocalRelayRuntime {
  spawn(
    name: string,
    cli: string,
    task?: string,
    options?: {
      model?: string;
      channels?: string[];
      cwd?: string;
    }
  ): Promise<LocalRelayAgent>;
  sendMessage(input: {
    to: string;
    text: string;
    from?: string;
    threadId?: string;
  }): Promise<unknown>;
  listAgents(): Promise<Array<{ name: string; channels?: string[]; runtime?: string }>>;
  shutdown(): Promise<void>;
}

export interface HostedSdkConnectOptions {
  apiKey: string;
  baseUrl: string;
  agentName: string;
  channel: string;
  cwd: string;
  timeoutMs: number;
  allowedClis: string[];
}

interface ExecuteCommandContext {
  command: HostedControlCommand;
  runtime: LocalRelayRuntime;
  runtimeAgents: Map<string, LocalRelayAgent>;
  controlClient: RelayCastAgentClient;
  controlChannel: string;
  connectorName: string;
  timeoutMs: number;
  allowedClis: Set<string>;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface HostedSdkConnectDeps {
  createRelayCast: (input: { apiKey: string; baseUrl: string }) => RelayCastLike;
  createLocalRuntime: (input: { cwd: string; timeoutMs: number }) => LocalRelayRuntime;
  waitForShutdownSignal: () => Promise<string>;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

function defaultHostedSdkDeps(): HostedSdkConnectDeps {
  return {
    createRelayCast: ({ apiKey, baseUrl }) => new RelayCast({ apiKey, baseUrl }) as RelayCastLike,
    createLocalRuntime: ({ cwd, timeoutMs }) =>
      new AgentRelay({
        cwd,
        requestTimeoutMs: timeoutMs,
      }) as unknown as LocalRelayRuntime,
    waitForShutdownSignal: () =>
      new Promise((resolve) => {
        const cleanup = () => {
          process.off('SIGINT', onSigInt);
          process.off('SIGTERM', onSigTerm);
        };

        const onSigInt = () => {
          cleanup();
          resolve('SIGINT');
        };
        const onSigTerm = () => {
          cleanup();
          resolve('SIGTERM');
        };

        process.on('SIGINT', onSigInt);
        process.on('SIGTERM', onSigTerm);
      }),
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function parseCommandObject(value: unknown): HostedControlCommand | null {
  if (!isObject(value)) {
    return null;
  }

  const type = value.type;
  if (typeof type !== 'string' || type.trim().length === 0) {
    return null;
  }

  if (type === 'spawn') {
    const name = value.name;
    const cli = value.cli;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return null;
    }
    if (typeof cli !== 'string' || cli.trim().length === 0) {
      return null;
    }
    return {
      type: 'spawn',
      name: name.trim(),
      cli: cli.trim(),
      task: typeof value.task === 'string' ? value.task : undefined,
      model: typeof value.model === 'string' ? value.model : undefined,
      cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
      channels: Array.isArray(value.channels)
        ? value.channels.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : undefined,
      transport: typeof value.transport === 'string' ? value.transport : undefined,
      spawner: typeof value.spawner === 'string' ? value.spawner : undefined,
    };
  }

  if (type === 'release') {
    const name = value.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return null;
    }
    return {
      type: 'release',
      name: name.trim(),
      reason: typeof value.reason === 'string' ? value.reason : undefined,
    };
  }

  if (type === 'message') {
    const to = value.to;
    const body = value.body;
    if (typeof to !== 'string' || to.trim().length === 0) {
      return null;
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      return null;
    }
    return {
      type: 'message',
      to: to.trim(),
      body,
      from: typeof value.from === 'string' ? value.from : undefined,
      threadId: typeof value.threadId === 'string' ? value.threadId : undefined,
    };
  }

  if (type === 'status') {
    return { type: 'status' };
  }

  if (type === 'ping') {
    return { type: 'ping' };
  }

  return null;
}

export function parseHostedControlCommand(text: string): HostedControlCommand | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const prefixes = ['/connect ', 'connect:'];
  const matchedPrefix = prefixes.find((prefix) => trimmed.startsWith(prefix));
  const payload = matchedPrefix ? trimmed.slice(matchedPrefix.length).trim() : trimmed;

  const candidates = [payload];
  if (
    payload.includes('\\"') &&
    (payload.startsWith('{\\\"') || payload.includes('\\"type\\"'))
  ) {
    candidates.push(payload.replace(/\\"/g, '"'));
  }

  for (const candidate of candidates) {
    let current = candidate.trim();
    for (let depth = 0; depth < 3; depth += 1) {
      try {
        const parsed = JSON.parse(current) as unknown;
        const command = parseCommandObject(parsed);
        if (command) {
          return command;
        }
        if (typeof parsed === 'string') {
          current = parsed.trim();
          continue;
        }
      } catch {
        // try next candidate
      }
      break;
    }
  }

  return null;
}

async function postControlEvent(
  client: RelayCastAgentClient,
  channel: string,
  event: Record<string, unknown>
): Promise<void> {
  await client.send(channel, `CONNECT_EVENT ${JSON.stringify(event)}`);
}

async function ensureControlChannel(
  client: RelayCastAgentClient,
  channel: string,
  warn: (...args: unknown[]) => void
): Promise<void> {
  if (!client.channels) {
    return;
  }

  try {
    await client.channels.join(channel);
    return;
  } catch (joinError) {
    const message = joinError instanceof Error ? joinError.message : String(joinError);
    const notFoundLike = message.toLowerCase().includes('not found');
    if (!notFoundLike) {
      warn(`[connect] hosted sdk failed to join #${channel}: ${message}`);
      return;
    }
  }

  try {
    await client.channels.create({
      name: channel,
      topic: 'Agent relay hosted control channel',
    });
  } catch (createError) {
    const message = createError instanceof Error ? createError.message : String(createError);
    const conflictLike = message.toLowerCase().includes('already exists');
    if (!conflictLike) {
      warn(`[connect] hosted sdk failed to create #${channel}: ${message}`);
    }
  }

  try {
    await client.channels.join(channel);
  } catch (joinError) {
    const message = joinError instanceof Error ? joinError.message : String(joinError);
    warn(`[connect] hosted sdk failed to join #${channel} after create attempt: ${message}`);
  }
}

export async function executeHostedControlCommand(context: ExecuteCommandContext): Promise<void> {
  const {
    command,
    runtime,
    runtimeAgents,
    controlClient,
    controlChannel,
    connectorName,
    timeoutMs,
    allowedClis,
    log,
    warn,
  } = context;

  if (command.type === 'ping') {
    await postControlEvent(controlClient, controlChannel, {
      type: 'pong',
      from: connectorName,
      ts: new Date().toISOString(),
    });
    return;
  }

  if (command.type === 'status') {
    const agents = await runtime.listAgents();
    await postControlEvent(controlClient, controlChannel, {
      type: 'status',
      from: connectorName,
      agents: agents.map((agent) => ({
        name: agent.name,
        runtime: agent.runtime ?? 'pty',
      })),
    });
    return;
  }

  if (command.type === 'message') {
    await runtime.sendMessage({
      to: command.to,
      text: command.body,
      from: command.from ?? connectorName,
      threadId: command.threadId,
    });

    await postControlEvent(controlClient, controlChannel, {
      type: 'message_dispatched',
      from: connectorName,
      to: command.to,
    });
    return;
  }

  if (command.type === 'release') {
    const existing = runtimeAgents.get(command.name);
    if (!existing) {
      await postControlEvent(controlClient, controlChannel, {
        type: 'release_ignored',
        from: connectorName,
        name: command.name,
        reason: 'not_managed',
      });
      return;
    }

    await existing.release(command.reason ?? 'remote_release');
    runtimeAgents.delete(command.name);
    await postControlEvent(controlClient, controlChannel, {
      type: 'agent_released',
      from: connectorName,
      name: command.name,
    });
    return;
  }

  const requestedCli = command.cli.trim().toLowerCase();
  if (!allowedClis.has(requestedCli)) {
    await postControlEvent(controlClient, controlChannel, {
      type: 'spawn_rejected',
      from: connectorName,
      name: command.name,
      cli: requestedCli,
      reason: 'cli_not_allowed',
    });
    return;
  }

  const transport = command.transport?.trim().toLowerCase();
  if (transport && transport !== 'injection') {
    warn(
      `[connect] hosted sdk path: transport "${transport}" requested for ${command.name}, falling back to injection`
    );
  }

  log(`[connect] hosted sdk path spawning ${command.name} (${requestedCli}) via injection`);

  const worker = await runtime.spawn(command.name, requestedCli, command.task, {
    model: command.model,
    cwd: command.cwd,
    channels: command.channels && command.channels.length > 0 ? command.channels : [controlChannel],
  });
  await worker.waitForReady(timeoutMs);
  runtimeAgents.set(command.name, worker);

  await postControlEvent(controlClient, controlChannel, {
    type: 'agent_connected',
    from: connectorName,
    name: command.name,
    cli: requestedCli,
    spawner: command.spawner ?? null,
    transport: 'injection',
  });
}

export async function runHostedSdkConnect(
  options: HostedSdkConnectOptions,
  overrides: Partial<HostedSdkConnectDeps> = {}
): Promise<void> {
  const deps = {
    ...defaultHostedSdkDeps(),
    ...overrides,
  };

  const runtime = deps.createLocalRuntime({
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
  });
  const runtimeAgents = new Map<string, LocalRelayAgent>();
  const relaycast = deps.createRelayCast({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const registration = await relaycast.agents.registerOrRotate({
    name: options.agentName,
    type: 'agent',
    metadata: {
      source: 'agent-relay-connect',
      path: 'hosted-sdk',
    },
  });
  const controlClient = relaycast.as(registration.token);
  const allowedClis = new Set(
    options.allowedClis.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)
  );

  let queue = Promise.resolve();
  const commandQueue = (operation: () => Promise<void>) => {
    queue = queue
      .then(operation)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.warn(`[connect] hosted sdk command failed: ${message}`);
        await postControlEvent(controlClient, options.channel, {
          type: 'command_failed',
          from: registration.name,
          error: message,
        }).catch(() => undefined);
      });
  };

  controlClient.connect();

  const unsubscribeConnected = controlClient.on.connected(() => {
    void (async () => {
      deps.log(`[connect] hosted sdk connected as ${registration.name}`);
      await ensureControlChannel(controlClient, options.channel, deps.warn);
      controlClient.subscribe([options.channel]);
      await postControlEvent(controlClient, options.channel, {
        type: 'proxy_connected',
        from: registration.name,
        channel: options.channel,
      });
    })();
  });
  const unsubscribeDisconnected = controlClient.on.disconnected(() => {
    deps.warn('[connect] hosted sdk disconnected');
  });
  const unsubscribeError = controlClient.on.error(() => {
    deps.warn('[connect] hosted sdk websocket error');
  });
  const unsubscribeMessages = controlClient.on.messageCreated((event) => {
    const normalizeChannel = (value: string): string => value.replace(/^#/, '').trim().toLowerCase();

    const channel = normalizeChannel(event.channel ?? '');
    const from = event.message?.agentName ?? '';
    const text = event.message?.text ?? '';

    if (channel !== normalizeChannel(options.channel) || !text || from === registration.name) {
      return;
    }

    const command = parseHostedControlCommand(text);
    if (!command) {
      const maybeControl =
        text.trim().startsWith('{') ||
        text.trim().startsWith('/connect') ||
        text.trim().startsWith('connect:') ||
        text.trim().startsWith('"{');
      if (maybeControl) {
        deps.warn(`[connect] hosted sdk ignored unparsable control message: ${text.slice(0, 180)}`);
      }
      return;
    }

    commandQueue(() =>
      executeHostedControlCommand({
        command,
        runtime,
        runtimeAgents,
        controlClient,
        controlChannel: options.channel,
        connectorName: registration.name,
        timeoutMs: options.timeoutMs,
        allowedClis,
        log: deps.log,
        warn: deps.warn,
      })
    );
  });

  try {
    const signal = await deps.waitForShutdownSignal();
    deps.log(`[connect] hosted sdk shutting down on ${signal}`);
  } finally {
    unsubscribeConnected();
    unsubscribeDisconnected();
    unsubscribeError();
    unsubscribeMessages();
    await queue.catch(() => undefined);
    await controlClient.disconnect().catch(() => undefined);
    await runtime.shutdown().catch(() => undefined);
  }
}
