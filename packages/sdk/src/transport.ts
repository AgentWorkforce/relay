/**
 * BrokerTransport — HTTP/WS transport layer for communicating with the
 * agent-relay broker. Used internally by AgentRelayClient.
 *
 * Handles:
 * - HTTP requests with API key auth and structured error parsing
 * - WebSocket connection for real-time event streaming
 * - Event buffering, replay, and query (mirrors stdio client behavior)
 */

import WebSocket from 'ws';
import type { BrokerEvent } from './protocol.js';

export class AgentRelayProtocolError extends Error {
  code: string;
  retryable: boolean;
  data?: unknown;

  constructor(payload: { code: string; message: string; retryable?: boolean; data?: unknown }) {
    super(payload.message);
    this.name = 'AgentRelayProtocolError';
    this.code = payload.code;
    this.retryable = payload.retryable ?? false;
    this.data = payload.data;
  }
}

export interface BrokerTransportOptions {
  baseUrl: string;
  apiKey?: string;
  /** Maximum number of events to buffer in memory for queryEvents/getLastEvent */
  maxBufferSize?: number;
}

export class BrokerTransport {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly maxBufferSize: number;

  private ws: WebSocket | null = null;
  private eventListeners = new Set<(event: BrokerEvent) => void>();
  private eventBuffer: BrokerEvent[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sinceSeq = 0;
  private _connected = false;

  constructor(options: BrokerTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.maxBufferSize = options.maxBufferSize ?? 1000;
  }

  get connected(): boolean {
    return this._connected;
  }

  get wsUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws') + '/ws';
  }

  // ── HTTP ─────────────────────────────────────────────────────────────

  async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });

    if (!res.ok) {
      let body: { code?: string; message?: string; error?: string } | undefined;
      try {
        body = await res.json() as { code?: string; message?: string; error?: string };
      } catch {
        // non-JSON error
      }
      throw new AgentRelayProtocolError({
        code: body?.code ?? `http_${res.status}`,
        message: body?.message ?? body?.error ?? res.statusText,
        retryable: res.status >= 500,
      });
    }

    return res.json() as Promise<T>;
  }

  // ── WebSocket events ─────────────────────────────────────────────────

  connect(sinceSeq?: number): void {
    if (this.ws) return;
    this.sinceSeq = sinceSeq ?? this.sinceSeq;
    this._connect();
  }

  private _connect(): void {
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
      // Auto-reconnect after 2s
      this.reconnectTimer = setTimeout(() => this._connect(), 2000);
    });

    this.ws.on('error', () => {
      // error always followed by close
    });
  }

  disconnect(): void {
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

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  queryEvents(filter?: {
    kind?: string;
    name?: string;
    since?: number;
    limit?: number;
  }): BrokerEvent[] {
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
        (e) => 'timestamp' in e && typeof e.timestamp === 'number' && e.timestamp >= since,
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
