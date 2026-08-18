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

import type { AttachMode } from './attach-mode.js';
import { collectWithRetry } from './collect-with-retry.js';
import { resolveBaseUrl, resolveWorkspaceKey } from './sdk-client.js';

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

type FleetSessionResponse = {
  ok?: boolean;
  data?: {
    session_id?: string;
    terminal_url?: string;
    resume_token?: string;
  };
  error?: { code?: string; message?: string };
};

type TerminalFrame = Record<string, unknown> & { type?: string; session_id?: string };

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
  const workspaceKey = options.workspaceKey ?? resolveWorkspaceKey({ env });
  const baseUrl = (options.baseUrl ?? resolveBaseUrl({ env }) ?? 'https://cast.agentrelay.com').replace(
    /\/+$/,
    ''
  );
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
  let lastSessionError: TerminalSessionAttemptError | undefined;
  const sessionResult = await collectWithRetry(
    'terminal session request',
    async () => {
      const remainingRequestBudgetMs = sessionRequestDeadline - Date.now();
      if (remainingRequestBudgetMs <= 0) {
        lastSessionError = new TerminalSessionAttemptError(
          'overall terminal-session request deadline exhausted',
          'control_plane_timeout',
          undefined,
          false,
          false
        );
        throw lastSessionError;
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
      return { terminalUrl, sessionId, resumeToken };
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
    const retryNote =
      sessionRequestAttempts > 1
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
  const { terminalUrl, sessionId, resumeToken } = sessionResult.value;
  const resolvedNodeId = resolvedNodeIdFromTerminalUrl(terminalUrl);
  const remoteEndpoint = diagnosticEndpoint(terminalUrl);
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
    MAX_RECONNECT_ATTEMPTS * (terminalHandshakeTimeoutMs + terminalReadyTimeoutMs);

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
  const snapshot: { screen: string; rows: number; cols: number; offset: number } = {
    screen: '',
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
  type DeliveryModeResult = { mode: string; flushed: number; matched: boolean; revision: string };
  /** At most one in-flight delivery-mode PUT at a time. */
  let pendingDeliveryMode: {
    requestId: string;
    resolve: (result: DeliveryModeResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const DELIVERY_MODE_TIMEOUT_MS = 10_000;
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
      json(response, 200, { format: 'ansi', ...snapshot });
      return;
    }
    const name = encodeURIComponent(options.agent);
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
        matched: result.matched,
        revision: result.revision,
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
          broadcast(inputSockets, {
            type: 'pty_input_error',
            code: 'node_unreachable',
            message: 'terminal transport is unavailable',
          });
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

  const resumeUrl = new URL(terminalUrl);
  resumeUrl.searchParams.delete('ticket');
  resumeUrl.searchParams.set('session_id', sessionId);
  resumeUrl.searchParams.set('resume', resumeToken);
  /** Reject and clear any in-flight delivery-mode PUT, if one is pending. */
  const rejectPendingDeliveryMode = (error: FleetNodeAttachError) => {
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
    broadcast(inputSockets, { type: 'pty_input_error', code: error.code, message: error.message });
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
              ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint)},` +
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
        snapshot.screen = typeof frame.screen === 'string' ? frame.screen : '';
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
        if (readiness === activeReadiness) {
          resolveReadiness(readiness);
          // A reconnect gets a fresh ANSI grid but existing local `/ws`
          // consumers have already performed their initial HTTP snapshot.
          // Re-emit this screen without an offset so they repaint instead of
          // retaining a stale pre-reconnect terminal image.
          if (readiness.generation > 1 && snapshot.screen) {
            broadcast(eventSockets, workerStreamEvent(snapshot.screen));
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
            matched: typeof frame.matched === 'boolean' ? frame.matched : true,
            revision: typeof frame.revision === 'string' ? frame.revision : '1',
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
        if (pendingDeliveryMode && (frameRid === undefined || frameRid === pendingDeliveryMode.requestId)) {
          const pending = pendingDeliveryMode;
          pendingDeliveryMode = null;
          clearTimeout(pending.timer);
          pending.reject(new FleetNodeAttachError(message, code));
        } else if (!frameRid && readiness === activeReadiness && !readiness.settled) {
          endTerminal(new FleetNodeAttachError(message, code));
        } else if (!frameRid) {
          broadcast(inputSockets, { type: 'pty_input_error', code, message });
        }
      } else if (frame.type === 'terminal.closed') {
        endTerminal(new FleetNodeAttachError('remote terminal session closed', 'terminal_closed'));
      }
    });
    socket.on('error', () => {
      readinessExpired = true;
      clearReadinessTimer();
      // Initial connection failure has no terminal state worth preserving.
      // Fail promptly with the canonical unavailable-node error instead of
      // letting the HTTP snapshot timeout mask it. Once Ready has been seen,
      // the close handler retains the bounded resume/backoff behaviour.
      if (remote === socket && readiness === activeReadiness && !readiness.settled && !terminalEverReady) {
        failRemote(
          `terminal transport could not connect to the fleet node (node ref ${diagnosticValue(options.node.trim())},` +
            ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint)},` +
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
          ` resolved node id ${diagnosticValue(resolvedNodeId ?? 'unavailable')}, endpoint ${diagnosticValue(remoteEndpoint)},` +
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
        connect(resumeUrl.toString(), nextReadiness);
      }, delay);
    });
  };
  connect(terminalUrl, activeReadiness);

  return {
    brokerUrl: `http://127.0.0.1:${address.port}`,
    apiKey: loopbackApiKey,
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
