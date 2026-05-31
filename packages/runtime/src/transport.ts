/**
 * BrokerTransport — HTTP/WS transport layer for communicating with the
 * agent-relay broker. Used internally by RuntimeClient.
 *
 * Handles:
 * - HTTP requests with API key auth and structured error parsing
 * - WebSocket connection for real-time event streaming
 * - Event buffering, replay, and query (mirrors stdio client behavior)
 */

import WebSocket, { type RawData } from 'ws';
import type { BrokerEvent } from './protocol.js';

export class RuntimeProtocolError extends Error {
  code: string;
  retryable: boolean;
  status?: number;
  data?: unknown;

  constructor(payload: {
    code: string;
    message: string;
    retryable?: boolean;
    status?: number;
    data?: unknown;
  }) {
    super(payload.message);
    this.name = 'RuntimeProtocolError';
    this.code = payload.code;
    this.retryable = payload.retryable ?? false;
    this.status = payload.status;
    this.data = payload.data;
  }
}

export interface BrokerTransportOptions {
  baseUrl: string;
  apiKey?: string;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Timeout in ms for HTTP requests. Default: 30000. */
  requestTimeoutMs?: number;
  /** Maximum number of events to buffer in memory for queryEvents/getLastEvent */
  maxBufferSize?: number;
}

export interface PtyInputStreamOptions {
  /** Maximum queued + in-flight UTF-8 bytes before send() rejects. Default: 1 MiB. */
  highWaterMarkBytes?: number;
  /** Timeout in ms for the websocket open handshake. Default: 10000. */
  openTimeoutMs?: number;
}

export interface PtyInputWriteResult {
  name: string;
  bytes_written: number;
}

interface PendingPtyInput {
  data: string;
  bytes: number;
  resolve: (result: PtyInputWriteResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

const DEFAULT_INPUT_HIGH_WATER_MARK_BYTES = 1024 * 1024;
const DEFAULT_INPUT_OPEN_TIMEOUT_MS = 10_000;

export class PtyInputStream {
  private readonly ws: WebSocket;
  private readonly queue: PendingPtyInput[] = [];
  private readonly highWaterMarkBytes: number;
  private readonly openPromise: Promise<void>;
  private openResolve?: () => void;
  private openReject?: (error: Error) => void;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: PendingPtyInput | null = null;
  private bufferedBytes = 0;
  private opened = false;
  private _closed = false;
  private flushing = false;

  constructor(options: { url: string; apiKey?: string } & PtyInputStreamOptions) {
    this.highWaterMarkBytes = normalizePositiveIntegerOption(
      options.highWaterMarkBytes,
      DEFAULT_INPUT_HIGH_WATER_MARK_BYTES,
      'highWaterMarkBytes'
    );
    const openTimeoutMs = normalizePositiveIntegerOption(
      options.openTimeoutMs,
      DEFAULT_INPUT_OPEN_TIMEOUT_MS,
      'openTimeoutMs'
    );
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
    this.openPromise.catch(() => undefined);

    const headers: Record<string, string> = {};
    if (options.apiKey) {
      headers['X-API-Key'] = options.apiKey;
    }

    this.ws = new WebSocket(options.url, { headers });
    this.openTimer = setTimeout(() => {
      const error = new RuntimeProtocolError({
        code: 'input_stream_open_timeout',
        message: 'timed out opening PTY input stream',
        retryable: true,
      });
      this.rejectOpen(error);
      this.failAll(error);
      this.close();
    }, openTimeoutMs);

    this.ws.on('open', () => {
      // The broker sends pty_input_ready after it verifies the agent exists
      // and is PTY-backed. Keep queued writes blocked until that handshake.
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      this._closed = true;
      this.clearOpenTimer();
      const detail = reason.length > 0 ? `: ${reason.toString()}` : '';
      const error = new RuntimeProtocolError({
        code: 'input_stream_closed',
        message: `PTY input stream closed (${code})${detail}`,
        retryable: false,
      });
      this.rejectOpen(error);
      this.failAll(error);
    });

    this.ws.on('error', (cause) => {
      const error = new RuntimeProtocolError({
        code: 'input_stream_error',
        message: cause instanceof Error ? cause.message : 'PTY input stream failed',
        retryable: true,
        data: cause,
      });
      this.rejectOpen(error);
      this.failAll(error);
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  get bufferedAmountBytes(): number {
    return this.bufferedBytes;
  }

  waitUntilOpen(): Promise<void> {
    return this.openPromise;
  }

  send(data: string): Promise<PtyInputWriteResult> {
    if (this._closed) {
      return Promise.reject(
        new RuntimeProtocolError({
          code: 'input_stream_closed',
          message: 'PTY input stream is closed',
          retryable: false,
        })
      );
    }

    const bytes = Buffer.byteLength(data, 'utf8');
    if (this.bufferedBytes + bytes > this.highWaterMarkBytes) {
      return Promise.reject(
        new RuntimeProtocolError({
          code: 'input_backpressure',
          message: `PTY input stream buffered ${this.bufferedBytes} bytes; refusing ${bytes} more over high water mark ${this.highWaterMarkBytes}`,
          retryable: true,
        })
      );
    }

    return new Promise<PtyInputWriteResult>((resolve, reject) => {
      const pending: PendingPtyInput = {
        data,
        bytes,
        resolve,
        reject,
        settled: false,
      };
      this.queue.push(pending);
      this.bufferedBytes += bytes;
      this.flush();
    });
  }

  close(code?: number, reason?: string): void {
    if (this._closed) return;
    this._closed = true;
    this.clearOpenTimer();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
    const error = new RuntimeProtocolError({
      code: 'input_stream_closed',
      message: 'PTY input stream closed',
      retryable: false,
    });
    this.rejectOpen(error);
    this.failAll(error);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.inFlight || this.queue.length === 0 || this._closed) {
      return;
    }
    this.flushing = true;
    try {
      await this.openPromise;
    } catch (error) {
      this.failAll(asError(error));
      return;
    } finally {
      this.flushing = false;
    }

    if (this.inFlight || this.queue.length === 0 || this._closed) {
      return;
    }

    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.ws.send(next.data, (error) => {
      if (!error) return;
      if (this.inFlight === next) {
        this.inFlight = null;
      }
      const protocolError = new RuntimeProtocolError({
        code: 'input_stream_send_failed',
        message: error.message,
        retryable: true,
        data: error,
      });
      this.settle(next, protocolError);
      this.failAll(protocolError);
    });
  }

  private handleMessage(data: RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(rawDataToString(data));
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const message = payload as Record<string, unknown>;
    const type = typeof message.type === 'string' ? message.type : undefined;
    if (type === 'pty_input_ready') {
      this.opened = true;
      this.clearOpenTimer();
      this.openResolve?.();
      this.flush();
      return;
    }

    if (type === 'pty_input_ack') {
      const current = this.inFlight;
      if (!current) return;
      this.inFlight = null;
      this.settle(current, {
        name: typeof message.name === 'string' ? message.name : '',
        bytes_written: typeof message.bytes_written === 'number' ? message.bytes_written : current.bytes,
      });
      this.flush();
      return;
    }

    if (type === 'pty_input_error' || type === 'error') {
      const error = new RuntimeProtocolError({
        code: typeof message.code === 'string' ? message.code : 'input_stream_error',
        message: typeof message.message === 'string' ? message.message : 'PTY input stream failed',
        retryable: Boolean(message.retryable),
        status: typeof message.statusCode === 'number' ? message.statusCode : undefined,
        data: message,
      });
      this.rejectOpen(error);
      this.failAll(error);
      this.close();
    }
  }

  private settle(item: PendingPtyInput, result: PtyInputWriteResult | Error): void {
    if (item.settled) return;
    item.settled = true;
    this.bufferedBytes = Math.max(0, this.bufferedBytes - item.bytes);
    if (result instanceof Error) {
      item.reject(result);
    } else {
      item.resolve(result);
    }
  }

  private failAll(error: Error): void {
    if (this.inFlight) {
      this.settle(this.inFlight, error);
      this.inFlight = null;
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) this.settle(item, error);
    }
  }

  private rejectOpen(error: Error): void {
    if (!this.opened) {
      this.openReject?.(error);
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizePositiveIntegerOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RuntimeProtocolError({
      code: 'invalid_input_stream_options',
      message: `${name} must be a finite number greater than 0`,
      retryable: false,
    });
  }
  return Math.floor(resolved);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

export class BrokerTransport {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxBufferSize: number;

  private ws: WebSocket | null = null;
  private eventListeners = new Set<(event: BrokerEvent) => void>();
  private eventBuffer: BrokerEvent[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sinceSeq = 0;
  private _connected = false;
  private _intentionalClose = false;

  constructor(options: BrokerTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxBufferSize = options.maxBufferSize ?? 1000;
  }

  get connected(): boolean {
    return this._connected;
  }

  get wsUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws') + '/ws';
  }

  inputStreamUrl(name: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/input/${encodeURIComponent(name)}/stream`;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────

  async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers = headersToRecord(init?.headers);
    if (init?.body !== undefined && !hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.apiKey) {
      setHeader(headers, 'X-API-Key', this.apiKey);
    }

    const signal = init?.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers, signal });

    if (!res.ok) {
      let body: { code?: string; message?: string; error?: string } | undefined;
      try {
        body = (await res.json()) as { code?: string; message?: string; error?: string };
      } catch {
        // non-JSON error
      }
      throw new RuntimeProtocolError({
        code: body?.code ?? `http_${res.status}`,
        message: (body?.message ?? body?.error ?? res.statusText) || `HTTP ${res.status}`,
        retryable: res.status >= 500,
        status: res.status,
        data: body,
      });
    }

    if (isEmptySuccessResponse(res)) {
      return undefined as T;
    }

    const bodyText = await res.text();
    if (bodyText.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(bodyText) as T;
    } catch {
      throw new RuntimeProtocolError({
        code: 'invalid_response',
        message: 'response was not JSON',
        retryable: false,
        status: res.status,
      });
    }
  }

  // ── WebSocket events ─────────────────────────────────────────────────

  connect(sinceSeq?: number): void {
    if (this.ws) return;
    // Clear any pending reconnect timer to avoid duplicate connections
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sinceSeq = sinceSeq ?? this.sinceSeq;
    this._connect();
  }

  private _connect(): void {
    this._intentionalClose = false;
    const url = `${this.wsUrl}?sinceSeq=${this.sinceSeq}`;
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    this.ws = new WebSocket(url, { headers });

    this.ws.on('open', () => {
      this._connected = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as BrokerEvent & { seq?: number };
        // Track sequence for replay on reconnect
        if (typeof event.seq === 'number' && event.seq > this.sinceSeq) {
          this.sinceSeq = event.seq;
        }
        // Buffer the event
        this.eventBuffer.push(event);
        if (this.eventBuffer.length > this.maxBufferSize) {
          this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
        }
        // Notify listeners
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch {
            // don't let a bad listener break the stream
          }
        }
      } catch {
        // ignore non-JSON frames (ping/pong)
      }
    });

    this.ws.on('close', () => {
      this._connected = false;
      this.ws = null;
      // Auto-reconnect after 2s unless intentionally closed
      if (!this._intentionalClose) {
        this.reconnectTimer = setTimeout(() => this._connect(), 2000);
      }
    });

    this.ws.on('error', () => {
      // error always followed by close
    });
  }

  disconnect(): void {
    this._intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  openInputStream(name: string, options?: PtyInputStreamOptions): PtyInputStream {
    return new PtyInputStream({
      url: this.inputStreamUrl(name),
      apiKey: this.apiKey,
      ...options,
    });
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  queryEvents(filter?: { kind?: string; name?: string; since?: number; limit?: number }): BrokerEvent[] {
    let events = [...this.eventBuffer];
    if (filter?.kind) {
      events = events.filter((e) => e.kind === filter.kind);
    }
    if (filter?.name) {
      events = events.filter((e) => 'name' in e && e.name === filter.name);
    }
    if (filter?.since !== undefined) {
      const since = filter.since;
      events = events.filter(
        (e) => 'timestamp' in e && typeof e.timestamp === 'number' && e.timestamp >= since
      );
    }
    if (filter?.limit !== undefined) {
      events = events.slice(-filter.limit);
    }
    return events;
  }

  getLastEvent(kind: string, name?: string): BrokerEvent | undefined {
    for (let i = this.eventBuffer.length - 1; i >= 0; i -= 1) {
      const event = this.eventBuffer[i];
      if (event.kind === kind && (!name || ('name' in event && event.name === name))) {
        return event;
      }
    }
    return undefined;
  }
}

function headersToRecord(headersInit: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headersInit) return headers;

  if (headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers[key] = value;
    }
    return headers;
  }

  for (const [key, value] of Object.entries(headersInit)) {
    headers[key] = value;
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowerName);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName && key !== name) {
      delete headers[key];
    }
  }
  headers[name] = value;
}

function isEmptySuccessResponse(res: Response): boolean {
  if (res.status === 204 || res.status === 205) {
    return true;
  }
  return res.headers.get('content-length')?.trim() === '0';
}
