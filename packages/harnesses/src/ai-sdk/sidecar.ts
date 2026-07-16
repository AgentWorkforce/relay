import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import {
  NATIVE_HARNESS_PROTOCOL_VERSION,
  type ProtocolEnvelope,
  type RelayDelivery,
  type NativeHarnessCommand,
  type NativeHarnessCommandAck,
  type NativeHarnessDiagnosticEnvelope,
  type AgentEventEnvelope,
  type AgentEventPayload,
} from '@agent-relay/harness-driver';
import type { AgentIdentity, AgentSessionEvent, RelayMessage } from '@agent-relay/sdk';
import type { HarnessV1Diagnostic } from '@ai-sdk/harness';
import { aiSdkAdapterRegistry, type RelayAdapterSettings } from './adapter-registry.js';
import { HarnessHost } from './harness-host.js';
import { LocalHostSandboxProvider } from './local-host-sandbox.js';
import { RelayHarnessSession } from './relay-session.js';

export interface AiSdkSidecarConfig {
  name: string;
  harness: string;
  workspace: string;
  sessionId?: string;
  settings?: RelayAdapterSettings;
  instructions?: string;
  runtimeRoot?: string;
  permissionMode?: 'allow-reads' | 'allow-edits' | 'allow-all';
  /** Bounded native harness command idempotency cache; primarily configurable for tests. */
  maxCommandDedupeEntries?: number;
}

export interface AiSdkSidecarIo {
  input: NodeJS.ReadableStream;
  write: (line: string) => void | Promise<void>;
}

interface NativeHarnessCommandFrame extends ProtocolEnvelope<NativeHarnessCommand> {
  v: 2;
  type: 'native_harness_command';
  request_id: string;
}

interface WorkerInputFrame extends ProtocolEnvelope<unknown> {
  v: 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function protocolError(error: unknown) {
  return { code: 'native_harness_command_failed', message: errorMessage(error), retryable: false };
}

function commandDigest(command: NativeHarnessCommand): string {
  const canonical = JSON.stringify([
    command.kind,
    command.text ?? null,
    command.mode ?? null,
    command.approval_id ?? null,
    command.instructions ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function isCommandFrame(value: unknown): value is NativeHarnessCommandFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<NativeHarnessCommandFrame>;
  return (
    frame.v === 2 &&
    frame.type === 'native_harness_command' &&
    typeof frame.request_id === 'string' &&
    frame.payload?.protocol_version === NATIVE_HARNESS_PROTOCOL_VERSION
  );
}

function isWorkerInputFrame(value: unknown): value is WorkerInputFrame {
  return Boolean(value && typeof value === 'object' && (value as WorkerInputFrame).v === 2);
}

function eventPayload(event: AgentSessionEvent, sequence: number, timestamp: string): AgentEventPayload {
  const { type, agent: _agent, ...payload } = event;
  const observability = event.observability ? { ...event.observability, sequence, timestamp } : undefined;
  return JSON.parse(
    JSON.stringify({ kind: type, ...payload, ...(observability ? { observability } : {}) })
  ) as AgentEventPayload;
}

function diagnosticPayload(diagnostic: HarnessV1Diagnostic) {
  return {
    level:
      diagnostic.level === 'warn'
        ? ('warning' as const)
        : diagnostic.level === 'trace'
          ? ('debug' as const)
          : diagnostic.level,
    message:
      'message' in diagnostic && typeof diagnostic.message === 'string'
        ? diagnostic.message
        : JSON.stringify(diagnostic),
    subsystem: diagnostic.subsystem,
    diagnostic: JSON.parse(JSON.stringify(diagnostic)),
  };
}

export async function runAiSdkSidecar(config: AiSdkSidecarConfig, io: AiSdkSidecarIo): Promise<void> {
  const entry = aiSdkAdapterRegistry.require(config.harness);
  const harness = await entry.createHarness(config.settings);
  const provider = new LocalHostSandboxProvider({
    workspace: config.workspace,
    runtimeRoot: config.runtimeRoot,
  });
  let diagnosticSequence = 0;
  let agentEventSequence = 0;
  let agentEventWrites = Promise.resolve();
  const write = async (frame: unknown) => io.write(`${JSON.stringify(frame)}\n`);
  const publishEvent = (event: AgentSessionEvent): Promise<void> => {
    agentEventWrites = agentEventWrites.then(async () => {
      const sequence = ++agentEventSequence;
      const timestamp = new Date().toISOString();
      const envelope: Omit<AgentEventEnvelope, 'name'> = {
        protocol_version: NATIVE_HARNESS_PROTOCOL_VERSION,
        sequence,
        timestamp,
        event: eventPayload(event, sequence, timestamp),
      };
      await write({ v: 2, type: 'agent_event', payload: envelope });
    });
    return agentEventWrites;
  };
  const host = new HarnessHost({
    harness,
    sandboxProvider: provider,
    workspace: config.workspace,
    sessionId: config.sessionId,
    instructions: config.instructions,
    permissionMode: config.permissionMode,
    onDiagnostic: async (diagnostic) => {
      const envelope: Omit<NativeHarnessDiagnosticEnvelope, 'name'> = {
        protocol_version: NATIVE_HARNESS_PROTOCOL_VERSION,
        sequence: ++diagnosticSequence,
        timestamp: new Date().toISOString(),
        diagnostic: diagnosticPayload(diagnostic),
      };
      await write({ v: 2, type: 'native_harness_diagnostic', payload: envelope });
    },
  });
  const relaySession = new RelayHarnessSession({
    identity: {
      id: config.name,
      name: config.name,
      handle: config.name.toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-'),
    } satisfies AgentIdentity,
    host,
  });
  const relayDeliveries = new Map<string, { eventId: string }>();
  relaySession.onEvent?.(async (event) => {
    await publishEvent(event);
    if (event.type === 'delivery.accepted' && event.deliveryId) {
      const delivery = relayDeliveries.get(event.deliveryId);
      if (!delivery) return;
      relayDeliveries.delete(event.deliveryId);
      await write({
        v: 2,
        type: 'delivery_ack',
        payload: { delivery_id: event.deliveryId, event_id: delivery.eventId },
      });
    }
  });
  await host.start();

  const maxCommandDedupeEntries = Math.max(1, config.maxCommandDedupeEntries ?? 10_000);
  const acknowledgements = new Map<string, { digest: string; acknowledgement: NativeHarnessCommandAck }>();
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      await write({
        v: 2,
        type: 'native_harness_diagnostic',
        payload: {
          protocol_version: NATIVE_HARNESS_PROTOCOL_VERSION,
          sequence: ++diagnosticSequence,
          timestamp: new Date().toISOString(),
          diagnostic: {
            level: 'error',
            message: `Invalid native harness command JSON: ${errorMessage(error)}`,
          },
        },
      });
      continue;
    }
    if (!isWorkerInputFrame(frame)) continue;
    if (frame.type === 'init_worker') {
      await write({
        v: 2,
        type: 'worker_ready',
        payload: { name: config.name, runtime: 'headless', sessionId: host.sessionId },
      });
      continue;
    }
    if (frame.type === 'ping') {
      await write({ v: 2, type: 'pong', payload: frame.payload });
      continue;
    }
    if (frame.type === 'deliver_relay') {
      const delivery = frame.payload as RelayDelivery;
      try {
        relayDeliveries.set(delivery.delivery_id, { eventId: delivery.event_id });
        const receipt = await relaySession.receiveMessage(
          {
            id: delivery.event_id,
            messageId: delivery.event_id,
            text: delivery.body,
            from: { id: delivery.from, name: delivery.from, type: 'agent' },
          } as RelayMessage,
          {
            id: delivery.delivery_id,
            idempotencyKey: delivery.delivery_id,
            mode: delivery.injection_mode === 'wait' ? 'on-idle' : 'immediate',
            reason: 'message',
          }
        );
        if (receipt.status === 'failed') throw new Error(receipt.reason);
        if (receipt.status === 'accepted') {
          const pending = relayDeliveries.get(delivery.delivery_id);
          if (pending) {
            relayDeliveries.delete(delivery.delivery_id);
            await write({
              v: 2,
              type: 'delivery_ack',
              payload: { delivery_id: delivery.delivery_id, event_id: pending.eventId },
            });
          }
        }
      } catch (error) {
        relayDeliveries.delete(delivery.delivery_id);
        await write({
          v: 2,
          type: 'delivery_failed',
          payload: {
            delivery_id: delivery.delivery_id,
            event_id: delivery.event_id,
            reason: errorMessage(error),
          },
        });
      }
      continue;
    }
    if (frame.type === 'shutdown_worker') {
      await host.destroy();
      await write({ v: 2, type: 'worker_exited', payload: { code: 0 } });
      break;
    }
    if (!isCommandFrame(frame)) continue;

    const command = frame.payload;
    const digest = commandDigest(command);
    const previous = acknowledgements.get(command.idempotency_key);
    if (previous) {
      if (previous.digest !== digest) {
        await write({
          v: 2,
          type: 'native_harness_command_response',
          request_id: frame.request_id,
          payload: {
            protocol_version: NATIVE_HARNESS_PROTOCOL_VERSION,
            request_id: frame.request_id,
            idempotency_key: command.idempotency_key,
            accepted: false,
            active_turn: host.hasActiveTurn,
            error: {
              code: 'idempotency_conflict',
              message: 'Native harness command idempotency key was already used for a different command',
              retryable: false,
            },
          } satisfies NativeHarnessCommandAck,
        });
        continue;
      }
      await write({
        v: 2,
        type: 'native_harness_command_response',
        request_id: frame.request_id,
        payload: {
          ...previous.acknowledgement,
          request_id: frame.request_id,
          duplicate: true,
        },
      });
      continue;
    }

    let acknowledgement: NativeHarnessCommandAck;
    try {
      switch (command.kind) {
        case 'submit_user_message': {
          if (typeof command.text !== 'string') throw new Error('submit_user_message requires text');
          if (command.mode === 'active' && !host.hasActiveTurn) {
            throw new Error('No active turn is available for active input');
          }
          if (command.mode === 'idle' && host.hasActiveTurn) {
            throw new Error('An active turn is already running');
          }
          if (host.hasActiveTurn) await host.submitUserMessage(command.text);
          else await host.startTurn(command.text, command.idempotency_key);
          break;
        }
        case 'approve_tool':
        case 'reject_tool':
          if (!command.approval_id) throw new Error(`${command.kind} requires approval_id`);
          await host.submitToolApproval({
            approvalId: command.approval_id,
            approved: command.kind === 'approve_tool',
          });
          break;
        case 'interrupt':
          await host.interrupt();
          break;
        case 'compact':
          if (command.instructions !== undefined && typeof command.instructions !== 'string') {
            throw new Error('compact instructions must be a string');
          }
          await host.compact(command.instructions);
          break;
        case 'release':
          await relaySession.release('native_harness_command');
          break;
        default:
          throw new Error(
            `Unsupported native harness command kind: ${String((command as { kind?: unknown }).kind)}`
          );
      }
      acknowledgement = {
        protocol_version: NATIVE_HARNESS_PROTOCOL_VERSION,
        request_id: frame.request_id,
        idempotency_key: command.idempotency_key,
        accepted: true,
        active_turn: host.hasActiveTurn,
      };
    } catch (error) {
      acknowledgement = {
        protocol_version: NATIVE_HARNESS_PROTOCOL_VERSION,
        request_id: frame.request_id,
        idempotency_key: command.idempotency_key,
        accepted: false,
        active_turn: host.hasActiveTurn,
        error: protocolError(error),
      };
    }
    acknowledgements.set(command.idempotency_key, { digest, acknowledgement });
    while (acknowledgements.size > maxCommandDedupeEntries) {
      const oldest = acknowledgements.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      acknowledgements.delete(oldest);
    }
    await write({
      v: 2,
      type: 'native_harness_command_response',
      request_id: frame.request_id,
      payload: acknowledgement,
    });
    if (command.kind === 'release' && acknowledgement.accepted) break;
  }

  if (host.state !== 'destroyed' && host.state !== 'detached') await host.destroy();
  await agentEventWrites;
}

async function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<AiSdkSidecarConfig> {
  const configIndex = argv.indexOf('--config');
  const serialized =
    configIndex >= 0 && argv[configIndex + 1]
      ? await readFile(argv[configIndex + 1], 'utf8')
      : env.RELAY_AI_SDK_SIDECAR_CONFIG;
  if (!serialized) throw new Error('Missing sidecar config (--config or RELAY_AI_SDK_SIDECAR_CONFIG)');
  const config = JSON.parse(serialized) as Partial<AiSdkSidecarConfig>;
  if (!config.name || !config.harness || !config.workspace) {
    throw new Error('Sidecar config requires name, harness, and workspace');
  }
  return config as AiSdkSidecarConfig;
}

export async function runAiSdkSidecarMain(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = await loadConfig(argv, env);
  await runAiSdkSidecar(config, {
    input: process.stdin,
    write: (line) =>
      new Promise<void>((resolveWrite, reject) => {
        process.stdout.write(line, (error) => (error ? reject(error) : resolveWrite()));
      }),
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAiSdkSidecarMain().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
