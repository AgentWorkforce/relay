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
import { resolveBaseUrl, resolveWorkspaceKey } from './sdk-client.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const SNAPSHOT_WAIT_MS = 10_000;
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;

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
  return value.replace(/^http/i, 'ws');
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
  const ticketResponse = await fetchFn(`${baseUrl}/v1/nodes/${nodePath}/terminal/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workspaceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: options.agent, mode: options.mode }),
  });
  const ticketPayload = (await ticketResponse.json().catch(() => ({}))) as FleetSessionResponse;
  const terminalUrl = ticketPayload.data?.terminal_url;
  const sessionId = ticketPayload.data?.session_id;
  const resumeToken = ticketPayload.data?.resume_token;
  if (!ticketResponse.ok || !terminalUrl || !sessionId || !resumeToken) {
    const code = ticketPayload.error?.code;
    const message =
      ticketPayload.error?.message ?? `terminal session request failed (HTTP ${ticketResponse.status})`;
    throw new FleetNodeAttachError(`Error: ${message}`, code);
  }

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
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('terminal snapshot timed out')), SNAPSHOT_WAIT_MS);
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
      } catch (error) {
        const terminalError = error instanceof FleetNodeAttachError ? error : undefined;
        const status =
          terminalError?.code === 'agent_not_found'
            ? 404
            : terminalError?.code === 'unsupported_runtime'
              ? 409
              : 503;
        json(response, status, {
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
        json(response, 200, { mode: options.mode === 'drive' ? 'manual_flush' : 'auto_inject' });
      } else {
        await readBody(request);
        json(response, 200, {
          mode: options.mode === 'drive' ? 'manual_flush' : 'auto_inject',
          flushed: 0,
          matched: true,
          revision: '1',
        });
      }
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
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('terminal resize timed out')), SNAPSHOT_WAIT_MS);
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
      socket.close(code, reason);
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
  const endTerminal = (error: FleetNodeAttachError) => {
    if (terminalEnded) return;
    terminalEnded = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const activeRemote = remote;
    remote = undefined;
    rejectReadiness(activeReadiness, error);
    broadcast(inputSockets, { type: 'pty_input_error', code: error.code, message: error.message });
    for (const socket of eventSockets) closeSocket(socket, 1011, error.message);
    if (activeRemote && activeRemote.readyState !== WebSocket.CLOSED) {
      try {
        activeRemote.terminate();
      } catch {
        // The socket may have closed between the state check and terminate.
      }
    }
  };
  const failRemote = (message: string) => {
    endTerminal(new FleetNodeAttachError(message, 'node_unreachable'));
  };
  const connect = (url: string, readiness: TerminalReadiness) => {
    if (stopped || terminalEnded) return;
    const socket = new WebSocket(asWsUrl(url));
    remote = socket;
    socket.on('message', (data) => {
      // A late frame from a transport superseded during reconnect must never
      // overwrite the fresh snapshot or end the replacement session.
      if (remote !== socket || stopped || terminalEnded) return;
      const frame = parseFrame(data);
      if (!frame || frame.session_id !== sessionId) return;
      if (frame.type === 'terminal.ready') {
        snapshot.screen = typeof frame.screen === 'string' ? frame.screen : '';
        snapshot.rows = typeof frame.rows === 'number' ? frame.rows : 24;
        snapshot.cols = typeof frame.cols === 'number' ? frame.cols : 80;
        snapshot.offset = typeof frame.offset === 'number' ? frame.offset : 0;
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
      } else if (frame.type === 'terminal.error') {
        const message = typeof frame.message === 'string' ? frame.message : 'remote terminal failed';
        const code = typeof frame.code === 'string' ? frame.code : 'terminal_error';
        if (readiness === activeReadiness && !readiness.settled) {
          endTerminal(new FleetNodeAttachError(message, code));
        } else {
          broadcast(inputSockets, { type: 'pty_input_error', code, message });
        }
      } else if (frame.type === 'terminal.closed') {
        endTerminal(new FleetNodeAttachError('remote terminal session closed', 'terminal_closed'));
      }
    });
    socket.on('error', () => {
      // Initial connection failure has no terminal state worth preserving.
      // Fail promptly with the canonical unavailable-node error instead of
      // letting the HTTP snapshot timeout mask it. Once Ready has been seen,
      // the close handler retains the bounded resume/backoff behaviour.
      if (remote === socket && readiness === activeReadiness && !readiness.settled && !terminalEverReady) {
        failRemote('terminal transport could not connect to the fleet node');
      }
    });
    socket.on('close', () => {
      if (remote !== socket || stopped || terminalEnded || reconnecting) return;
      // Any waiter that observed the prior connection must retry against the
      // fresh generation instead of receiving its stale resolved snapshot.
      resolveReadiness(readiness);
      const nextReadiness = createReadiness();
      activeReadiness = nextReadiness;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        failRemote('terminal transport could not reconnect to the fleet node');
        return;
      }
      reconnecting = true;
      const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
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
      rejectReadiness(activeReadiness, new FleetNodeAttachError('terminal attach closed', 'closed'));
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
