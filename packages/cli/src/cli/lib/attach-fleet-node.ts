/**
 * Ticketed fleet-node attach adapter.
 *
 * The established attach clients intentionally continue to speak the local
 * broker HTTP/WebSocket contract. This short-lived loopback adapter maps that
 * contract onto Relaycast's authenticated terminal session, so view/drive and
 * passthrough retain their behaviour without exposing a remote broker listener
 * or copying a broker API key off a physical or Daytona node.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import WebSocket, { WebSocketServer } from 'ws';

import { AGENT37_RELAYCAST_ORIGIN, CANONICAL_RELAYCAST_ORIGIN } from '@agent-relay/cloud';
import type { AttachMode } from './attach-mode.js';
import { collectWithRetry } from './collect-with-retry.js';
import { resolveWorkspaceTransport } from './sdk-client.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;
// Use the same finite 30s request window as the broker's Relaycast HTTP calls.
// Terminal-session creation can exceed the shorter startup-handshake latency
// under load, and this POST cannot be replayed safely after an ambiguous client
// timeout because allocation may have completed server-side.
const SESSION_REQUEST_TIMEOUT_MS = 30_000;
// Immediate structured reachability failures still receive the complete
// five-attempt/31.2s retry schedule, while slow responses cannot multiply the
// per-attempt timeout into a roughly three-minute CLI hang.
const SESSION_REQUEST_TOTAL_TIMEOUT_MS = 90_000;
const SESSION_REQUEST_RETRIES = 4;
// The fleet node publishes liveness every 12s. With four retries, the helper's
// deterministic delays are 6s, 7.2s, 8.4s, and 9.6s: 31.2s total. That spans
// more than two heartbeat intervals and matches the established terminal
// transport's bounded recovery window instead of exhausting every retry inside
// the same stale control-plane read.
const SESSION_REQUEST_RETRY_DELAY_MS = 6_000;
const TERMINAL_CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
// Six delays (0.5s + 1s + 2s + 4s + 8s + 16s) cover the node terminal
// transport's independent 30s maximum reconnect backoff without leaving this
// client unbounded. Five attempts previously stopped after only 15.5s.
const MAX_RECONNECT_ATTEMPTS = 6;
// Bounds the acknowledgement for a delivery-mode command after readiness.
// The command is not replayable across reconnects, so this is intentionally a
// separate post-readiness phase rather than another full reconnect window.
const DELIVERY_MODE_TIMEOUT_MS = 10_000;
// The caller starts its HTTP deadline before the loopback handler starts its
// readiness timer. Leave a small response-delivery margin so the proxy's
// actionable readiness error wins that race.
const LOOPBACK_REQUEST_TIMEOUT_MARGIN_MS = 1_000;

type FleetSessionResponse = {
  ok?: boolean;
  data?: {
    session_id?: string;
    terminal_url?: string;
    resume_token?: string;
    expires_at?: string;
  };
  error?: { code?: string; message?: string };
};

type TerminalFrame = Record<string, unknown> & {
  type?: string;
  session_id?: string;
  blocked_reason_code?: unknown;
  head_sequence?: unknown;
  acked_up_to_sequence?: unknown;
  received_up_to_sequence?: unknown;
  next_ackable_sequence?: unknown;
  reconciliation_action?: unknown;
};

type GapDiagnosticsResult = {
  blocked_reason_code?: string;
  head_sequence?: number;
  acked_up_to_sequence?: number;
  received_up_to_sequence?: number;
  next_ackable_sequence?: number;
  reconciliation_action?: string;
};

function gapDiagnosticsFromFrame(frame: {
  blocked_reason_code?: unknown;
  head_sequence?: unknown;
  acked_up_to_sequence?: unknown;
  received_up_to_sequence?: unknown;
  next_ackable_sequence?: unknown;
  reconciliation_action?: unknown;
}): GapDiagnosticsResult {
  return {
    ...(typeof frame.blocked_reason_code === 'string'
      ? { blocked_reason_code: frame.blocked_reason_code }
      : {}),
    ...(typeof frame.head_sequence === 'number' ? { head_sequence: frame.head_sequence } : {}),
    ...(typeof frame.acked_up_to_sequence === 'number'
      ? { acked_up_to_sequence: frame.acked_up_to_sequence }
      : {}),
    ...(typeof frame.received_up_to_sequence === 'number'
      ? { received_up_to_sequence: frame.received_up_to_sequence }
      : {}),
    ...(typeof frame.next_ackable_sequence === 'number'
      ? { next_ackable_sequence: frame.next_ackable_sequence }
      : {}),
    ...(typeof frame.reconciliation_action === 'string'
      ? { reconciliation_action: frame.reconciliation_action }
      : {}),
  };
}

type TerminalReadiness = {
  generation: number;
  settled: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export interface FleetNodeAttachOptions {
  agent: string;
  node: string;
  mode: AttachMode;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  workspaceKey?: string;
  fetch?: typeof globalThis.fetch;
  /** Deterministic test seam for the bounded session-request retry delay. */
  sessionRequest?: {
    timeoutMs?: number;
    totalTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** Deterministic test seam for established-session reconnect timing. */
  reconnectDelay?: {
    initialMs?: number;
    maxMs?: number;
    handshakeTimeoutMs?: number;
    readyTimeoutMs?: number;
    beforeReadyTimeoutTerminate?: (socket: WebSocket) => void;
  };
}

export interface FleetNodeAttachProxy {
  brokerUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  close(): Promise<void>;
}

export class FleetNodeAttachError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'FleetNodeAttachError';
  }
}

const TRUSTED_RELAYCAST_ORIGINS = new Set([CANONICAL_RELAYCAST_ORIGIN, AGENT37_RELAYCAST_ORIGIN]);

export function validateFleetAttachBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FleetNodeAttachError('Fleet node attach requires a trusted Relaycast origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    !TRUSTED_RELAYCAST_ORIGINS.has(parsed.origin)
  ) {
    throw new FleetNodeAttachError('Fleet node attach requires a trusted Relaycast origin.');
  }
  return parsed.origin;
}

class TerminalSessionAttemptError extends FleetNodeAttachError {
  constructor(
    message: string,
    code: string | undefined,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly completionUnknown: boolean
  ) {
    super(message, code);
  }
}

/**
 * Canonical HTTP status for a terminal failure code.
 *
 * `agent_not_found` must stay 404: {@link switchInboundDeliveryModeOrAbort}
 * only emits the "no agent named X" message and the cross-node placement hint
 * on a 404, so collapsing it into 503 replaces actionable guidance with an
 * opaque unreachable-node error. `unsupported_runtime` stays 409. Everything
 * else is a transport-level failure and reports 503.
 */
function terminalErrorStatus(code: string | undefined): number {
  if (code === 'agent_not_found') return 404;
  if (code === 'unsupported_runtime') return 409;
  return 503;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (body: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      resolve(body);
    };
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body) as unknown;
        finish(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        );
      } catch {
        finish({});
      }
    });
    request.on('error', () => finish({}));
    request.on('aborted', () => finish({}));
  });
}

function asWsUrl(value: string): string {
  const lower = value.toLowerCase();
  if (lower.startsWith('https://')) return 'wss://' + value.slice(8);
  if (lower.startsWith('http://')) return 'ws://' + value.slice(7);
  return value;
}

function safeNodePath(node: string): string {
  const trimmed = node.trim().replace(/^#/, '');
  if (!trimmed) throw new FleetNodeAttachError('Error: --node requires a node name or id.', 'invalid_node');
  return encodeURIComponent(trimmed);
}

function parseFrame(data: WebSocket.RawData): TerminalFrame | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TerminalFrame) : null;
  } catch {
    return null;
  }
}

/**
 * Decode a `terminal.ready` / `terminal.snapshot` `screen` field into the raw
 * ANSI bytes a terminal can render.
 *
 * The two payloads this adapter bridges are encoded differently and the
 * difference is invisible at the type level — both are `string`:
 *
 * - `screen` is the visible grid rendered by `Snapshot::to_ansi()` and then
 *   **base64-encoded**, because the broker asks the worker for
 *   `format: "ansi"` (`fleet.rs`) and that arm encodes (`pty_worker.rs`).
 *   Broker HTTP snapshot consumers decode it (`attach.ts` `captureAndRender…`).
 * - `worker_stream.chunk` (and `terminal.output.chunk`, which is the same
 *   value forwarded) is **raw PTY bytes**. Attach clients write it to stdout
 *   verbatim (`applyServerOutput` in `attach-drive.ts`).
 *
 * Handing an undecoded `screen` to {@link workerStreamEvent} therefore prints
 * the base64 text itself into the operator's terminal — the reconnect flood in
 * relay#1829. Returns `null` when the payload is not canonical base64, so a
 * malformed or protocol-violating frame is dropped rather than rendered: a
 * stale-but-coherent screen beats writing unintelligible bytes to a live TTY.
 */
export function decodeAnsiScreenPayload(screen: string): string | null {
  if (screen === '') return '';
  if (screen.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(screen)) return null;
  const decoded = Buffer.from(screen, 'base64');
  // `Buffer.from(…, 'base64')` silently skips characters outside the alphabet,
  // so the round-trip is what actually rejects a non-base64 payload.
  if (decoded.toString('base64') !== screen) return null;
  return decoded.toString('utf8');
}

/**
 * Mirror of the broker's `pty_input_error_is_connection_fatal`
 * (`crates/broker/src/listen_api.rs`). The two lists must agree, because the
 * SDK's `PtyInputStream` latches `closed` **only** when its socket closes
 * (`harness-driver/src/transport.ts`): a fatal error delivered on a socket
 * that stays open leaves `isUsable()` true forever.
 *
 * That matters most for a fatal error that arrives with **no write in
 * flight** — the session-scoped `terminal.error` path below. The client's
 * `failAll()` then has nothing to reject, so nothing marks the stream dead:
 * the drive session never enters recovery and keeps writing into a stream the
 * node has already declared unusable. Closing the socket, as the broker does,
 * is what turns that into a reported outage the session can recover from.
 */
export function inputErrorIsConnectionFatal(code: string): boolean {
  return code !== 'worker_timeout' && code !== 'pty_write_queue_full';
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}

function diagnosticEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '(invalid endpoint)';
  }
}

function diagnosticEndpointOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '(invalid endpoint)';
  }
}

function boundedWebSocketCloseReason(reason: string): string {
  const encoded = Buffer.from(reason, 'utf8');
  if (encoded.length <= MAX_WEBSOCKET_CLOSE_REASON_BYTES) return reason;

  const suffix = Buffer.from('…', 'utf8');
  let end = MAX_WEBSOCKET_CLOSE_REASON_BYTES - suffix.length;
  // Do not cut through a UTF-8 continuation sequence. Excluding the leading
  // byte at this boundary also excludes the incomplete code point.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return Buffer.concat([encoded.subarray(0, end), suffix]).toString('utf8');
}

function diagnosticValue(value: string): string {
  // JSON quoting keeps node names and upstream text from injecting terminal
  // control characters into the operator-facing error.
  return JSON.stringify(value);
}

function resolvedNodeIdFromTerminalUrl(value: string): string | undefined {
  try {
    const match = /^\/v1\/nodes\/([^/]+)\/terminal\/connect$/.exec(new URL(value).pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function retryDelayBudgetMs(attempts: number, initialMs: number, maxMs: number): number {
  let total = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    total += Math.min(initialMs * 2 ** attempt, maxMs);
  }
  return total;
}

function terminalSessionFailureSummary(error: TerminalSessionAttemptError): string {
  if (error.code === 'node_not_found') return 'Control-plane node lookup found no matching record';
  if (error.code === 'node_unreachable') {
    return /no terminal transport/i.test(error.message)
      ? 'The node record was found, but its terminal transport was unavailable'
      : 'The control plane classified the node as unreachable';
  }
  if (error.code === 'terminal_session_unavailable') {
    return 'The control plane could not allocate a terminal session';
  }
  if (error.code === 'control_plane_timeout') return 'Control-plane terminal-session lookup timed out';
  if (error.code === 'control_plane_unavailable') return 'Control-plane terminal-session lookup failed';
  return 'The terminal-session request was rejected';
}

function isRetryableTerminalSessionFailure(code: string | undefined): boolean {
  // These structured responses are emitted before a session is returned, so
  // retrying cannot duplicate a successful allocation. A fetch timeout,
  // network failure, or unclassified 5xx is different: this POST may already
  // have completed server-side, and retrying it could create a second session.
  return code === 'node_unreachable' || code === 'terminal_session_unavailable';
}

/** Start a broker-compatible loopback proxy for one remote terminal session. */
export async function startFleetNodeAttachProxy(
  options: FleetNodeAttachOptions
): Promise<FleetNodeAttachProxy> {
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const { workspaceKey, baseUrl: requestedBaseUrl } = resolveWorkspaceTransport({
    workspaceKey: options.workspaceKey,
    baseUrl: options.baseUrl,
    env,
  });
  const baseUrl = validateFleetAttachBaseUrl(requestedBaseUrl ?? CANONICAL_RELAYCAST_ORIGIN);
  const nodePath = safeNodePath(options.node);
  const sessionEndpoint = `${baseUrl}/v1/nodes/${nodePath}/terminal/sessions`;
  const sessionRequestTimeoutMs = options.sessionRequest?.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS;
  const sessionRequestTotalTimeoutMs =
    options.sessionRequest?.totalTimeoutMs ?? SESSION_REQUEST_TOTAL_TIMEOUT_MS;
  const sessionRequestDeadline = Date.now() + sessionRequestTotalTimeoutMs;
  const sessionRequestSleep =
    options.sessionRequest?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let sessionRequestAttempts = 0;
  let sessionRequestBudgetExhaustedBetweenAttempts = false;
  let lastSessionError: TerminalSessionAttemptError | undefined;
  const sessionResult = await collectWithRetry(
    'terminal session request',
    async () => {
      const remainingRequestBudgetMs = sessionRequestDeadline - Date.now();
      if (remainingRequestBudgetMs <= 0) {
        sessionRequestBudgetExhaustedBetweenAttempts = true;
        const exhausted =
          lastSessionError === undefined
            ? new TerminalSessionAttemptError(
                'overall terminal-session request deadline exhausted',
                'control_plane_timeout',
                undefined,
                false,
                false
              )
            : new TerminalSessionAttemptError(
                lastSessionError.message,
                lastSessionError.code,
                lastSessionError.status,
                false,
                lastSessionError.completionUnknown
              );
        lastSessionError = exhausted;
        throw exhausted;
      }
      sessionRequestAttempts += 1;
      const controller = new AbortController();
      let timedOut = false;
      const attemptTimeoutMs = Math.min(sessionRequestTimeoutMs, remainingRequestBudgetMs);
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, attemptTimeoutMs);
      let ticketResponse: Response;
      let ticketPayload: FleetSessionResponse;
      try {
        ticketResponse = await fetchFn(sessionEndpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: options.agent, mode: options.mode }),
          signal: controller.signal,
        });
        const parsedPayload = (await ticketResponse.json()) as unknown;
        ticketPayload =
          parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)
            ? (parsedPayload as FleetSessionResponse)
            : {};
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        lastSessionError = new TerminalSessionAttemptError(
          timedOut ? 'request exceeded its deadline' : detail,
          timedOut ? 'control_plane_timeout' : 'control_plane_unavailable',
          undefined,
          false,
          true
        );
        throw lastSessionError;
      } finally {
        clearTimeout(timeout);
      }

      const terminalUrl = ticketPayload.data?.terminal_url;
      const sessionId = ticketPayload.data?.session_id;
      const resumeToken = ticketPayload.data?.resume_token;
      if (!ticketResponse.ok || !terminalUrl || !sessionId || !resumeToken) {
        const code = ticketPayload.error?.code;
        const message =
          ticketPayload.error?.message ?? `terminal session request failed (HTTP ${ticketResponse.status})`;
        lastSessionError = new TerminalSessionAttemptError(
          message,
          code,
          ticketResponse.status,
          isRetryableTerminalSessionFailure(code),
          false
        );
        throw lastSessionError;
      }
      return { terminalUrl, sessionId, resumeToken, expiresAt: ticketPayload.data?.expires_at };
    },
    {
      retries: SESSION_REQUEST_RETRIES,
      baseDelayMs: SESSION_REQUEST_RETRY_DELAY_MS,
      sleep: async (delayMs) => {
        const remainingRequestBudgetMs = sessionRequestDeadline - Date.now();
        if (remainingRequestBudgetMs <= 0) return;
        await sessionRequestSleep(Math.min(delayMs, remainingRequestBudgetMs));
      },
      shouldRetry: (error) => error instanceof TerminalSessionAttemptError && error.retryable,
    }
  );
  if (!sessionResult.ok) {
    const failure = lastSessionError;
    const status = failure?.status === undefined ? '' : ` HTTP ${failure.status};`;
    const code = failure?.code === undefined ? '' : ` code ${failure.code};`;
    const retryNote = sessionRequestBudgetExhaustedBetweenAttempts
      ? sessionRequestAttempts > 1
        ? `retried ${sessionRequestAttempts - 1} time${sessionRequestAttempts === 2 ? '' : 's'};` +
          ' overall budget exhausted before the next attempt'
        : 'not retried because the overall budget was exhausted before the next attempt'
      : sessionRequestAttempts > 1
        ? `retried ${sessionRequestAttempts - 1} time${sessionRequestAttempts === 2 ? '' : 's'}` +
          (failure?.completionUnknown
            ? '; final POST not retried because it may have completed server-side'
            : '')
        : failure?.completionUnknown
          ? 'not retried because the POST may have completed server-side'
          : 'not retried because the failure was terminal';
    const upstream = failure?.message ? ` Upstream message ${diagnosticValue(failure.message)}.` : '';
    throw new FleetNodeAttachError(
      `Error: ${failure ? terminalSessionFailureSummary(failure) : 'Terminal-session request failed'}.` +
        `${upstream} Node ref ${diagnosticValue(options.node.trim())}, resolved node id unavailable (session creation did not complete);` +
        ` endpoint ${diagnosticValue(diagnosticEndpoint(sessionEndpoint))};${status}${code}` +
        ` timeout ${sessionRequestTimeoutMs}ms per attempt; overall budget ${sessionRequestTotalTimeoutMs}ms;` +
        ` attempts ${sessionRequestAttempts} (${retryNote}).`,
      failure?.code
    );
  }
  let { terminalUrl, sessionId, resumeToken, expiresAt } = sessionResult.value;
  const resolvedNodeId = resolvedNodeIdFromTerminalUrl(terminalUrl);
  const remoteEndpoint = () => diagnosticEndpoint(terminalUrl);
  const reconnectInitialDelayMs = options.reconnectDelay?.initialMs ?? INITIAL_RECONNECT_DELAY_MS;
  const reconnectMaxDelayMs = options.reconnectDelay?.maxMs ?? MAX_RECONNECT_DELAY_MS;
  const terminalHandshakeTimeoutMs =
    options.reconnectDelay?.handshakeTimeoutMs ?? TERMINAL_CONNECT_TIMEOUT_MS;
  const terminalReadyTimeoutMs = options.reconnectDelay?.readyTimeoutMs ?? TERMINAL_CONNECT_TIMEOUT_MS;
  // A readiness-gated local request follows activeReadiness across reconnect
  // generations. Its own deadline therefore has to cover the same complete,
  // finite recovery path: every backoff plus every handshake/readiness pair.
  const terminalWaitTimeoutMs =
    retryDelayBudgetMs(MAX_RECONNECT_ATTEMPTS, reconnectInitialDelayMs, reconnectMaxDelayMs) +
    MAX_RECONNECT_ATTEMPTS * (terminalHandshakeTimeoutMs + terminalReadyTimeoutMs) +
    sessionRequestTotalTimeoutMs;

  let connectionGeneration = 0;
  const createReadiness = (): TerminalReadiness => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A failure can land before a snapshot request attaches its waiter. Keep
    // the rejection observable while avoiding an unhandled-rejection warning.
    void promise.catch(() => undefined);
    return { generation: ++connectionGeneration, settled: false, promise, resolve, reject };
  };
  let activeReadiness = createReadiness();
  const resolveReadiness = (readiness: TerminalReadiness) => {
    if (readiness.settled) return;
    readiness.settled = true;
    readiness.resolve();
  };
  const rejectReadiness = (readiness: TerminalReadiness, error: Error) => {
    if (readiness.settled) return;
    readiness.settled = true;
    readiness.reject(error);
  };
  const waitForCurrentReadiness = async (): Promise<void> => {
    for (;;) {
      const readiness = activeReadiness;
      await readiness.promise;
      if (readiness === activeReadiness) return;
    }
  };
  /**
   * Await the live readiness generation through both the WebSocket handshake
   * and the post-open terminal.ready allowance.
   * Every handler that must not run before `terminal.ready` — snapshot,
   * delivery-mode PUT, resize — goes through this one helper so the
   * timer/clearTimeout/settle logic cannot diverge between copies.
   *
   * Rejects with the underlying {@link FleetNodeAttachError} when the terminal
   * failed (preserving its `code`), or a plain `Error` carrying
   * `timeoutMessage` when the wait expired.
   */
  const waitForTerminalReady = (timeoutMessage: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), terminalWaitTimeoutMs);
      void waitForCurrentReadiness().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: Error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  /**
   * The two screen representations are kept as separate, differently named
   * fields on purpose. They are both strings and only one of them may reach a
   * terminal; a single `screen` field spread into both consumers is what let
   * the encoded form escape to stdout (relay#1829).
   *
   * `screenBase64` is the HTTP snapshot wire format (callers decode it).
   * `screenAnsi` is the renderable form, and the only one that may be emitted
   * as a `worker_stream` chunk.
   */
  const snapshot: {
    screenBase64: string;
    screenAnsi: string;
    rows: number;
    cols: number;
    offset: number;
  } = {
    screenBase64: '',
    screenAnsi: '',
    rows: 24,
    cols: 80,
    offset: 0,
  };
  const eventSockets = new Set<WebSocket>();
  const inputSockets = new Set<WebSocket>();
  const outputHistory: Array<{ chunk: string; offset?: number }> = [];
  let outputHistoryBytes = 0;
  let remote: WebSocket | undefined;
  let stopped = false;
  let terminalEnded = false;
  let terminalEverReady = false;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const terminalReadinessTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Locally-tracked delivery mode, kept in sync with each broker reply. */
  let loopbackDeliveryMode: 'manual_flush' | 'auto_inject' =
    options.mode === 'drive' ? 'manual_flush' : 'auto_inject';
  type DeliveryModeResult = GapDiagnosticsResult & {
    mode: string;
    flushed: number;
    dead_lettered?: number;
    matched: boolean;
    revision: string;
    blocked_reason?: string;
  };
  type FlushResult = GapDiagnosticsResult & {
    flushed: number;
    dead_lettered: number;
    held: number;
    blocked_reason: string | null;
  };
  let pendingFlush: {
    requestId: string;
    resolve: (result: FlushResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** At most one in-flight delivery-mode PUT at a time. */
  let pendingDeliveryMode: {
    requestId: string;
    resolve: (result: DeliveryModeResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const loopbackApiKey = randomBytes(32).toString('base64url');
  const loopbackAuthorized = (headers: IncomingMessage['headers']) =>
    headers.authorization === `Bearer ${loopbackApiKey}` || headers['x-api-key'] === loopbackApiKey;

  const server = createServer(async (request, response) => {
    if (!loopbackAuthorized(request.headers)) {
      json(response, 401, {
        error: { code: 'unauthorized', message: 'loopback terminal token is required' },
      });
      return;
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === `/api/spawned/${encodeURIComponent(options.agent)}/snapshot`) {
      try {
        await waitForTerminalReady('terminal snapshot timed out');
      } catch (error) {
        const terminalError = error instanceof FleetNodeAttachError ? error : undefined;
        json(response, terminalErrorStatus(terminalError?.code), {
          error: {
            code: terminalError?.code ?? 'snapshot_unavailable',
            message:
              terminalError?.message ?? (error instanceof Error ? error.message : 'snapshot unavailable'),
          },
        });
        return;
      }
      // Explicit field mapping, not a spread: this endpoint's `screen` is
      // contractually base64 (the caller decodes it), and only the encoded
      // form may appear here.
      json(response, 200, {
        format: 'ansi',
        screen: snapshot.screenBase64,
        rows: snapshot.rows,
        cols: snapshot.cols,
        offset: snapshot.offset,
      });
      return;
    }
    const name = encodeURIComponent(options.agent);
    if (path === `/api/spawned/${name}/flush` && request.method === 'POST') {
      // Forward the flush to the remote broker over the terminal websocket.
      // Without this the `--node` form of `node agent message flush` reached
      // only the LOCAL broker's worker registry and returned agent_not_found
      // for a name that `node agent list` and `attach` both resolve.
      try {
        await waitForTerminalReady('terminal connection timed out');
      } catch (error) {
        const terminalError = error instanceof FleetNodeAttachError ? error : undefined;
        json(response, terminalErrorStatus(terminalError?.code), {
          error: {
            code: terminalError?.code ?? 'node_unreachable',
            message:
              terminalError?.message ?? (error instanceof Error ? error.message : 'terminal unavailable'),
          },
        });
        return;
      }
      if (!remote || remote.readyState !== WebSocket.OPEN) {
        json(response, 503, {
          error: { code: 'node_unreachable', message: 'terminal transport is not connected' },
        });
        return;
      }
      if (pendingFlush) {
        json(response, 503, {
          error: { code: 'flush_conflict', message: 'a flush request is already in flight' },
        });
        return;
      }
      const requestId = randomBytes(8).toString('hex');
      const result = await new Promise<FlushResult | Error>((resolve) => {
        const timer = setTimeout(() => {
          pendingFlush = null;
          resolve(new FleetNodeAttachError('flush request timed out', 'flush_timeout'));
        }, DELIVERY_MODE_TIMEOUT_MS);
        pendingFlush = {
          requestId,
          resolve: (r) => resolve(r),
          reject: (e) => resolve(e),
          timer,
        };
        remote!.send(
          JSON.stringify({
            type: 'terminal.flush_pending',
            session_id: sessionId,
            request_id: requestId,
          })
        );
      });
      if (result instanceof Error) {
        const errCode =
          result instanceof FleetNodeAttachError ? (result.code ?? 'flush_failed') : 'flush_failed';
        json(response, terminalErrorStatus(errCode), {
          error: { code: errCode, message: result.message },
        });
        return;
      }
      json(response, 200, result);
      return;
    }
    if (path === `/api/spawned/${name}/delivery-mode`) {
      if (request.method === 'GET') {
        json(response, 200, { mode: loopbackDeliveryMode });
        return;
      }
      // PUT — forward the request to the remote broker via the terminal WS and
      // await the broker's real reply. This is the path that was previously a
      // static stub returning manual_flush, causing drive attach to fail with
      // "broker remained in manual_flush mode".
      const body = await readBody(request);
      const requestedMode =
        body.mode === 'auto_inject' ? 'auto_inject' : body.mode === 'manual_flush' ? 'manual_flush' : null;
      if (requestedMode === null) {
        json(response, 400, {
          error: { code: 'invalid_mode', message: `unsupported delivery mode '${String(body.mode)}'` },
        });
        return;
      }
      // Drive attach changes delivery mode before it requests the initial
      // snapshot. Gate the PUT on terminal.ready so a fast local caller does
      // not lose a race with the remote websocket handshake and receive the
      // misleading "terminal transport is not connected" failure.
      try {
        await waitForTerminalReady('terminal connection timed out');
      } catch (error) {
        // Preserve the canonical status mapping here too: a readiness failure
        // carrying `agent_not_found` has to reach the preflight as a 404 or
        // the operator loses the cross-node placement hint that tells them
        // which machine to run the attach on.
        const terminalError = error instanceof FleetNodeAttachError ? error : undefined;
        json(response, terminalErrorStatus(terminalError?.code), {
          error: {
            code: terminalError?.code ?? 'node_unreachable',
            message:
              terminalError?.message ?? (error instanceof Error ? error.message : 'terminal unavailable'),
          },
        });
        return;
      }
      if (!remote || remote.readyState !== WebSocket.OPEN) {
        json(response, 503, {
          error: { code: 'node_unreachable', message: 'terminal transport is not connected' },
        });
        return;
      }
      if (pendingDeliveryMode) {
        json(response, 503, {
          error: { code: 'delivery_mode_conflict', message: 'a delivery mode request is already in flight' },
        });
        return;
      }
      const requestId = randomBytes(8).toString('hex');
      const result = await new Promise<DeliveryModeResult | Error>((resolve) => {
        const timer = setTimeout(() => {
          pendingDeliveryMode = null;
          resolve(new FleetNodeAttachError('delivery mode request timed out', 'delivery_mode_timeout'));
        }, DELIVERY_MODE_TIMEOUT_MS);
        pendingDeliveryMode = {
          requestId,
          resolve: (r) => resolve(r),
          reject: (e) => resolve(e),
          timer,
        };
        const frame: Record<string, unknown> = {
          type: 'terminal.set_delivery_mode',
          session_id: sessionId,
          mode: requestedMode,
          request_id: requestId,
        };
        if (typeof body.expected_mode === 'string') frame.expected_mode = body.expected_mode;
        if (typeof body.expected_revision === 'string') frame.expected_revision = body.expected_revision;
        remote!.send(JSON.stringify(frame));
      });
      if (result instanceof Error) {
        const errCode =
          result instanceof FleetNodeAttachError
            ? (result.code ?? 'delivery_mode_failed')
            : 'delivery_mode_failed';
        // Same canonical mapping as the readiness gate: 404 for
        // agent_not_found so the attach preflight can produce the no-agent or
        // cross-node placement error, 409 for unsupported_runtime, 503 for
        // everything else.
        json(response, terminalErrorStatus(errCode), {
          error: { code: errCode, message: result.message },
        });
        return;
      }
      loopbackDeliveryMode = result.mode === 'manual_flush' ? 'manual_flush' : 'auto_inject';
      json(response, 200, {
        mode: result.mode,
        flushed: result.flushed,
        ...(result.dead_lettered !== undefined ? { dead_lettered: result.dead_lettered } : {}),
        matched: result.matched,
        revision: result.revision,
        ...(result.blocked_reason !== undefined ? { blocked_reason: result.blocked_reason } : {}),
        ...gapDiagnosticsFromFrame(result),
      });
      return;
    }
    if (request.method === 'GET' && path === `/api/spawned/${name}/pending`) {
      json(response, 200, { pending: [] });
      return;
    }
    if (request.method === 'POST' && path === `/api/spawned/${name}/flush`) {
      json(response, 200, { flushed: 0 });
      return;
    }
    if (request.method === 'GET' && path === '/api/spawned') {
      json(response, 200, { agents: [{ name: options.agent, workerPid: 1 }] });
      return;
    }
    if (request.method === 'POST' && path === `/api/resize/${name}`) {
      const body = await readBody(request);
      if (body.release === true) {
        json(response, 200, { name: options.agent, released: true });
        return;
      }
      const rows = typeof body.rows === 'number' ? body.rows : 0;
      const cols = typeof body.cols === 'number' ? body.cols : 0;
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
        json(response, 400, {
          error: { code: 'invalid_dimensions', message: 'rows and cols must be positive integers' },
        });
        return;
      }
      try {
        await waitForTerminalReady('terminal resize timed out');
      } catch (error) {
        json(response, 503, {
          error: {
            code: 'session_not_ready',
            message: error instanceof Error ? error.message : 'terminal session is not ready',
          },
        });
        return;
      }
      if (!remote || remote.readyState !== WebSocket.OPEN || remote.bufferedAmount > MAX_BUFFERED_BYTES) {
        json(response, 503, {
          error: { code: 'node_unreachable', message: 'terminal transport is unavailable' },
        });
        return;
      }
      remote.send(JSON.stringify({ type: 'terminal.resize', session_id: sessionId, rows, cols }));
      json(response, 200, { name: options.agent, rows, cols, applied: true });
      return;
    }
    json(response, 404, { error: { code: 'not_found', message: 'loopback terminal endpoint not found' } });
  });
  const websocketServer = new WebSocketServer({ noServer: true });

  const closeSocket = (socket: WebSocket, code: number, reason: string) => {
    try {
      socket.close(code, boundedWebSocketCloseReason(reason));
    } catch {
      /* connection already gone */
    }
  };
  const broadcast = (sockets: Set<WebSocket>, payload: unknown): boolean => {
    const encoded = JSON.stringify(payload);
    let accepted = false;
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeSocket(socket, 1013, 'loopback client backpressure exceeded');
        sockets.delete(socket);
        continue;
      }
      try {
        socket.send(encoded);
        accepted = true;
      } catch {
        sockets.delete(socket);
      }
    }
    return accepted;
  };
  const workerStreamEvent = (chunk: string, offset?: number) => ({
    kind: 'worker_stream',
    name: options.agent,
    stream: 'stdout',
    chunk,
    ...(offset === undefined ? {} : { offset }),
  });
  const retainOutput = (chunk: string, offset: number | undefined): boolean => {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (outputHistoryBytes + bytes > MAX_BUFFERED_BYTES) return false;
    outputHistory.push({ chunk, ...(offset === undefined ? {} : { offset }) });
    outputHistoryBytes += bytes;
    return true;
  };

  /**
   * Report a PTY-input failure to one input socket the way the broker does:
   * with the `retryable` flag the SDK reads, and — for a connection-fatal
   * code — by closing the socket so the client's `PtyInputStream` latches
   * `closed` and its recovery can start buffering. See
   * {@link inputErrorIsConnectionFatal}.
   */
  const failInputSocket = (socket: WebSocket, code: string, message: string): void => {
    const fatal = inputErrorIsConnectionFatal(code);
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'pty_input_error', code, message, retryable: !fatal }));
      } catch {
        // The socket is already gone; the close below is still correct.
      }
    }
    if (!fatal) return;
    inputSockets.delete(socket);
    closeSocket(socket, 1011, message);
  };

  /** Same, for every attached input socket (session-scoped failures). */
  const failAllInputSockets = (code: string, message: string): void => {
    for (const socket of [...inputSockets]) failInputSocket(socket, code, message);
  };

  websocketServer.on('connection', (socket, request) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/ws') {
      eventSockets.add(socket);
      socket.on('close', () => eventSockets.delete(socket));
      let replayed = 0;
      for (const event of outputHistory) {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) break;
        try {
          socket.send(JSON.stringify(workerStreamEvent(event.chunk, event.offset)));
        } catch {
          break;
        }
        replayed += 1;
      }
      if (replayed > 0) {
        const sentBytes = outputHistory
          .slice(0, replayed)
          .reduce((total, event) => total + Buffer.byteLength(event.chunk, 'utf8'), 0);
        outputHistory.splice(0, replayed);
        outputHistoryBytes -= sentBytes;
      }
      return;
    }
    if (path === `/api/input/${encodeURIComponent(options.agent)}/stream`) {
      inputSockets.add(socket);
      socket.on('close', () => inputSockets.delete(socket));
      socket.send(JSON.stringify({ type: 'pty_input_ready', name: options.agent }));
      socket.on('message', (data) => {
        if (!remote || remote.readyState !== WebSocket.OPEN || remote.bufferedAmount > MAX_BUFFERED_BYTES) {
          // Only THIS socket failed to write; a sibling input stream must not
          // be torn down for it. `node_unreachable` is connection-fatal, so
          // this also closes the socket — see failInputSocket.
          failInputSocket(socket, 'node_unreachable', 'terminal transport is unavailable');
          return;
        }
        const raw = rawDataToString(data);
        remote.send(
          JSON.stringify({
            type: 'terminal.input',
            session_id: sessionId,
            data_base64: Buffer.from(raw, 'utf8').toString('base64'),
          })
        );
      });
      return;
    }
    closeSocket(socket, 1008, 'unknown loopback endpoint');
  });
  server.on('upgrade', (request, socket, head) => {
    if (!loopbackAuthorized(request.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) =>
      websocketServer.emit('connection', client, request)
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new FleetNodeAttachError(
      'Error: could not allocate loopback terminal listener.',
      'loopback_unavailable'
    );

  const resumeUrlForCurrentSession = () => {
    const resumeUrl = new URL(terminalUrl);
    resumeUrl.searchParams.delete('ticket');
    resumeUrl.searchParams.set('session_id', sessionId);
    resumeUrl.searchParams.set('resume', resumeToken);
    return resumeUrl.toString();
  };
  const terminalSessionExpired = () => {
    if (!expiresAt) return false;
    const expiresAtMs = Date.parse(expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  };
  // A disconnected terminal can need one replacement session when its resume
  // credential has expired. Keep this scoped to the whole reconnect incident:
  // a replacement that itself drops still follows the normal bounded resume
  // budget instead of repeatedly allocating sessions.
  let replacementAllocatedForReconnect = false;
  const allocateReplacementTerminalSession = async (): Promise<{
    terminalUrl: string;
    sessionId: string;
    resumeToken: string;
    expiresAt: string | undefined;
  }> => {
    const replacementDeadline = Date.now() + sessionRequestTotalTimeoutMs;
    let lastReplacementError: TerminalSessionAttemptError | undefined;
    const result = await collectWithRetry(
      'replacement terminal session request',
      async () => {
        const remainingMs = replacementDeadline - Date.now();
        if (remainingMs <= 0) {
          throw new TerminalSessionAttemptError(
            lastReplacementError?.message ??
              'overall replacement terminal-session request deadline exhausted',
            lastReplacementError?.code ?? 'control_plane_timeout',
            lastReplacementError?.status,
            false,
            lastReplacementError?.completionUnknown ?? false
          );
        }
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(
          () => {
            timedOut = true;
            controller.abort();
          },
          Math.min(sessionRequestTimeoutMs, remainingMs)
        );
        try {
          const response = await fetchFn(sessionEndpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
            // Keep the replacement bound to precisely the session this proxy was
            // already serving; never infer a different agent or delivery mode.
            body: JSON.stringify({ agent: options.agent, mode: options.mode }),
            signal: controller.signal,
          });
          const parsed = (await response.json()) as unknown;
          const payload =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as FleetSessionResponse)
              : {};
          const replacementUrl = payload.data?.terminal_url;
          const replacementSessionId = payload.data?.session_id;
          const replacementResumeToken = payload.data?.resume_token;
          if (!response.ok || !replacementUrl || !replacementSessionId || !replacementResumeToken) {
            const error = new TerminalSessionAttemptError(
              payload.error?.message ??
                'terminal session could not be replaced after its resume credential expired',
              payload.error?.code,
              response.status,
              isRetryableTerminalSessionFailure(payload.error?.code),
              false
            );
            lastReplacementError = error;
            throw error;
          }
          return {
            terminalUrl: replacementUrl,
            sessionId: replacementSessionId,
            resumeToken: replacementResumeToken,
            expiresAt: payload.data?.expires_at,
          };
        } catch (error) {
          if (error instanceof TerminalSessionAttemptError) throw error;
          const replacementError = new TerminalSessionAttemptError(
            timedOut
              ? 'replacement request exceeded its deadline'
              : 'replacement terminal session request failed',
            timedOut ? 'control_plane_timeout' : 'control_plane_unavailable',
            undefined,
            false,
            true
          );
          lastReplacementError = replacementError;
          throw replacementError;
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        retries: SESSION_REQUEST_RETRIES,
        baseDelayMs: SESSION_REQUEST_RETRY_DELAY_MS,
        sleep: async (delayMs) => {
          const remainingMs = replacementDeadline - Date.now();
          if (remainingMs > 0) await sessionRequestSleep(Math.min(delayMs, remainingMs));
        },
        shouldRetry: (error) => error instanceof TerminalSessionAttemptError && error.retryable,
      }
    );
    if (result.ok) return result.value;
    if (lastReplacementError) throw lastReplacementError;
    throw new FleetNodeAttachError(
      'terminal session could not be replaced after its resume credential expired',
      'terminal_session_unavailable'
    );
  };
  /** Reject and clear any in-flight delivery-mode PUT, if one is pending. */
  const rejectPendingDeliveryMode = (error: FleetNodeAttachError) => {
    if (pendingFlush) {
      const flush = pendingFlush;
      pendingFlush = null;
      clearTimeout(flush.timer);
      // A flush never changes delivery mode, so it must not inherit the
      // delivery-mode disconnect wording. An operator debugging a failed flush
      // would otherwise be told the "delivery-mode change" was interrupted —
      // pointing at an operation their command never performed.
      const flushError =
        error.code === 'delivery_mode_disconnected'
          ? new FleetNodeAttachError(
              'terminal transport disconnected while the flush was in flight',
              'flush_disconnected'
            )
          : error;
      flush.reject(flushError);
    }
    if (!pendingDeliveryMode) return;
    const pending = pendingDeliveryMode;
    pendingDeliveryMode = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  };
  const endTerminal = (error: FleetNodeAttachError, eventCloseReason = error.message) => {
    if (terminalEnded) return;
    terminalEnded = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    for (const timer of terminalReadinessTimers) clearTimeout(timer);
    terminalReadinessTimers.clear();
    rejectPendingDeliveryMode(error);
    const activeRemote = remote;
    remote = undefined;
    rejectReadiness(activeReadiness, error);
    failAllInputSockets(error.code ?? 'terminal_error', error.message);
    for (const socket of eventSockets) closeSocket(socket, 1011, eventCloseReason);
    if (activeRemote && activeRemote.readyState !== WebSocket.CLOSED) {
      try {
        activeRemote.terminate();
      } catch {
        // The socket may have closed between the state check and terminate.
      }
    }
  };
  const failRemote = (message: string, eventCloseReason?: string) => {
    endTerminal(new FleetNodeAttachError(message, 'node_unreachable'), eventCloseReason);
  };
  const connect = (url: string, readiness: TerminalReadiness) => {
    if (stopped || terminalEnded) return;
    const socket = new WebSocket(asWsUrl(url), { handshakeTimeout: terminalHandshakeTimeoutMs });
    remote = socket;
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    let readinessExpired = false;
    let resumeRejectedAsExpired = false;
    const clearReadinessTimer = () => {
      if (!readinessTimer) return;
      clearTimeout(readinessTimer);
      terminalReadinessTimers.delete(readinessTimer);
      readinessTimer = undefined;
    };
    socket.on('open', () => {
      // `handshakeTimeout` independently bounds the HTTP upgrade. Start the
      // terminal.ready allowance only after that upgrade succeeds so a slow
      // but valid handshake cannot consume the readiness window.
      readinessTimer = setTimeout(() => {
        const expiredTimer = readinessTimer;
        readinessTimer = undefined;
        if (expiredTimer) terminalReadinessTimers.delete(expiredTimer);
        if (remote !== socket || stopped || terminalEnded || readiness.settled) return;
        // Mark this generation stale before terminating. The ws receiver may
        // still deliver data already buffered on the socket while close is
        // propagating; none of it may restore readiness or reset retry state.
        readinessExpired = true;
        if (!terminalEverReady) {
          failRemote(
            `terminal transport connected but did not become ready (node ref ${diagnosticValue(options.node.trim())},` +
              ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint())},` +
              ` readiness timeout ${terminalReadyTimeoutMs}ms, attempts 1; not retried because no terminal session became ready)`
          );
          return;
        }
        // A successful WebSocket upgrade is not sufficient: Relaycast may
        // accept a resume lane that never produces terminal.ready. Terminating
        // it drives the same bounded close/retry path as a transport failure.
        options.reconnectDelay?.beforeReadyTimeoutTerminate?.(socket);
        socket.terminate();
      }, terminalReadyTimeoutMs);
      terminalReadinessTimers.add(readinessTimer);
    });
    socket.on('message', (data) => {
      // A late frame from a transport superseded during reconnect must never
      // overwrite the fresh snapshot or end the replacement session.
      if (remote !== socket || stopped || terminalEnded || readinessExpired) return;
      const frame = parseFrame(data);
      if (!frame || frame.session_id !== sessionId) return;
      if (frame.type === 'terminal.ready') {
        clearReadinessTimer();
        snapshot.screenBase64 = typeof frame.screen === 'string' ? frame.screen : '';
        // A payload that will not decode is kept out of `screenAnsi` entirely
        // so no later consumer can render it; the HTTP snapshot still serves
        // the bytes verbatim and lets its own decoder report the problem.
        snapshot.screenAnsi = decodeAnsiScreenPayload(snapshot.screenBase64) ?? '';
        snapshot.rows = typeof frame.rows === 'number' ? frame.rows : 24;
        snapshot.cols = typeof frame.cols === 'number' ? frame.cols : 80;
        snapshot.offset = typeof frame.offset === 'number' ? frame.offset : 0;
        // Seed loopbackDeliveryMode from the broker's actual state so that
        // detach restores the correct mode even when the worker started in a
        // different mode than our local inference at line 214.
        if (frame.delivery_mode === 'manual_flush' || frame.delivery_mode === 'auto_inject') {
          loopbackDeliveryMode = frame.delivery_mode;
        }
        terminalEverReady = true;
        reconnectAttempts = 0;
        replacementAllocatedForReconnect = false;
        if (readiness === activeReadiness) {
          resolveReadiness(readiness);
          // A reconnect gets a fresh ANSI grid but existing local `/ws`
          // consumers have already performed their initial HTTP snapshot.
          // Re-emit this screen without an offset so they repaint instead of
          // retaining a stale pre-reconnect terminal image. It must be the
          // DECODED grid: a `worker_stream` chunk is raw PTY bytes that the
          // attach client writes straight to the terminal, so the base64 form
          // renders as a wall of text instead of a repaint (relay#1829).
          if (readiness.generation > 1 && snapshot.screenAnsi) {
            broadcast(eventSockets, workerStreamEvent(snapshot.screenAnsi));
          }
        }
      } else if (frame.type === 'terminal.output' && typeof frame.chunk === 'string') {
        const offset = typeof frame.offset === 'number' ? frame.offset : undefined;
        if (!broadcast(eventSockets, workerStreamEvent(frame.chunk, offset))) {
          if (!retainOutput(frame.chunk, offset)) {
            endTerminal(
              new FleetNodeAttachError(
                'terminal output exceeded the bounded loopback buffer',
                'output_backpressure'
              )
            );
          }
        }
      } else if (frame.type === 'terminal.input_ack') {
        broadcast(inputSockets, {
          type: 'pty_input_ack',
          name: options.agent,
          bytes_written: typeof frame.bytes_written === 'number' ? frame.bytes_written : 0,
        });
      } else if (frame.type === 'terminal.delivery_mode') {
        const frameRid = typeof frame.request_id === 'string' ? frame.request_id : undefined;
        if (pendingDeliveryMode && (frameRid === undefined || frameRid === pendingDeliveryMode.requestId)) {
          const pending = pendingDeliveryMode;
          pendingDeliveryMode = null;
          clearTimeout(pending.timer);
          pending.resolve({
            mode: typeof frame.mode === 'string' ? frame.mode : 'auto_inject',
            flushed: typeof frame.flushed === 'number' ? frame.flushed : 0,
            ...(typeof frame.dead_lettered === 'number' ? { dead_lettered: frame.dead_lettered } : {}),
            matched: typeof frame.matched === 'boolean' ? frame.matched : true,
            revision: typeof frame.revision === 'string' ? frame.revision : '1',
            ...(typeof frame.blocked_reason === 'string' ? { blocked_reason: frame.blocked_reason } : {}),
            ...gapDiagnosticsFromFrame(frame),
          });
        }
      } else if (frame.type === 'terminal.flush_pending') {
        const frameRid = typeof frame.request_id === 'string' ? frame.request_id : undefined;
        // Exact match only. The proxy always sends a request_id, and unlike
        // delivery-mode there is no older-broker reply shape to stay
        // compatible with, so a reply without one is not ours — accepting it
        // would resolve the caller's flush with an unrelated result.
        if (pendingFlush && frameRid === pendingFlush.requestId) {
          const pending = pendingFlush;
          pendingFlush = null;
          clearTimeout(pending.timer);
          pending.resolve({
            flushed: typeof frame.flushed === 'number' ? frame.flushed : 0,
            dead_lettered: typeof frame.dead_lettered === 'number' ? frame.dead_lettered : 0,
            held: typeof frame.held === 'number' ? frame.held : 0,
            blocked_reason: typeof frame.blocked_reason === 'string' ? frame.blocked_reason : null,
            ...gapDiagnosticsFromFrame(frame),
          });
        }
      } else if (frame.type === 'terminal.error') {
        const message = typeof frame.message === 'string' ? frame.message : 'remote terminal failed';
        const code = typeof frame.code === 'string' ? frame.code : 'terminal_error';
        const frameRid = typeof frame.request_id === 'string' ? frame.request_id : undefined;
        // Route the error to the pending delivery-mode request only when the
        // request_id matches (or the broker sent no request_id at all — older
        // broker compat). An unrelated session-level error must not cancel a
        // live delivery-mode PUT and vice-versa.
        if (pendingFlush && frameRid !== undefined && frameRid === pendingFlush.requestId) {
          const pending = pendingFlush;
          pendingFlush = null;
          clearTimeout(pending.timer);
          pending.reject(new FleetNodeAttachError(message, code));
        } else if (
          pendingDeliveryMode &&
          (frameRid === undefined || frameRid === pendingDeliveryMode.requestId)
        ) {
          const pending = pendingDeliveryMode;
          pendingDeliveryMode = null;
          clearTimeout(pending.timer);
          pending.reject(new FleetNodeAttachError(message, code));
        } else if (!frameRid && readiness === activeReadiness && !readiness.settled) {
          endTerminal(new FleetNodeAttachError(message, code));
        } else if (!frameRid) {
          failAllInputSockets(code, message);
        }
      } else if (frame.type === 'terminal.closed') {
        endTerminal(new FleetNodeAttachError('remote terminal session closed', 'terminal_closed'));
      }
    });
    socket.on('error', (error) => {
      readinessExpired = true;
      clearReadinessTimer();
      // `ws` exposes a refused HTTP upgrade as this error before `close`.
      // Only an expired resume credential may mint a replacement terminal;
      // notably a transient or 5xx failure stays on the resume path.
      if (
        terminalEverReady &&
        error instanceof Error &&
        /Unexpected server response: (401|410)\b/.test(error.message)
      ) {
        resumeRejectedAsExpired = true;
      }
      // Initial connection failure has no terminal state worth preserving.
      // Fail promptly with the canonical unavailable-node error instead of
      // letting the HTTP snapshot timeout mask it. Once Ready has been seen,
      // the close handler retains the bounded resume/backoff behaviour.
      if (remote === socket && readiness === activeReadiness && !readiness.settled && !terminalEverReady) {
        failRemote(
          `terminal transport could not connect to the fleet node (node ref ${diagnosticValue(options.node.trim())},` +
            ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint())},` +
            ` handshake budget ${terminalHandshakeTimeoutMs}ms, attempts 1; not retried because no terminal session became ready)`
        );
      }
    });
    socket.on('close', () => {
      readinessExpired = true;
      clearReadinessTimer();
      if (remote !== socket || stopped || terminalEnded || reconnecting) return;
      // Relaycast drops the old lane's terminal session state on disconnect,
      // so a set_delivery_mode frame already sent on this dying socket is
      // lost and will never get a reply on the replacement socket — even
      // once reconnect succeeds. Fail the pending PUT fast with a retryable
      // error instead of leaving it to hang out the full timeout.
      rejectPendingDeliveryMode(
        new FleetNodeAttachError(
          'terminal transport disconnected while the delivery-mode change was in flight',
          'delivery_mode_disconnected'
        )
      );
      // Any waiter that observed the prior connection must retry against the
      // fresh generation instead of receiving its stale resolved snapshot.
      resolveReadiness(readiness);
      const nextReadiness = createReadiness();
      activeReadiness = nextReadiness;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        const backoffBudgetMs = retryDelayBudgetMs(
          MAX_RECONNECT_ATTEMPTS,
          reconnectInitialDelayMs,
          reconnectMaxDelayMs
        );
        const message =
          `terminal transport could not reconnect to the fleet node (node ref ${diagnosticValue(options.node.trim())},` +
          ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint())},` +
          ` handshake timeout ${terminalHandshakeTimeoutMs}ms, readiness timeout ${terminalReadyTimeoutMs}ms,` +
          ` attempts ${reconnectAttempts},` +
          ` backoff budget ${backoffBudgetMs}ms)`;
        failRemote(
          message,
          `terminal reconnect failed; attempts=${reconnectAttempts}; budget=${backoffBudgetMs}ms;` +
            ` endpoint=${diagnosticValue(diagnosticEndpointOrigin(terminalUrl))};` +
            ` node=${diagnosticValue(resolvedNodeId ?? options.node.trim())}`
        );
        return;
      }
      reconnecting = true;
      const delay = Math.min(reconnectInitialDelayMs * 2 ** reconnectAttempts, reconnectMaxDelayMs);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        reconnecting = false;
        const needsReplacement =
          !replacementAllocatedForReconnect && (resumeRejectedAsExpired || terminalSessionExpired());
        if (!needsReplacement) {
          connect(resumeUrlForCurrentSession(), nextReadiness);
          return;
        }
        replacementAllocatedForReconnect = true;
        void allocateReplacementTerminalSession().then(
          (replacement) => {
            if (stopped || terminalEnded || activeReadiness !== nextReadiness) return;
            // This has no await between assignments, so every loopback
            // handler observes one coherent replacement session.
            terminalUrl = replacement.terminalUrl;
            sessionId = replacement.sessionId;
            resumeToken = replacement.resumeToken;
            expiresAt = replacement.expiresAt;
            connect(terminalUrl, nextReadiness);
          },
          (error) => {
            if (stopped || terminalEnded || activeReadiness !== nextReadiness) return;
            const replacementError =
              error instanceof FleetNodeAttachError
                ? error
                : new FleetNodeAttachError(
                    'terminal session could not be replaced after its resume credential expired',
                    'terminal_session_unavailable'
                  );
            endTerminal(
              new FleetNodeAttachError(
                `terminal transport could not replace an expired terminal session (node ref ${diagnosticValue(options.node.trim())},` +
                  ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint())})`,
                replacementError.code
              )
            );
          }
        );
      }, delay);
    });
  };
  connect(terminalUrl, activeReadiness);

  return {
    brokerUrl: `http://127.0.0.1:${address.port}`,
    apiKey: loopbackApiKey,
    requestTimeoutMs: terminalWaitTimeoutMs + DELIVERY_MODE_TIMEOUT_MS + LOOPBACK_REQUEST_TIMEOUT_MARGIN_MS,
    async close() {
      if (stopped) return;
      stopped = true;
      terminalEnded = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      for (const timer of terminalReadinessTimers) clearTimeout(timer);
      terminalReadinessTimers.clear();
      rejectReadiness(activeReadiness, new FleetNodeAttachError('terminal attach closed', 'closed'));
      rejectPendingDeliveryMode(new FleetNodeAttachError('terminal attach closed', 'closed'));
      const activeRemote = remote;
      remote = undefined;
      if (activeRemote && activeRemote.readyState === WebSocket.OPEN) {
        try {
          activeRemote.send(JSON.stringify({ type: 'terminal.close', session_id: sessionId }));
        } catch {
          // Best effort; terminate below still prevents a late reconnect.
        }
      }
      if (activeRemote && activeRemote.readyState !== WebSocket.CLOSED) {
        try {
          activeRemote.terminate();
        } catch {
          // Socket is already gone.
        }
      }
      for (const socket of [...eventSockets, ...inputSockets])
        closeSocket(socket, 1000, 'terminal attach closed');
      websocketServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
