import fs from 'node:fs';
import net from 'node:net';

import {
  BridgeVersionMismatchError,
  CoreBridgeError,
  CoreClosedError,
  CoreNotRunningError,
  CoreReplyTooLargeError,
  CoreRequestTooLargeError,
  CoreRpcError,
  CoreTimeoutError,
  NotACoreError,
  type ErrorKind,
  type PlanLimit,
  type RefusalReason,
} from './errors.js';
import { BRIDGE_VERSION, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, coreSocketPath, pipeName } from './paths.js';
import { trustedSocketDirectory, trustedSocketFile } from './trust.js';

/** Every event topic the core publishes (`protocol.rs` `Topic`). */
export const TOPICS = ['status', 'activity', 'shutdown', 'invalidated', 'notify', 'sign_in'] as const;
/** An event topic a client can subscribe to. */
export type Topic = (typeof TOPICS)[number];

/** The core's answer to `hello`. Feature-detect with `methods`. */
export interface HelloResult {
  bridge_version: number;
  daemon_version: string;
  pid: number;
  methods: string[];
  topics: Topic[];
}

/** One event the core pushed to a subscribed connection (`protocol.rs` `Event`). */
export interface CoreEvent {
  topic: Topic | (string & {});
  /** Increases by one per event across all topics, per core process. */
  seq: number;
  data: unknown;
}

/** How {@link connectCore} finds and talks to the core. */
export interface ConnectOptions {
  /** The bridge socket path; default {@link coreSocketPath}(`env`, `home`). */
  socket?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Bound on connecting; default 15 000 ms. */
  connectTimeoutMs?: number;
  /** Bound on each call (including `hello`); default 15 000 ms. */
  callTimeoutMs?: number;
  /** Aborts connecting; once connected, aborting closes the client. */
  signal?: AbortSignal;
}

/** Per-call options. */
export interface CallOptions {
  /** Overrides the client's `callTimeoutMs` for this call. */
  timeoutMs?: number;
  /** Abandons this call; the connection stays open. */
  signal?: AbortSignal;
}

/** A greeted connection to the core's bridge. */
export interface CoreClient {
  /** The core's greeting. */
  readonly hello: HelloResult;
  /** The socket path this client connected to. */
  readonly socket: string;
  /** Calls one bridge method and returns its result (`null` when the core sent none). */
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  /** Subscribes this connection to topics; the result carries a status snapshot. */
  subscribe(topics: Topic[]): Promise<{ topics: Topic[]; status: unknown }>;
  /** Unsubscribes this connection from topics. */
  unsubscribe(topics: Topic[]): Promise<{ topics: Topic[] }>;
  /** Listens for events; returns a function that removes the listener. */
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** Listens for the connection closing, with the error that closed it if any; returns a remover. */
  onClose(listener: (error?: Error) => void): () => void;
  /** Whether the connection is closed. */
  readonly closed: boolean;
  /** Closes the connection; pending calls fail with {@link CoreClosedError}. */
  close(): void;
  /** Closes the connection and waits until it is closed. */
  [Symbol.asyncDispose](): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const NEWLINE = 0x0a;

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function rpcErrorOf(error: unknown): CoreRpcError {
  const raw = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
    data?: { kind?: unknown; retryable?: unknown; plan_limit?: unknown; reason?: unknown };
  };
  const data = typeof raw.data === 'object' && raw.data !== null ? raw.data : {};
  return new CoreRpcError(String(raw.message ?? 'The core refused the request.'), {
    rpcCode: typeof raw.code === 'number' ? raw.code : undefined,
    kind: typeof data.kind === 'string' ? (data.kind as ErrorKind) : undefined,
    retryable: data.retryable === true,
    planLimit:
      typeof data.plan_limit === 'object' && data.plan_limit !== null
        ? (data.plan_limit as PlanLimit)
        : undefined,
    reason: typeof data.reason === 'string' ? (data.reason as RefusalReason) : undefined,
  });
}

class BridgeConnection implements CoreClient {
  readonly socket: string;
  hello!: HelloResult;
  #stream: net.Socket;
  #callTimeoutMs: number;
  #nextId = 1;
  #parts: Buffer[] = [];
  #partBytes = 0;
  #closed = false;
  #closeError: Error | undefined;
  #closeFired = false;
  #pending = new Map<number, Waiter>();
  #eventListeners = new Set<(event: CoreEvent) => void>();
  #closeListeners = new Set<(error?: Error) => void>();
  #closedPromise: Promise<void>;

  constructor(stream: net.Socket, socket: string, callTimeoutMs: number) {
    this.#stream = stream;
    this.socket = socket;
    this.#callTimeoutMs = callTimeoutMs;
    let markClosed!: () => void;
    this.#closedPromise = new Promise<void>((resolve) => (markClosed = resolve));
    stream.on('data', (chunk: Buffer) => this.#receive(chunk));
    stream.on('error', (error) => {
      const closing = new CoreClosedError(error.message, { cause: error });
      this.#closeError ??= closing;
      this.#failAll(closing);
    });
    stream.on('close', () => {
      this.#failAll(new CoreClosedError());
      this.#closeFired = true;
      for (const listener of [...this.#closeListeners]) {
        try {
          listener(this.#closeError);
        } catch {
          // A listener's failure is its own.
        }
      }
      this.#closeListeners.clear();
      this.#eventListeners.clear();
      markClosed();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
  }

  /** Close the connection because the core broke the protocol. */
  #fail(error: Error): void {
    this.#closeError ??= error;
    this.#parts = [];
    this.#partBytes = 0;
    this.#failAll(error);
    this.#stream.destroy();
  }

  #receive(chunk: Buffer): void {
    let start = 0;
    while (!this.#closed) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline < 0) {
        const rest = chunk.subarray(start);
        if (rest.length > 0) {
          this.#parts.push(rest);
          this.#partBytes += rest.length;
        }
        // A line already past the cap can never become a valid reply.
        if (this.#partBytes > MAX_REPLY_BYTES) this.#fail(new CoreReplyTooLargeError());
        return;
      }
      const piece = chunk.subarray(start, newline);
      start = newline + 1;
      const bytes = this.#partBytes + piece.length;
      let line = piece;
      if (this.#parts.length > 0) {
        this.#parts.push(piece);
        line = Buffer.concat(this.#parts, bytes);
        this.#parts = [];
        this.#partBytes = 0;
      }
      if (bytes > MAX_REPLY_BYTES) {
        this.#fail(new CoreReplyTooLargeError());
        return;
      }
      this.#line(line.toString('utf8'));
    }
  }

  #line(text: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if (!('id' in message)) {
      // Notifications: only events are known; anything newer is ignored.
      if (message.method === 'event' && typeof message.params === 'object' && message.params !== null) {
        this.#emit(message.params as CoreEvent);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.error) waiter.reject(rpcErrorOf(message.error));
    else waiter.resolve(message.result ?? null);
  }

  #emit(event: CoreEvent): void {
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(event);
      } catch {
        // A listener that throws must not break the read loop.
      }
    }
  }

  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: CallOptions = {}
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new CoreClosedError());
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_REQUEST_BYTES) {
      return Promise.reject(new CoreRequestTooLargeError(method, bytes, MAX_REQUEST_BYTES));
    }
    const timeoutMs = opts.timeoutMs ?? this.#callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        settle();
        reject(signal!.reason);
      };
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        settle();
        reject(new CoreTimeoutError(method));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value as T);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.#stream.write(`${line}\n`);
    });
  }

  subscribe(topics: Topic[]): Promise<{ topics: Topic[]; status: unknown }> {
    return this.call('subscribe', { topics });
  }

  unsubscribe(topics: Topic[]): Promise<{ topics: Topic[] }> {
    return this.call('unsubscribe', { topics });
  }

  onEvent(listener: (event: CoreEvent) => void): () => void {
    if (this.#closeFired) return () => {};
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.#closeFired) {
      const error = this.#closeError;
      queueMicrotask(() => listener(error));
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  close(): void {
    this.#closed = true;
    this.#stream.destroy();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
    await this.#closedPromise;
  }
}

function open(
  address: string,
  socket: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const stream = net.createConnection(address);
    const onAbort = () => {
      clearTimeout(timer);
      stream.destroy();
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      stream.destroy();
      reject(new CoreNotRunningError(socket, `No Agent Relay core answered at ${socket} in time.`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.once('connect', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(stream);
    });
    // Stays attached once connected, so an error before the client's own
    // handler is attached is never unhandled; a settled promise ignores it.
    stream.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new CoreNotRunningError(socket, `No Agent Relay core is listening at ${socket}.`, { cause: error })
      );
    });
  });
}

/**
 * Connect to the core and greet it.
 *
 * Order: socket file exists (else not running), its directory and the socket
 * file pass the ownership and mode checks, connect, `hello`, and the greeting
 * has the core's shape. Only "nothing answers" is {@link CoreNotRunningError};
 * every other failure is its own error, so a caller never takes a refused or
 * foreign socket for an absent core and starts a second one.
 * @param opts - Where the core is and how long to wait
 * @returns A greeted client
 * @throws CoreNotRunningError, CoreUntrustedError, NotACoreError, BridgeVersionMismatchError, CoreBridgeError
 */
export async function connectCore(opts: ConnectOptions = {}): Promise<CoreClient> {
  const socket = opts.socket ?? coreSocketPath(opts.env, opts.home);
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal } = opts;
  signal?.throwIfAborted();
  if (process.platform !== 'win32') {
    if (!fs.existsSync(socket)) {
      throw new CoreNotRunningError(socket, `No Agent Relay core is listening at ${socket}.`);
    }
    trustedSocketDirectory(socket);
    trustedSocketFile(socket);
  }
  const address = process.platform === 'win32' ? pipeName(socket) : socket;
  const stream = await open(address, socket, connectTimeoutMs, signal);
  const client = new BridgeConnection(stream, socket, callTimeoutMs);

  let greeting: Partial<HelloResult> | null;
  try {
    greeting = await client.call<Partial<HelloResult> | null>(
      'hello',
      { bridge_version: BRIDGE_VERSION },
      { signal }
    );
  } catch (error) {
    client.close();
    if (signal?.aborted && error === signal.reason) throw error;
    const message =
      `A core answers at ${socket} but refused this client (${(error as Error).message}). ` +
      'Update the Agent Relay desktop app or the relay CLI so both speak the same bridge.';
    if (error instanceof CoreRpcError && error.kind === 'bridge_version_mismatch') {
      throw new BridgeVersionMismatchError(BRIDGE_VERSION, error.message, message, { cause: error });
    }
    throw new CoreBridgeError('handshake_failed', message, { cause: error });
  }
  // The core's greeting names its bridge and pid; anything else is not the
  // core. A real core refuses another version rather than greeting with it.
  if (
    typeof greeting?.bridge_version !== 'number' ||
    typeof greeting.pid !== 'number' ||
    greeting.bridge_version !== BRIDGE_VERSION
  ) {
    client.close();
    throw new NotACoreError(`What answers at ${socket} is not an Agent Relay core; refusing to speak to it.`);
  }
  client.hello = Object.freeze({
    bridge_version: greeting.bridge_version,
    daemon_version: typeof greeting.daemon_version === 'string' ? greeting.daemon_version : '',
    pid: greeting.pid,
    methods: Array.isArray(greeting.methods) ? [...greeting.methods] : [],
    topics: Array.isArray(greeting.topics) ? [...greeting.topics] : [],
  });
  if (signal) {
    const onAbort = () => client.close();
    signal.addEventListener('abort', onAbort, { once: true });
    client.onClose(() => signal.removeEventListener('abort', onAbort));
  }
  return client;
}

/**
 * {@link connectCore}, but resolves undefined when no core is running
 * ({@link CoreNotRunningError}); every other failure still throws.
 * @param opts - Where the core is and how long to wait
 * @returns A greeted client, or undefined when nothing answers
 */
export async function tryConnectCore(opts: ConnectOptions = {}): Promise<CoreClient | undefined> {
  try {
    return await connectCore(opts);
  } catch (error) {
    if (error instanceof CoreNotRunningError) return undefined;
    throw error;
  }
}
