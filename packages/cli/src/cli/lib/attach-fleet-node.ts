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

import WebSocket, { WebSocketServer } from 'ws';

import type { AttachMode } from './attach-mode.js';
import { resolveBaseUrl, resolveWorkspaceKey } from './sdk-client.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const SNAPSHOT_WAIT_MS = 10_000;
const RECONNECT_DELAY_MS = 500;

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
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body) as unknown;
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        );
      } catch {
        resolve({});
      }
    });
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

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A connection failure can land before the first snapshot request attaches
  // its waiter. Keep that rejection observable to the request while avoiding
  // an unhandled-rejection process warning in the small intervening window.
  void ready.catch(() => undefined);
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
  let reconnecting = false;

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === `/api/spawned/${encodeURIComponent(options.agent)}/snapshot`) {
      try {
        await Promise.race([
          ready,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('terminal snapshot timed out')), SNAPSHOT_WAIT_MS)
          ),
        ]);
      } catch (error) {
        json(response, 503, {
          error: {
            code: 'snapshot_unavailable',
            message: error instanceof Error ? error.message : 'snapshot unavailable',
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
  const broadcast = (sockets: Set<WebSocket>, payload: unknown) => {
    const encoded = JSON.stringify(payload);
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeSocket(socket, 1013, 'loopback client backpressure exceeded');
        sockets.delete(socket);
        continue;
      }
      socket.send(encoded);
    }
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
      for (const event of outputHistory) {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) break;
        socket.send(JSON.stringify(workerStreamEvent(event.chunk, event.offset)));
      }
      outputHistory.length = 0;
      outputHistoryBytes = 0;
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
  const connect = (url: string, isResume: boolean) => {
    if (stopped) return;
    const socket = new WebSocket(asWsUrl(url));
    remote = socket;
    socket.on('message', (data) => {
      const frame = parseFrame(data);
      if (!frame || frame.session_id !== sessionId) return;
      if (frame.type === 'terminal.ready') {
        snapshot.screen = typeof frame.screen === 'string' ? frame.screen : '';
        snapshot.rows = typeof frame.rows === 'number' ? frame.rows : 24;
        snapshot.cols = typeof frame.cols === 'number' ? frame.cols : 80;
        snapshot.offset = typeof frame.offset === 'number' ? frame.offset : 0;
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
      } else if (frame.type === 'terminal.output' && typeof frame.chunk === 'string') {
        const offset = typeof frame.offset === 'number' ? frame.offset : undefined;
        if (eventSockets.size === 0 && !retainOutput(frame.chunk, offset)) {
          broadcast(inputSockets, {
            type: 'pty_input_error',
            code: 'output_backpressure',
            message: 'terminal output exceeded the bounded loopback buffer',
          });
          if (remote?.readyState === WebSocket.OPEN) remote.close(1013, 'output backpressure');
          return;
        }
        broadcast(eventSockets, workerStreamEvent(frame.chunk, offset));
      } else if (frame.type === 'terminal.input_ack') {
        broadcast(inputSockets, {
          type: 'pty_input_ack',
          name: options.agent,
          bytes_written: typeof frame.bytes_written === 'number' ? frame.bytes_written : 0,
        });
      } else if (frame.type === 'terminal.error') {
        const message = typeof frame.message === 'string' ? frame.message : 'remote terminal failed';
        const code = typeof frame.code === 'string' ? frame.code : 'terminal_error';
        broadcast(inputSockets, { type: 'pty_input_error', code, message });
        if (!readySettled) {
          readySettled = true;
          rejectReady(new FleetNodeAttachError(message, code));
        }
      } else if (frame.type === 'terminal.closed') {
        broadcast(inputSockets, {
          type: 'pty_input_error',
          code: 'terminal_closed',
          message: 'remote terminal session closed',
        });
      }
    });
    socket.on('error', (error) => {
      if (!readySettled && !isResume) {
        readySettled = true;
        rejectReady(
          new FleetNodeAttachError(`terminal websocket failed: ${error.message}`, 'node_unreachable')
        );
      }
    });
    socket.on('close', () => {
      if (remote !== socket || stopped || reconnecting) return;
      reconnecting = true;
      setTimeout(() => {
        reconnecting = false;
        connect(resumeUrl.toString(), true);
      }, RECONNECT_DELAY_MS);
    });
  };
  connect(terminalUrl, false);

  return {
    brokerUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (stopped) return;
      stopped = true;
      if (!readySettled) {
        readySettled = true;
        rejectReady(new FleetNodeAttachError('terminal attach closed', 'closed'));
      }
      if (remote && remote.readyState === WebSocket.OPEN) {
        remote.send(JSON.stringify({ type: 'terminal.close', session_id: sessionId }));
        remote.close();
      }
      for (const socket of [...eventSockets, ...inputSockets])
        closeSocket(socket, 1000, 'terminal attach closed');
      websocketServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
