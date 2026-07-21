import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import {
  HarnessDriverClient,
  type BrokerEvent,
  type NativeHarnessCommandAck,
  type NativeHarnessDiagnosticEnvelope,
  type AgentEventEnvelope,
} from '@agent-relay/harness-driver';

import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnection,
} from './broker-connection.js';
import { createBrokerClient } from './attach-broker.js';

export type NativeAttachMode = 'view' | 'drive' | 'passthrough';

export interface NativeAttachOptions {
  brokerUrl?: string;
  apiKey?: string;
  stateDir?: string;
  json?: boolean;
  reasoning?: boolean;
  diagnostics?: boolean;
}

export interface NativeAttachOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export function renderAgentEvent(
  envelope: AgentEventEnvelope,
  options: Pick<NativeAttachOptions, 'json' | 'reasoning'> = {}
): string | null {
  if (envelope.event.kind.startsWith('reasoning.') && !options.reasoning) return null;
  if (options.json) return `${JSON.stringify({ kind: 'agent_event', ...envelope })}\n`;
  const event = envelope.event;
  switch (event.kind) {
    case 'text.delta':
      return typeof event.delta === 'string' ? event.delta : null;
    case 'text.finished':
      return '\n';
    case 'reasoning.delta':
      return options.reasoning && typeof event.delta === 'string' ? event.delta : null;
    case 'activity.changed': {
      const reason = typeof event.reason === 'string' && event.reason ? ` (${event.reason})` : '';
      return `\n[activity] ${String(event.activity ?? 'unknown')}${reason}\n`;
    }
    case 'tool.called':
      return `\n[tool] ${String(event.tool ?? event.name ?? 'tool')} started\n`;
    case 'tool.completed':
      return `[tool] ${String(event.tool ?? event.name ?? 'tool')} finished\n`;
    case 'tool.failed':
      return `[tool] ${String(event.tool ?? event.name ?? 'tool')} failed: ${String(event.error ?? 'unknown error')}\n`;
    case 'tool.approval.requested':
      return `[waiting] approval required for ${String(event.tool ?? 'tool')} (${String(event.approvalId ?? '')})\n`;
    case 'tool.approval.resolved':
      return `[approval] ${event.approved === true ? 'approved' : 'rejected'}\n`;
    case 'file.changed':
      return `[file] ${String(event.operation ?? 'updated')} ${String(event.path ?? '')}\n`;
    case 'usage.updated':
      return `[usage] ${JSON.stringify(event.usage ?? {})}\n`;
    case 'warning':
      return `[warning] ${String(event.message ?? '')}\n`;
    case 'error':
    case 'session.failed':
      return `[error] ${String(event.message ?? event.error ?? 'native harness failed')}\n`;
    default:
      if (event.kind.startsWith('session.')) return `[session] ${event.kind.slice('session.'.length)}\n`;
      if (event.kind === 'context.compacted') return '[context] compacted\n';
      return null;
  }
}

export function renderNativeHarnessDiagnostic(
  envelope: NativeHarnessDiagnosticEnvelope,
  options: Pick<NativeAttachOptions, 'json' | 'diagnostics'> = {}
): string | null {
  if (!options.diagnostics) return null;
  if (options.json) return `${JSON.stringify({ kind: 'native_harness_diagnostic', ...envelope })}\n`;
  return `[diagnostic:${envelope.diagnostic.level}] ${envelope.diagnostic.message}\n`;
}

export interface NativeAttachDependencies {
  connect(connection: BrokerConnection): HarnessDriverClient;
  output: NativeAttachOutput;
  createReadline(): ReadlineInterface;
  onSignal(handler: () => void): () => void;
}

function defaultDependencies(options: NativeAttachOptions): NativeAttachDependencies {
  void options;
  return {
    connect: (resolved) => createBrokerClient(resolved),
    output: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
    createReadline: () =>
      createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: Boolean(process.stdin.isTTY),
      }),
    onSignal: (handler) => {
      process.once('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}

export async function attachNative(
  name: string,
  mode: NativeAttachMode,
  options: NativeAttachOptions,
  overrides: Partial<NativeAttachDependencies> = {}
): Promise<number> {
  if (mode === 'passthrough') {
    (overrides.output?.stderr ?? ((text: string) => process.stderr.write(text)))(
      'Error: native harnesses do not expose a terminal byte stream; use --mode view or --mode drive.\n'
    );
    return 1;
  }
  const connection = resolveBrokerConnection(options, {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
  });
  if (!connection) {
    (overrides.output?.stderr ?? ((text: string) => process.stderr.write(text)))(
      'Error: could not locate broker connection.\n'
    );
    return 1;
  }
  const deps = { ...defaultDependencies(options), ...overrides } as NativeAttachDependencies;
  const client = deps.connect(connection);
  // Capture a global broker cursor before subscribing. The broker replays
  // everything after this cursor while the agent-event history request runs,
  // closing the history/live race even when the WebSocket opens slowly.
  let brokerCursor: number;
  try {
    brokerCursor = await client.currentEventSeq();
  } catch (error) {
    deps.output.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    client.disconnect();
    return 1;
  }
  const stream = client.subscribeAgentEvents(name, { sinceSequence: 0, sinceBrokerSeq: brokerCursor });
  const iterator = stream[Symbol.asyncIterator]();
  let highWater = 0;
  let stopped = false;
  let disconnected = false;
  let iteratorClosed = false;
  let resolveStop!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  let readline: ReadlineInterface | undefined;
  const pendingCommands = new Set<Promise<void>>();
  let commandChain = Promise.resolve();
  const render = (event: AgentEventEnvelope) => {
    if (event.sequence <= highWater) return;
    highWater = event.sequence;
    const text = renderAgentEvent(event, options);
    if (text !== null) deps.output.stdout(text);
  };
  const unsubscribeDiagnostics = client.onEvent((event: BrokerEvent) => {
    if (event.kind !== 'native_harness_diagnostic' || event.name !== name) return;
    const text = renderNativeHarnessDiagnostic(event, options);
    if (text !== null) deps.output.stdout(text);
  });
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    client.disconnect();
  };
  const closeIterator = () => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    readline?.close();
    // Close the broker before iterator cleanup and resolve our own stop signal.
    // An idle adapter stream is not required to unblock iterator.next()/return().
    disconnect();
    closeIterator();
    resolveStop();
  };
  const removeSignal = deps.onSignal(stop);

  try {
    const history = await client.getAgentEventHistory(name, 0);
    if (history.gap) {
      const gap = {
        kind: 'agent_event_replay_gap',
        name,
        oldest_available_sequence: history.oldest_available_sequence,
      };
      if (options.json) deps.output.stdout(`${JSON.stringify(gap)}\n`);
      else deps.output.stderr('[attach] agent-event history was truncated; showing retained events.\n');
    }
    for (const event of history.events) render(event);

    if (mode === 'drive') {
      readline = deps.createReadline();
      const showPrompt = () => {
        if (stopped || options.json || !readline?.terminal) return;
        readline.setPrompt('> ');
        readline.prompt();
      };
      readline.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        if (text === '/detach') {
          stop();
          return;
        }
        const approval = text.match(/^\/(approve|reject)\s+(.+)$/);
        const kind = approval
          ? approval[1] === 'approve'
            ? 'approve_tool'
            : 'reject_tool'
          : text === '/interrupt'
            ? 'interrupt'
            : 'submit_user_message';
        const commandText = kind === 'submit_user_message' ? line : undefined;
        const approvalId = approval?.[2]?.trim();
        const pendingCommand = commandChain
          .then(() =>
            client.sendNativeHarnessCommand(name, {
              kind,
              idempotency_key: randomUUID(),
              ...(commandText === undefined ? {} : { text: commandText }),
              ...(commandText === undefined ? {} : { mode: 'auto' as const }),
              ...(approvalId ? { approval_id: approvalId } : {}),
            })
          )
          .then((ack: NativeHarnessCommandAck) => {
            if (!ack.accepted) {
              deps.output.stderr(
                `Input rejected: ${ack.error?.message ?? 'native harness rejected input'}\n`
              );
            } else if (options.json) {
              deps.output.stdout(`${JSON.stringify({ kind: 'native_harness_command_ack', name, ...ack })}\n`);
            } else {
              deps.output.stderr(ack.duplicate ? '[input] already accepted\n' : '[input] accepted\n');
            }
          })
          .catch((error: unknown) => {
            deps.output.stderr(`Input failed: ${error instanceof Error ? error.message : String(error)}\n`);
          })
          .then(() => undefined);
        commandChain = pendingCommand.catch(() => undefined);
        pendingCommands.add(pendingCommand);
        void pendingCommand.finally(() => {
          pendingCommands.delete(pendingCommand);
          showPrompt();
        });
      });
      showPrompt();
    }

    while (!stopped) {
      const next = await Promise.race([
        iterator.next(),
        stopSignal.then(() => ({ done: true as const, value: undefined as never })),
      ]);
      if (next.done) break;
      render(next.value);
    }
    await Promise.allSettled(pendingCommands);
    return 0;
  } catch (error) {
    deps.output.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    stopped = true;
    removeSignal();
    unsubscribeDiagnostics();
    readline?.close();
    disconnect();
    closeIterator();
    resolveStop();
  }
}

export async function isNativeHarness(
  name: string,
  options: NativeAttachOptions,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<boolean> {
  const connection = resolveBrokerConnection(options, {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
  });
  if (!connection) return false;
  const client = createBrokerClient(connection, fetchFn);
  const agent = (await client.listAgents()).find((candidate) => candidate.name === name);
  return agent?.runtime_kind === 'native';
}
