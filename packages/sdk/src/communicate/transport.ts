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

    let payload: JsonObject;
    try {
      payload = await this.sendHttp<JsonObject>(
        'POST',
        '/v1/agents',
        { name: this.agentName, type: 'agent' },
      );
    } catch (error) {
      if (error instanceof RelayConnectionError && error.statusCode === 409) {
        const agentPayload = await this.sendHttp<JsonObject>(
          'GET',
          `/v1/agents/${encodeURIComponent(this.agentName)}`,
        );
        const agentData = (agentPayload as any).data ?? agentPayload;
        this.agentId = String(agentData.id);

        const rotatePayload = await this.sendHttp<JsonObject>(
          'POST',
          `/v1/agents/${encodeURIComponent(this.agentName)}/rotate-token`,
        );
        const rotateData = (rotatePayload as any).data ?? rotatePayload;
        this.token = String(rotateData.token);
        return this.agentId;
      }
      throw error;
    }

    const data = (payload as any).data ?? payload;
    this.agentId = String(data.id);
    this.token = String(data.token);
    return this.agentId;
  }

  async unregisterAgent(): Promise<void> {
    if (!this.agentId || !this.token) {
      return;
    }

    this.agentId = undefined;
    const agentToken = this.token;
    this.token = undefined;
    await this.sendHttpAsAgent('POST', '/v1/agents/disconnect', undefined, agentToken);
  }

  async sendDm(to: string, text: string): Promise<string> {
    await this.ensureRegistered();
    const payload = await this.sendHttpAsAgent<JsonObject>('POST', '/v1/dm', { to, text });
    const data = (payload as any).data ?? payload;
    return String(data.id ?? data.message_id ?? '');
  }

  async postMessage(channel: string, text: string): Promise<string> {
    await this.ensureRegistered();
    const payload = await this.sendHttpAsAgent<JsonObject>(
      'POST',
      `/v1/channels/${encodeURIComponent(channel)}/messages`,
      { text },
    );
    const data = (payload as any).data ?? payload;
    return String(data.id ?? data.message_id ?? '');
  }

  async reply(messageId: string, text: string): Promise<string> {
    await this.ensureRegistered();
    const payload = await this.sendHttpAsAgent<JsonObject>(
      'POST',
      `/v1/messages/${encodeURIComponent(messageId)}/replies`,
      { text },
    );
    const data = (payload as any).data ?? payload;
    return String(data.id ?? data.message_id ?? '');
  }

  async checkInbox(): Promise<Message[]> {
    await this.ensureRegistered();
    const payload = await this.sendHttpAsAgent<JsonObject>('GET', '/v1/inbox');
    const data = (payload as any).data ?? payload;
    const messages: Message[] = [];

    for (const mention of ((data as any).mentions ?? []) as JsonObject[]) {
      messages.push(this.messageFromPayload(mention));
    }

    for (const dm of ((data as any).unread_dms ?? []) as JsonObject[]) {
      const last = (dm as any).last_message as JsonObject | undefined;
      if (last?.text) {
        messages.push({
          sender: String(dm.from ?? dm.agent_name ?? 'unknown'),
          text: String(last.text),
          channel: undefined,
          threadId: typeof dm.conversation_id === 'string' ? dm.conversation_id : undefined,
          timestamp: typeof last.created_at === 'string' ? undefined : (last.created_at as number | undefined),
          messageId: typeof last.id === 'string' ? last.id : undefined,
        });
      }
    }

    return messages;
  }

  async listAgents(): Promise<string[]> {
    const payload = await this.sendHttp<JsonObject>('GET', '/v1/agents');
    const data = (payload as any).data ?? (payload as any).agents ?? [];
    if (Array.isArray(data)) {
      return data.map((a: any) => (typeof a === 'string' ? a : String(a.name ?? a)));
    }
    return [];
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

  private async sendHttpAsAgent<T = unknown>(
    method: string,
    path: string,
    payload?: JsonObject,
    overrideToken?: string,
  ): Promise<T> {
    this.requireConfig();

    const agentToken = overrideToken ?? this.token;
    if (!agentToken) {
      throw new RelayConfigError('Agent not registered; no agent token available.');
    }

    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${agentToken}`,
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

    const url = `${this.wsBaseUrl()}/v1/ws?token=${encodeURIComponent(this.token ?? '')}`;
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

    const messageEvents = new Set([
      'message.created', 'dm.received', 'direct_message.received',
      'thread.reply', 'message', 'group_dm.received',
    ]);
    if (!messageEvents.has(payload.type as string) || !this.messageCallback) {
      return;
    }

    await this.messageCallback(this.messageFromPayload(payload));
  }

  private messageFromPayload(payload: JsonObject): Message {
    const m = (typeof payload.message === 'object' && payload.message !== null)
      ? (payload.message as JsonObject)
      : payload;

    const sender = String(
      m.sender ?? m.agent_name ?? m.from ?? m.agentName
      ?? payload.agent_name ?? payload.from ?? 'unknown',
    );
    const text = String(m.text ?? '');
    const channel = String(
      m.channel ?? m.channel_name ?? m.channelName ?? payload.channel ?? payload.channel_name ?? '',
    ) || undefined;
    const threadId = String(
      m.thread_id ?? m.threadId ?? m.conversation_id ?? m.conversationId ?? payload.thread_id ?? '',
    ) || undefined;
    const rawTs = m.timestamp ?? m.created_at ?? m.createdAt ?? payload.timestamp;
    const timestamp = typeof rawTs === 'number' ? rawTs : undefined;
    const messageId = String(
      m.id ?? m.message_id ?? m.messageId ?? payload.message_id ?? '',
    ) || undefined;

    return { sender, text, channel, threadId, timestamp, messageId };
  }

  private async errorMessage(response: Response): Promise<string> {
    const text = await response.text().catch(() => '');
    try {
      const payload = JSON.parse(text) as { message?: string; error?: { message?: string } };
      if (typeof payload.error === 'object' && payload.error?.message) {
        return payload.error.message;
      }
      return payload.message ?? response.statusText ?? 'Request failed';
    } catch {
      return text || response.statusText || 'Request failed';
    }
  }
}
