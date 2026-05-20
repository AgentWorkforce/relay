/**
 * `agent-relay activity` — broker-wide activity tail.
 *
 * Streams the broker `/ws` event feed and renders high-signal lifecycle,
 * delivery, message, and worker output events as readable log lines.
 */

import { Command } from 'commander';
import WebSocket from 'ws';

import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  toWsUrl,
  type BrokerConnectionDeps,
  type BrokerConnectionOptions,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';
import { sanitizeForTerminalLine } from '../lib/formatting.js';

type ExitFn = (code: number) => never;

export interface ActivityWebSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(code?: number, reason?: string): void;
}

export type ActivityWebSocketFactory = (url: string, headers: Record<string, string>) => ActivityWebSocket;

export interface ActivityDependencies extends BrokerConnectionDeps {
  createWebSocket: ActivityWebSocketFactory;
  writeLine: (line: string) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  onSignal: (signal: NodeJS.Signals, handler: () => void | Promise<void>) => void;
  nowIso: () => string;
  exit: ExitFn;
}

export interface ActivityOptions extends BrokerConnectionOptions {
  sinceSeq?: string;
  json?: boolean;
  streams?: boolean;
  kind?: string;
  name?: string;
  ids?: boolean;
}

type ActivityEvent = Record<string, unknown> & { kind?: unknown; seq?: unknown };
interface ActivityFormatOptions {
  ids?: boolean;
}

function withDefaults(overrides: Partial<ActivityDependencies> = {}): ActivityDependencies {
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as ActivityWebSocket,
    writeLine: (line) => {
      process.stdout.write(`${line}\n`);
    },
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    onSignal: (signal, handler) => {
      process.on(signal, () => runSignalHandler(handler));
    },
    nowIso: () => new Date().toISOString(),
    exit: defaultExit,
    ...overrides,
  };
}

function readString(event: ActivityEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readNumber(event: ActivityEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readCount(event: ActivityEvent, key: string): string | undefined {
  const value = event[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value;
  return undefined;
}

function actorName(event: ActivityEvent): string {
  return readString(event, 'name') ?? readString(event, 'agent') ?? readString(event, 'worker_name') ?? '?';
}

function eventId(event: ActivityEvent): string | undefined {
  return readString(event, 'event_id');
}

function deliveryId(event: ActivityEvent): string | undefined {
  return readString(event, 'delivery_id');
}

function seqSuffix(event: ActivityEvent): string {
  const seq = readNumber(event, 'seq');
  return seq === undefined ? '' : ` #${seq}`;
}

function quotePreview(value: string | undefined, max = 140): string {
  if (!value) return '';
  const clean = sanitizeForTerminalLine(value).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return `"${clean.length > max ? `${clean.slice(0, max - 1)}...` : clean}"`;
}

function humanizeCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = sanitizeForTerminalLine(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || undefined;
}

function reasonSuffix(event: ActivityEvent): string | undefined {
  const reason = humanizeCode(readString(event, 'reason'));
  return reason ? `(${reason})` : undefined;
}

function detail(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function formatClock(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '??:??:??';
  return new Date(parsed).toISOString().slice(11, 19);
}

function metadataSuffix(event: ActivityEvent, options: ActivityFormatOptions): string {
  if (!options.ids) return '';
  const parts = [
    eventId(event) ? `event ${eventId(event)}` : undefined,
    deliveryId(event) ? `delivery ${deliveryId(event)}` : undefined,
    seqSuffix(event) ? `seq ${seqSuffix(event).slice(2)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

function formatLine(
  nowIso: string,
  label: string,
  message: string,
  event: ActivityEvent,
  options: ActivityFormatOptions
): string {
  return `${formatClock(nowIso)}  ${label.padEnd(18)} ${message}${metadataSuffix(event, options)}`.trimEnd();
}

function formatDelivery(
  label: string,
  preposition: string,
  event: ActivityEvent,
  nowIso: string,
  options: ActivityFormatOptions
): string {
  return formatLine(
    nowIso,
    label,
    detail([
      `${preposition} ${actorName(event)}`,
      readString(event, 'from') && readString(event, 'target')
        ? `${readString(event, 'from')} -> ${readString(event, 'target')}`
        : undefined,
      reasonSuffix(event),
    ]),
    event,
    options
  );
}

export function formatActivityEvent(
  event: ActivityEvent,
  nowIso: string,
  options: ActivityFormatOptions = {}
): string | null {
  const kind = readString(event, 'kind');

  switch (kind) {
    case 'relay_inbound': {
      const from = readString(event, 'from') ?? '?';
      const target = readString(event, 'target') ?? '?';
      const thread = readString(event, 'thread_id');
      const route = `${from} -> ${target}${thread ? ` (thread ${thread})` : ''}`;
      const preview = quotePreview(readString(event, 'body'));
      return formatLine(nowIso, 'Message received', preview ? `${route}: ${preview}` : route, event, options);
    }
    case 'relaycast_published':
      return formatLine(
        nowIso,
        'Message sent',
        detail([
          `broker -> ${readString(event, 'to') ?? '?'}`,
          readString(event, 'target_type') ? `(${readString(event, 'target_type')})` : undefined,
        ]),
        event,
        options
      );
    case 'relaycast_publish_failed':
      return formatLine(
        nowIso,
        'Send failed',
        detail([`broker -> ${readString(event, 'to') ?? '?'}`, reasonSuffix(event)]),
        event,
        options
      );
    case 'delivery_queued':
      return formatDelivery('Delivery queued', 'for', event, nowIso, options);
    case 'delivery_injected':
      return formatDelivery('Delivery injected', 'into', event, nowIso, options);
    case 'delivery_active':
      return formatDelivery('Delivery active', 'in', event, nowIso, options);
    case 'delivery_ack':
      return formatDelivery('Delivery acked', 'by', event, nowIso, options);
    case 'delivery_verified':
      return formatDelivery('Delivery verified', 'by', event, nowIso, options);
    case 'delivery_retry':
      return formatLine(
        nowIso,
        'Delivery retry',
        detail([`${actorName(event)} attempt ${readCount(event, 'attempts') ?? '?'}`]),
        event,
        options
      );
    case 'delivery_failed':
      return formatLine(
        nowIso,
        'Delivery failed',
        detail([`${actorName(event)}`, reasonSuffix(event)]),
        event,
        options
      );
    case 'delivery_dropped':
      return formatLine(
        nowIso,
        'Delivery dropped',
        detail([
          `${actorName(event)} dropped ${readCount(event, 'count') ?? '?'} pending`,
          reasonSuffix(event),
        ]),
        event,
        options
      );
    case 'message_delivery_confirmed':
      return formatLine(
        nowIso,
        'Message delivered',
        detail([
          `${readString(event, 'from') ?? '?'} -> ${readString(event, 'to') ?? '?'}`,
          `through ${actorName(event)}`,
        ]),
        event,
        options
      );
    case 'message_delivery_failed':
      return formatLine(
        nowIso,
        'Message failed',
        detail([
          `${readString(event, 'from') ?? '?'} -> ${readString(event, 'to') ?? '?'}`,
          `through ${actorName(event)}`,
          readCount(event, 'attempts') ? `after ${readCount(event, 'attempts')} attempts` : undefined,
          quotePreview(readString(event, 'lastError') ?? readString(event, 'last_error'), 100),
        ]),
        event,
        options
      );
    case 'worker_stream': {
      const preview = quotePreview(readString(event, 'chunk'), 160);
      if (!preview) return null;
      return formatLine(
        nowIso,
        'Output',
        `${actorName(event)} ${readString(event, 'stream') ?? 'stream'}: ${preview}`,
        event,
        options
      );
    }
    case 'agent_spawned':
      return formatLine(
        nowIso,
        'Agent spawned',
        detail([
          `${actorName(event)}`,
          readString(event, 'runtime') ? `(${readString(event, 'runtime')})` : undefined,
          readString(event, 'cli') ? `cli=${readString(event, 'cli')}` : undefined,
          readString(event, 'model') ? `model=${readString(event, 'model')}` : undefined,
          readCount(event, 'pid') ? `pid=${readCount(event, 'pid')}` : undefined,
        ]),
        event,
        options
      );
    case 'worker_ready':
      return formatLine(
        nowIso,
        'Agent ready',
        detail([
          `${actorName(event)}`,
          readString(event, 'runtime') ? `(${readString(event, 'runtime')})` : undefined,
          readString(event, 'provider') ? `provider=${readString(event, 'provider')}` : undefined,
          readString(event, 'model') ? `model=${readString(event, 'model')}` : undefined,
        ]),
        event,
        options
      );
    case 'worker_error':
      return formatLine(
        nowIso,
        'Agent error',
        detail([
          `${actorName(event)}`,
          humanizeCode(readString(event, 'code') ?? 'worker_error'),
          quotePreview(readString(event, 'message'), 120),
        ]),
        event,
        options
      );
    case 'agent_released':
      return formatLine(nowIso, 'Agent released', actorName(event), event, options);
    case 'agent_exit':
      return formatLine(
        nowIso,
        'Agent exit',
        detail([actorName(event), reasonSuffix(event)]),
        event,
        options
      );
    case 'agent_exited':
      return formatLine(
        nowIso,
        'Agent exited',
        detail([
          `${actorName(event)}`,
          readCount(event, 'code') ? `code=${readCount(event, 'code')}` : undefined,
          readString(event, 'signal') ? `signal=${readString(event, 'signal')}` : undefined,
          reasonSuffix(event),
        ]),
        event,
        options
      );
    case 'agent_context_low':
      return formatLine(
        nowIso,
        'Context low',
        `${actorName(event)} ${readCount(event, 'pct') ?? '?'}% remaining`,
        event,
        options
      );
    case 'agent_idle':
      return formatLine(
        nowIso,
        'Agent idle',
        `${actorName(event)} idle ${readCount(event, 'idle_secs') ?? '?'}s`,
        event,
        options
      );
    case 'agent_blocked_on_send':
      return formatLine(
        nowIso,
        'Agent blocked',
        `${actorName(event)} blocked ${readCount(event, 'blocked_secs') ?? '?'}s (${readCount(event, 'pending_delivery_count') ?? '?'} pending)`,
        event,
        options
      );
    case 'agent_restarting':
      return formatLine(
        nowIso,
        'Agent restarting',
        `${actorName(event)} restart ${readCount(event, 'restart_count') ?? '?'} in ${readCount(event, 'delay_ms') ?? '?'}ms`,
        event,
        options
      );
    case 'agent_restarted':
      return formatLine(
        nowIso,
        'Agent restarted',
        `${actorName(event)} restart ${readCount(event, 'restart_count') ?? '?'}`,
        event,
        options
      );
    case 'agent_permanently_dead':
      return formatLine(
        nowIso,
        'Agent dead',
        detail([actorName(event), reasonSuffix(event)]),
        event,
        options
      );
    case 'channel_subscribed':
      return formatLine(
        nowIso,
        'Subscribed',
        `${actorName(event)} ${JSON.stringify(event.channels ?? [])}`,
        event,
        options
      );
    case 'channel_unsubscribed':
      return formatLine(
        nowIso,
        'Unsubscribed',
        `${actorName(event)} ${JSON.stringify(event.channels ?? [])}`,
        event,
        options
      );
    case 'agent_pending_drained':
      return formatLine(
        nowIso,
        'Pending drained',
        detail([
          `${actorName(event)} drained ${readCount(event, 'count') ?? '?'} pending`,
          reasonSuffix(event),
        ]),
        event,
        options
      );
    case 'agent_inbound_delivery_mode_changed':
      return formatLine(
        nowIso,
        'Delivery mode',
        `${actorName(event)} ${humanizeCode(readString(event, 'previous_mode')) ?? '?'} -> ${humanizeCode(readString(event, 'mode')) ?? '?'}`,
        event,
        options
      );
    case 'acl_denied':
      return formatLine(
        nowIso,
        'ACL denied',
        `${actorName(event)} from ${readString(event, 'sender') ?? '?'}`,
        event,
        options
      );
    case 'replay_gap':
      return formatLine(
        nowIso,
        'Replay gap',
        `requested ${readCount(event, 'requestedSinceSeq') ?? '?'} oldest available ${readCount(event, 'oldestAvailable') ?? '?'}`,
        event,
        options
      );
    default:
      return formatLine(
        nowIso,
        'Broker event',
        `${kind ?? 'unknown'} ${quotePreview(JSON.stringify(event), 180)}`.trim(),
        event,
        options
      );
  }
}

function parseSinceSeq(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid --since-seq value: ${input}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --since-seq value: ${input}`);
  }
  return parsed;
}

function eventMatchesName(event: ActivityEvent, name: string): boolean {
  const candidates = [
    readString(event, 'name'),
    readString(event, 'agent'),
    readString(event, 'worker_name'),
    readString(event, 'from'),
    readString(event, 'target'),
    readString(event, 'to'),
  ];
  return candidates.some((candidate) => candidate === name);
}

function shouldEmit(event: ActivityEvent, options: ActivityOptions): boolean {
  const kind = readString(event, 'kind');
  if (options.streams === false && kind === 'worker_stream') return false;
  if (options.kind && kind !== options.kind.trim()) return false;
  if (options.name && !eventMatchesName(event, options.name.trim())) return false;
  return true;
}

function buildActivityWsUrl(baseUrl: string, sinceSeq: number): string {
  const separator = toWsUrl(baseUrl).includes('?') ? '&' : '?';
  return `${toWsUrl(baseUrl)}${separator}sinceSeq=${sinceSeq}`;
}

export async function runActivitySession(
  options: ActivityOptions,
  deps: ActivityDependencies
): Promise<number> {
  const connection = resolveBrokerConnection(options, deps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agent-relay/connection.json.'
    );
    return 1;
  }

  let sinceSeq = 0;
  try {
    sinceSeq = parseSinceSeq(options.sinceSeq) ?? 0;
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    const socket = deps.createWebSocket(buildActivityWsUrl(connection.url, sinceSeq), headers);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      try {
        socket.close(1000, 'activity client exiting');
      } catch {
        // best effort
      }
      resolve(code);
    };

    deps.onSignal('SIGINT', () => finish(0));
    deps.onSignal('SIGTERM', () => finish(0));

    socket.on('open', () => {
      deps.log(`[activity] streaming broker activity from ${connection.url} (Ctrl+C to exit)`);
    });

    socket.on('message', (data) => {
      let event: ActivityEvent;
      try {
        const text =
          typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        event = parsed as ActivityEvent;
      } catch {
        return;
      }

      if (!shouldEmit(event, options)) return;

      if (options.json) {
        deps.writeLine(JSON.stringify(event));
        return;
      }

      const line = formatActivityEvent(event, deps.nowIso(), { ids: options.ids === true });
      if (line) deps.writeLine(line);
    });

    socket.on('error', (err: Error) => {
      deps.error(`[activity] WebSocket error: ${err.message}`);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (settled) return;
      const reasonText = reason && reason.length > 0 ? reason.toString('utf-8') : '';
      if (code === 1000 || code === 1005) {
        finish(0);
      } else {
        deps.error(
          `[activity] connection closed (code: ${code}${reasonText ? `, reason: ${reasonText}` : ''})`
        );
        finish(1);
      }
    });
  });
}

export function registerActivityCommands(
  program: Command,
  overrides: Partial<ActivityDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  program
    .command('activity')
    .description('Tail broker activity events in a readable stream')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .option('--since-seq <seq>', 'Replay durable events after this broker sequence number', '0')
    .option('--kind <kind>', 'Only show events with this kind')
    .option('--name <name>', 'Only show events involving this agent/name')
    .option('--no-streams', 'Hide worker_stream output previews')
    .option('--ids', 'Show event, delivery, and replay sequence identifiers')
    .option('--json', 'Emit matching events as JSON Lines')
    .action(async (options: ActivityOptions) => {
      const code = await runActivitySession(options, deps);
      if (code !== 0) {
        deps.exit(code);
      }
    });
}
