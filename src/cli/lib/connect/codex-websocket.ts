import { exec as execCommand, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';

import WebSocket, { type RawData } from 'ws';

const execAsync = promisify(execCommand);

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type NotificationHandler = (method: string, params: unknown) => void;

interface JsonRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  setNotificationHandler(handler: NotificationHandler): void;
  close(): Promise<void>;
}

interface JsonRpcClientDeps {
  createSocket: (url: string) => WebSocket;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface CodexHookMap {
  [event: string]: string[];
}

export interface CodexWebsocketConnectOptions {
  endpoint: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  task?: string;
  hooks?: CodexHookMap;
  spawnAppServer?: boolean;
}

export interface CodexWebsocketConnectDeps {
  connectJsonRpc: (
    endpoint: string,
    timeoutMs: number,
    onNotification?: NotificationHandler
  ) => Promise<JsonRpcClient>;
  spawnProcess: typeof spawnProcess;
  execCommand: (command: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const DEFAULT_EVENT_ALIASES: Record<string, string[]> = {
  'turn/completed': ['on_turn_complete'],
  'approval/requested': ['on_approval_needed'],
  'item/completed:command': ['on_command_executed'],
  'item/completed:filechange': ['on_file_change'],
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function defaultJsonRpcDeps(): JsonRpcClientDeps {
  return {
    createSocket: (url: string) => new WebSocket(url),
    setTimeout,
    clearTimeout,
  };
}

function parseJsonMessage(raw: RawData): JsonRpcResponse | JsonRpcNotification | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object') {
      return null;
    }

    if ('id' in value && typeof (value as { id?: unknown }).id === 'number') {
      return value as JsonRpcResponse;
    }

    if ('method' in value && typeof (value as { method?: unknown }).method === 'string') {
      return value as JsonRpcNotification;
    }
  } catch {
    return null;
  }

  return null;
}

async function createJsonRpcClient(
  endpoint: string,
  timeoutMs: number,
  onNotification?: NotificationHandler,
  deps: JsonRpcClientDeps = defaultJsonRpcDeps()
): Promise<JsonRpcClient> {
  const socket = deps.createSocket(endpoint);

  await new Promise<void>((resolve, reject) => {
    const timeout = deps.setTimeout(() => {
      reject(new Error(`Timed out connecting to ${endpoint}`));
    }, timeoutMs);

    socket.once('open', () => {
      deps.clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      deps.clearTimeout(timeout);
      reject(error);
    });
  });

  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let notificationHandler: NotificationHandler | undefined = onNotification;

  socket.on('message', (raw) => {
    const msg = parseJsonMessage(raw);
    if (!msg) {
      return;
    }

    if ('id' in msg && typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) {
        return;
      }
      pending.delete(msg.id);
      deps.clearTimeout(p.timeout);

      if (msg.error) {
        const errMessage = msg.error.message ?? 'JSON-RPC request failed';
        p.reject(new Error(errMessage));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if ('method' in msg && notificationHandler) {
      notificationHandler(msg.method, msg.params);
    }
  });

  socket.once('close', () => {
    for (const request of pending.values()) {
      deps.clearTimeout(request.timeout);
      request.reject(new Error('Codex WebSocket connection closed'));
    }
    pending.clear();
  });

  return {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      };

      const response = await new Promise<unknown>((resolve, reject) => {
        const timeout = deps.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);

        pending.set(id, {
          resolve,
          reject,
          timeout,
        });
        socket.send(JSON.stringify(payload), (error) => {
          if (error) {
            const p = pending.get(id);
            if (!p) {
              return;
            }
            pending.delete(id);
            deps.clearTimeout(p.timeout);
            p.reject(error);
          }
        });
      });

      return response as T;
    },
    notify(method: string, params?: unknown): void {
      const payload = {
        jsonrpc: '2.0',
        method,
        params: params ?? {},
      };
      socket.send(JSON.stringify(payload));
    },
    setNotificationHandler(handler: NotificationHandler): void {
      notificationHandler = handler;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close();
      });
    },
  };
}

function extractThreadId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const direct = (value as { threadId?: unknown }).threadId;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const thread = (value as { thread?: { id?: unknown } }).thread;
  if (thread && typeof thread.id === 'string' && thread.id.length > 0) {
    return thread.id;
  }

  return null;
}

function collectHookKeys(method: string, params: unknown): string[] {
  const base = method.toLowerCase();
  const keys = new Set<string>([base]);

  if (base === 'item/completed' && params && typeof params === 'object') {
    const type =
      (params as { type?: unknown }).type ??
      (params as { item?: { type?: unknown; kind?: unknown } }).item?.type ??
      (params as { item?: { type?: unknown; kind?: unknown } }).item?.kind;
    if (typeof type === 'string' && type.length > 0) {
      keys.add(`${base}:${type.toLowerCase()}`);
    }
  }

  for (const key of Array.from(keys)) {
    const aliases = DEFAULT_EVENT_ALIASES[key] ?? [];
    for (const alias of aliases) {
      keys.add(alias);
    }
  }

  return Array.from(keys);
}

function flattenContext(prefix: string, value: unknown, out: Record<string, string>): void {
  if (value == null) {
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (prefix) {
      out[prefix] = String(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      flattenContext(prefix ? `${prefix}.${idx}` : String(idx), item, out);
    });
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenContext(nextPrefix, nested, out);
    }
  }
}

function interpolateCommand(command: string, context: Record<string, string>): string {
  return command.replace(/\$\{([^}]+)\}/g, (_match, token: string) => {
    const key = token.trim();
    if (key in context) {
      return context[key] ?? '';
    }
    return '';
  });
}

function defaultCodexConnectDeps(): CodexWebsocketConnectDeps {
  return {
    connectJsonRpc: createJsonRpcClient,
    spawnProcess,
    execCommand: async (command: string) => {
      await execAsync(command);
    },
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
  };
}

async function connectWithRetry(
  endpoint: string,
  timeoutMs: number,
  deps: CodexWebsocketConnectDeps,
  onNotification?: NotificationHandler
): Promise<JsonRpcClient> {
  const deadline = deps.now() + timeoutMs;
  let lastError: unknown;

  while (deps.now() < deadline) {
    try {
      return await deps.connectJsonRpc(endpoint, Math.min(timeoutMs, 5_000), onNotification);
    } catch (error) {
      lastError = error;
      await deps.sleep(200);
    }
  }

  throw new Error(`Failed to connect to Codex app-server at ${endpoint}: ${toErrorMessage(lastError)}`);
}

async function runHooks(
  method: string,
  params: unknown,
  hooks: CodexHookMap,
  deps: CodexWebsocketConnectDeps
): Promise<void> {
  const keys = collectHookKeys(method, params);
  const context: Record<string, string> = {
    event: method,
  };
  flattenContext('', params, context);

  for (const key of keys) {
    const commands = hooks[key] ?? [];
    for (const command of commands) {
      const rendered = interpolateCommand(command, context);
      if (!rendered.trim()) {
        continue;
      }
      try {
        await deps.execCommand(rendered);
      } catch (error) {
        deps.warn(`[connect] hook failed (${key}): ${toErrorMessage(error)}`);
      }
    }
  }
}

function extractDeltaText(params: unknown): string {
  if (!params || typeof params !== 'object') {
    return '';
  }

  const direct = (params as { text?: unknown }).text;
  if (typeof direct === 'string') {
    return direct;
  }

  const plainDelta = (params as { delta?: unknown }).delta;
  if (typeof plainDelta === 'string') {
    return plainDelta;
  }

  const deltaText = (params as { delta?: { text?: unknown } }).delta?.text;
  if (typeof deltaText === 'string') {
    return deltaText;
  }

  const parts = (params as { delta?: { content?: unknown[] } }).delta?.content;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => {
        if (!part || typeof part !== 'object') {
          return '';
        }
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }

  return '';
}

export async function runCodexWebsocketConnect(
  options: CodexWebsocketConnectOptions,
  overrides: Partial<CodexWebsocketConnectDeps> = {}
): Promise<void> {
  const deps = {
    ...defaultCodexConnectDeps(),
    ...overrides,
  };

  let appServerProcess: ReturnType<typeof spawnProcess> | undefined;
  if (options.spawnAppServer) {
    appServerProcess = deps.spawnProcess(
      'codex',
      ['app-server', '--listen', options.endpoint],
      {
        cwd: options.cwd,
        env: process.env,
        stdio: 'ignore',
      }
    );
    deps.log(`[connect] spawned codex app-server on ${options.endpoint}`);
  }

  let outputBuffer = '';
  let turnCompleteResolve: (() => void) | null = null;
  const turnCompletePromise = new Promise<void>((resolve) => {
    turnCompleteResolve = resolve;
  });

  const client = await connectWithRetry(options.endpoint, options.timeoutMs, deps, (method, params) => {
    deps.log(`[connect][event] ${method}`);
    if (options.hooks && Object.keys(options.hooks).length > 0) {
      void runHooks(method, params, options.hooks, deps);
    }

    if (method === 'item/agentMessage/delta') {
      const chunk = extractDeltaText(params);
      if (chunk) {
        outputBuffer += chunk;
      }
    }

    if (method === 'turn/completed' && turnCompleteResolve) {
      turnCompleteResolve();
      turnCompleteResolve = null;
    }
  });

  try {
    await client.request('initialize', {
      clientInfo: {
        name: 'agent-relay',
        title: 'Agent Relay',
        version: '0.1.0',
      },
    });
    client.notify('initialized', {});

    const threadStart = await client.request<{ thread?: { id?: string }; threadId?: string }>(
      'thread/start',
      {
        model: options.model,
        cwd: options.cwd,
      }
    );
    const threadId = extractThreadId(threadStart);
    if (!threadId) {
      throw new Error('thread/start did not return a thread id');
    }
    deps.log(`[connect] codex thread started: ${threadId}`);

    if (options.task && options.task.trim().length > 0) {
      await client.request('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: options.task,
          },
        ],
      });

      await turnCompletePromise;

      if (outputBuffer.trim().length > 0) {
        deps.log('[connect] final response:');
        deps.log(outputBuffer.trim());
      } else {
        deps.log('[connect] turn completed (no aggregated text delta received)');
      }
    }
  } finally {
    await client.close();
    if (appServerProcess && !appServerProcess.killed) {
      appServerProcess.kill('SIGTERM');
    }
  }
}
