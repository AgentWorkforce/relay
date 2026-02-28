/**
 * OpenClaw Gateway WebSocket Client
 *
 * Thin WebSocket client for the OpenClaw gateway JSON-RPC protocol.
 * Handles connection lifecycle, reconnection, and RPC request/response.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  OpenClawClientOptions,
  OpenClawAgent,
  OpenClawSession,
  OpenClawRunResult,
  SendResult,
  GatewayRequest,
  GatewayResponse,
  GatewayEvent,
  GatewayFrame,
  PresenceEntry,
} from './types.js';

const DEFAULT_URL = 'ws://127.0.0.1:18789';
const MAX_RECONNECT_DELAY_MS = 30_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OpenClawClient extends EventEmitter {
  private readonly url: string;
  private readonly token?: string;
  private readonly shouldReconnect: boolean;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: OpenClawClientOptions) {
    super();
    this.url = options.url || DEFAULT_URL;
    this.token = options.token;
    this.shouldReconnect = options.reconnect !== false;
  }

  /** Connect to the OpenClaw gateway and perform handshake */
  async connect(): Promise<void> {
    this.stopped = false;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);

      ws.on('open', () => {
        this.ws = ws;
        this.reconnectAttempt = 0;

        // Send handshake frame
        const handshake: GatewayRequest = {
          type: 'request',
          id: randomUUID(),
          method: 'connect',
          params: this.token ? { token: this.token } : undefined,
        };
        ws.send(JSON.stringify(handshake));
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleFrame(data.toString());
      });

      ws.on('close', () => {
        this.ws = null;
        this.rejectAllPending(new Error('WebSocket closed'));
        this.emit('close');
        if (this.shouldReconnect && !this.stopped) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        this.emit('error', err);
        if (!this.ws) {
          reject(err);
        }
      });
    });
  }

  /** Disconnect from the gateway */
  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.rejectAllPending(new Error('Client disconnected'));
  }

  /** Send an RPC request and wait for the response */
  async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to OpenClaw gateway');
    }

    const id = randomUUID();
    const request: GatewayRequest = { type: 'request', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 60_000);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(request));
    });
  }

  /** List all agents registered in the OpenClaw gateway */
  async listAgents(): Promise<OpenClawAgent[]> {
    return this.rpc<OpenClawAgent[]>('agents.list');
  }

  /** List sessions, optionally filtering by active status */
  async listSessions(opts?: { active?: number }): Promise<OpenClawSession[]> {
    return this.rpc<OpenClawSession[]>('sessions.list', opts);
  }

  /** Send a message to a specific session */
  async sendToSession(
    sessionKey: string,
    message: string,
    opts?: { wait?: number },
  ): Promise<SendResult> {
    return this.rpc<SendResult>('sessions.send', {
      key: sessionKey,
      message,
      ...opts,
    });
  }

  /** Run an agent with a message and get a run ID */
  async runAgent(
    agentId: string,
    message: string,
  ): Promise<{ runId: string }> {
    return this.rpc<{ runId: string }>('agent.run', { agentId, message });
  }

  /** Wait for a run to complete */
  async waitForRun(
    runId: string,
    timeout = 600_000,
  ): Promise<OpenClawRunResult> {
    return this.rpc<OpenClawRunResult>('agent.wait', { runId, timeout });
  }

  /** Whether the client is currently connected */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Private ─────────────────────────────────────────────────────

  private handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      this.emit('error', new Error(`Invalid gateway frame: ${raw}`));
      return;
    }

    if (frame.type === 'response') {
      const resp = frame as GatewayResponse;
      const pending = this.pending.get(resp.id);
      if (pending) {
        this.pending.delete(resp.id);
        clearTimeout(pending.timer);
        if (resp.error) {
          pending.reject(
            new Error(`RPC error [${resp.error.code}]: ${resp.error.message}`),
          );
        } else {
          pending.resolve(resp.result);
        }
      }
    } else if (frame.type === 'event') {
      const evt = frame as GatewayEvent;
      if (evt.event === 'agent:output') {
        this.emit('agent:output', evt.data as { sessionKey: string; text: string });
      } else if (evt.event === 'presence') {
        this.emit('presence', evt.data as PresenceEntry[]);
      } else {
        this.emit(evt.event, evt.data);
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() failure triggers another close → scheduleReconnect cycle
      }
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
