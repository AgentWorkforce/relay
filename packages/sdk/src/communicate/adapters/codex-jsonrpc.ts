import { spawn } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonRpcId = string | number;

export type CodexJsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type CodexClientInfo = {
  name: string;
  title?: string | null;
  version: string;
};

export type CodexInitializeCapabilities = {
  experimentalApi: boolean;
  optOutNotificationMethods?: string[] | null;
};

export type CodexInitializeParams = {
  clientInfo: CodexClientInfo;
  capabilities: CodexInitializeCapabilities | null;
};

export type CodexInitializeResponse = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export interface CodexJsonRpcTransport {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SpawnCodexAppServerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexJsonRpcClientOptions {
  requestTimeoutMs?: number;
}

export interface CodexInitializeOptions {
  clientInfo?: Partial<CodexClientInfo>;
  capabilities?: CodexInitializeCapabilities | null;
  timeoutMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

type NotificationListener = (notification: CodexJsonRpcNotification) => void | Promise<void>;

type WireRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type WireNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type WireResponse = {
  jsonrpc?: '2.0';
  id?: JsonRpcId | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'];
const STDERR_TAIL_LIMIT = 8_192;

export class CodexJsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`Codex JSON-RPC error ${code}: ${message}`);
    this.name = 'CodexJsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export function spawnCodexAppServer(options: SpawnCodexAppServerOptions = {}): CodexJsonRpcTransport {
  const child = spawn(options.command ?? 'codex', options.args ?? DEFAULT_CODEX_APP_SERVER_ARGS, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: 'pipe',
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
    onExit: (callback) => {
      child.once('exit', callback);
    },
  };
}

export class CodexJsonRpcClient {
  private readonly lineReader: ReadlineInterface;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly requestTimeoutMs: number;

  private nextId = 1;
  private closed = false;
  private stderrTail = '';

  constructor(
    private readonly transport: CodexJsonRpcTransport,
    options: CodexJsonRpcClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.lineReader = createInterface({
      input: transport.stdout,
      crlfDelay: Infinity,
    });
    this.lineReader.on('line', (line) => this.handleLine(line));
    this.lineReader.on('close', () => this.handleClose('stdout closed'));

    transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-STDERR_TAIL_LIMIT);
    });

    transport.onExit((code, signal) => {
      const exitReason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.handleClose(`process exited with ${exitReason}`);
    });
  }

  async initialize(options: CodexInitializeOptions = {}): Promise<CodexInitializeResponse> {
    const params: CodexInitializeParams = {
      clientInfo: {
        name: options.clientInfo?.name ?? 'agent_relay',
        title: options.clientInfo?.title ?? 'Agent Relay',
        version: options.clientInfo?.version ?? process.env.npm_package_version ?? '0.0.0',
      },
      capabilities: options.capabilities ?? {
        experimentalApi: false,
      },
    };

    const response = await this.request<CodexInitializeResponse>('initialize', params, {
      timeoutMs: options.timeoutMs,
    });
    await this.notify('initialized');
    return response;
  }

  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('Codex JSON-RPC client is closed'));
    }

    const id = this.nextId++;
    const request: WireRequest = {
      jsonrpc: '2.0',
      id,
      method,
    };
    if (params !== undefined) {
      request.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex JSON-RPC request timed out: ${method}`));
      }, options.timeoutMs ?? this.requestTimeoutMs);

      this.pending.set(String(id), {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.write(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const notification: WireNotification = {
      jsonrpc: '2.0',
      method,
    };
    if (params !== undefined) {
      notification.params = params;
    }
    this.write(notification);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectAll(new Error('Codex JSON-RPC client closed'));
    this.lineReader.close();
    this.transport.stdin.end();
    this.transport.kill('SIGTERM');
  }

  private write(message: WireRequest | WireNotification): void {
    this.transport.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let message: WireResponse;
    try {
      message = JSON.parse(trimmed) as WireResponse;
    } catch (error) {
      process.emitWarning(
        `Ignoring invalid Codex JSON-RPC line: ${error instanceof Error ? error.message : String(error)}`,
        'CodexJsonRpcWarning'
      );
      return;
    }

    if (message.id !== undefined && message.id !== null) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === 'string') {
      this.handleNotification({
        method: message.method,
        params: message.params,
      });
    }
  }

  private handleResponse(message: WireResponse): void {
    const pending = this.pending.get(String(message.id));
    if (!pending) {
      return;
    }

    this.pending.delete(String(message.id));
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new CodexJsonRpcError(message.error.code, message.error.message, message.error.data));
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(notification: CodexJsonRpcNotification): void {
    for (const listener of [...this.notificationListeners]) {
      Promise.resolve(listener(notification)).catch((error) => {
        process.emitWarning(
          `Codex notification listener failed: ${error instanceof Error ? error.message : String(error)}`,
          'CodexJsonRpcWarning'
        );
      });
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const stderr = this.stderrTail.trim();
    const details = stderr ? `${reason}. stderr: ${stderr}` : reason;
    this.rejectAll(new Error(`Codex app-server ${details}`));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
