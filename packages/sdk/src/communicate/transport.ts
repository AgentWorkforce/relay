import { setTimeout as sleep } from 'node:timers/promises';

import { WebSocket } from 'ws';

import {
  type Message,
  type MessageCallback,
  type RelayConfig,
  RelayAuthError,
  RelayConfigError,
  RelayConnectionError,
  resolveRelayConfig,
} from './types.js';

const HTTP_RETRY_ATTEMPTS = 3;
const WS_RECONNECT_MAX_DELAY_MS = 30_000;

type JsonObject = Record<string, unknown>;

export class RelayTransport {
  readonly agentName: string;
  readonly config;

  agentId?: string;
  token?: string;

  private ws?: WebSocket;
  private messageCallback?: MessageCallback;
  private closing = false;
  private reconnectDelayMs = 1_000;
  private reconnectTimer?: NodeJS.Timeout;
  private wsConnectPromise?: Promise<void>;

  constructor(agentName: string, config: RelayConfig = {}) {
    this.agentName = agentName;
    this.config = resolveRelayConfig(config);
  }

  async connect(): Promise<void> {
    this.requireConfig({ requireWorkspace: true });
    this.closing = false;
    await this.registerAgent();
    await this.connectWebSocket();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.clearReconnectTimer();

    const socket = this.ws;
    this.ws = undefined;
    this.wsConnectPromise = undefined;

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await Promise.race([
        new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }

    if (this.agentId) {
      try {
        await this.unregisterAgent();
      } catch {
        // Best-effort cleanup.
      }
    }

    this.closing = false;
  }

  onWsMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  async registerAgent(): Promise<string> {
    this.requireConfig({ requireWorkspace: true });

    if (this.agentId && this.token) {
      return this.agentId;
    }

    const payload = await this.sendHttp<{ agent_id: string; token: string }>(
      'POST',
      '/v1/agents/register',
      {
        name: this.agentName,
        workspace: this.config.workspace,
      }
    );

    this.agentId = payload.agent_id;
    this.token = payload.token;
    return this.agentId;
  }

  async unregisterAgent(): Promise<void> {
    if (!this.agentId) {
      return;
    }

    const agentId = this.agentId;
    this.agentId = undefined;
    this.token = undefined;
    await this.sendHttp('DELETE', `/v1/agents/${agentId}`);
  }

  async sendDm(to: string, text: string): Promise<string> {
    await this.ensureRegistered();
    const payload = await this.sendHttp<{ message_id: string }>('POST', '/v1/messages/dm', {
      to,
      text,
      from: this.agentName,
    });
    return payload.message_id;
  }

  async postMessage(channel: string, text: string): Promise<string> {
    await this.ensureRegistered();
    const payload = await this.sendHttp<{ message_id: string }>('POST', '/v1/messages/channel', {
      channel,
      text,
      from: this.agentName,
    });
    return payload.message_id;
  }

  async reply(messageId: string, text: string): Promise<string> {
    await this.ensureRegistered();
    const payload = await this.sendHttp<{ message_id: string }>('POST', '/v1/messages/reply', {
      message_id: messageId,
      text,
      from: this.agentName,
    });
    return payload.message_id;
  }

  async checkInbox(): Promise<Message[]> {
    await this.ensureRegistered();
    const payload = await this.sendHttp<{ messages?: JsonObject[] }>('GET', `/v1/inbox/${this.agentId}`);
    return (payload.messages ?? []).map((message) => this.messageFromPayload(message));
  }

  async listAgents(): Promise<string[]> {
    const payload = await this.sendHttp<{ agents?: string[] }>('GET', '/v1/agents');
    return [...(payload.agents ?? [])];
  }

  private async ensureRegistered(): Promise<void> {
    if (this.agentId && this.token) {
      return;
    }
    await this.registerAgent();
  }

  private requireConfig(options: { requireWorkspace?: boolean } = {}): void {
    if (!this.config.apiKey) {
      throw new RelayConfigError(
        'Missing RELAY_API_KEY. Set the environment variable or pass apiKey to RelayConfig.'
      );
    }

    if (options.requireWorkspace && !this.config.workspace) {
      throw new RelayConfigError(
        'Missing RELAY_WORKSPACE. Set the environment variable or pass workspace to RelayConfig.'
      );
    }
  }

  private async sendHttp<T = unknown>(
    method: string,
    path: string,
    payload?: JsonObject
  ): Promise<T> {
    this.requireConfig();

    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
    };

    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }

    for (let attempt = 1; attempt <= HTTP_RETRY_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
      } catch (error) {
        if (attempt < HTTP_RETRY_ATTEMPTS) {
          await sleep(Math.min(2 ** (attempt - 1) * 1_000, WS_RECONNECT_MAX_DELAY_MS));
          continue;
        }
        throw new RelayConnectionError(0, error instanceof Error ? error.message : String(error));
      }

      if (response.status === 401) {
        throw new RelayAuthError(await this.errorMessage(response));
      }

      if (response.status >= 500 && response.status <= 599) {
        const message = await this.errorMessage(response);
        if (attempt < HTTP_RETRY_ATTEMPTS) {
          await sleep(Math.min(2 ** (attempt - 1) * 1_000, WS_RECONNECT_MAX_DELAY_MS));
          continue;
        }
        throw new RelayConnectionError(response.status, message);
      }

      if (response.status >= 400) {
        throw new RelayConnectionError(response.status, await this.errorMessage(response));
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }

      return (await response.text()) as T;
    }

    throw new RelayConnectionError(500, 'Unexpected transport retry failure');
  }

  private async connectWebSocket(): Promise<void> {
    await this.ensureRegistered();

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.wsConnectPromise) {
      return this.wsConnectPromise;
    }

    const url = `${this.wsBaseUrl()}/v1/ws/${this.agentId}?token=${encodeURIComponent(this.token ?? '')}`;
    const socket = new WebSocket(url);

    this.wsConnectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.once('open', () => {
        settled = true;
        this.ws = socket;
        this.reconnectDelayMs = 1_000;
        resolve();
      });

      socket.once('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    }).finally(() => {
      this.wsConnectPromise = undefined;
    });

    socket.on('message', (raw) => {
      void this.dispatchWsPayload(raw.toString());
    });

    socket.on('close', () => {
      if (this.ws === socket) {
        this.ws = undefined;
      }
      if (!this.closing) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', () => {
      // The close handler manages reconnects for established sockets.
    });

    await this.wsConnectPromise;
  }

  private wsBaseUrl(): string {
    if (this.config.baseUrl.startsWith('https://')) {
      return `wss://${this.config.baseUrl.slice('https://'.length)}`;
    }

    if (this.config.baseUrl.startsWith('http://')) {
      return `ws://${this.config.baseUrl.slice('http://'.length)}`;
    }

    return this.config.baseUrl;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) {
      return;
    }

    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, WS_RECONNECT_MAX_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectWebSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async dispatchWsPayload(rawPayload: string): Promise<void> {
    const payload = JSON.parse(rawPayload) as JsonObject;
    if (payload.type === 'ping') {
      this.ws?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (payload.type !== 'message' || !this.messageCallback) {
      return;
    }

    await this.messageCallback(this.messageFromPayload(payload));
  }

  private messageFromPayload(payload: JsonObject): Message {
    return {
      sender: String(payload.sender ?? ''),
      text: String(payload.text ?? ''),
      channel: typeof payload.channel === 'string' ? payload.channel : undefined,
      threadId: typeof payload.thread_id === 'string' ? payload.thread_id : undefined,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined,
      messageId: typeof payload.message_id === 'string' ? payload.message_id : undefined,
    };
  }

  private async errorMessage(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as { message?: string };
      return payload.message ?? response.statusText ?? 'Request failed';
    } catch {
      return (await response.text()) || response.statusText || 'Request failed';
    }
  }
}
