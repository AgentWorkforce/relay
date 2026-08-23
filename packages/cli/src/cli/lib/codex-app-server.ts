import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CodexNotification = {
  method: string;
  params?: unknown;
};

export type CodexTurnResult = {
  turnId?: string;
  response: unknown;
  completed: CodexNotification;
};

export type CodexTurnExecution =
  | { kind: 'local'; workspaceRoot: string }
  | {
      kind: 'remote';
      environment?: { environmentId: string; cwd: string };
    };

export interface CodexAppServerSession {
  initialize(): Promise<void>;
  startThread(input: { cwd: string; model?: string }): Promise<string>;
  resumeThread(input: { threadId: string; cwd: string }): Promise<void>;
  addEnvironment(input: {
    environmentId: string;
    execServerUrl: string;
    connectTimeoutMs: number;
  }): Promise<void>;
  environmentStatus(environmentId: string): Promise<unknown>;
  runTurn(input: { threadId: string; text: string; execution: CodexTurnExecution }): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export type CodexEnvironmentCapability = {
  environmentAdd: true;
  environmentStatus: true;
  explicitTurnPolicy: true;
};

export type CodexCapabilityProbeDependencies = {
  makeTempDir: () => Promise<string>;
  execFile: (file: string, args: string[]) => Promise<void>;
  readFile: (file: string) => Promise<string>;
  remove: (directory: string) => Promise<void>;
};

function defaultCapabilityProbeDependencies(): CodexCapabilityProbeDependencies {
  return {
    makeTempDir: () => fsp.mkdtemp(path.join(os.tmpdir(), 'relay-codex-schema-')),
    execFile: async (file, args) => {
      await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024 });
    },
    readFile: (file) => fsp.readFile(file, 'utf8'),
    remove: (directory) => fsp.rm(directory, { recursive: true, force: true }),
  };
}

function assertEnvironmentAddSchema(addParams: string): void {
  const schema = JSON.parse(addParams) as {
    required?: unknown;
    properties?: Record<string, unknown>;
  };
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.includes('environmentId') || !required.includes('execServerUrl')) {
    throw new Error('Codex EnvironmentAddParams does not match the required execution-teleport schema.');
  }
  if (schema.properties && ('headers' in schema.properties || 'token' in schema.properties)) {
    throw new Error(
      'Codex EnvironmentAddParams unexpectedly contains a credential field; upgrade Relay first.'
    );
  }
}

function assertTurnPolicySchema(turnParams: string): void {
  const turnSchema = JSON.parse(turnParams) as {
    properties?: Record<string, unknown>;
  };
  if (
    !turnSchema.properties?.approvalPolicy ||
    !turnSchema.properties?.sandboxPolicy ||
    !schemaContainsEnum(turnSchema, 'never') ||
    !schemaContainsEnum(turnSchema, 'workspaceWrite') ||
    !schemaContainsProperty(turnSchema, 'writableRoots') ||
    !schemaContainsEnum(turnSchema, 'dangerFullAccess')
  ) {
    throw new Error("Codex TurnStartParams does not support Relay's explicit execution-policy contract.");
  }
}

function schemaContainsEnum(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => schemaContainsEnum(entry, expected));
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.enum) && object.enum.includes(expected)) return true;
  return Object.values(object).some((entry) => schemaContainsEnum(entry, expected));
}

function schemaContainsProperty(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => schemaContainsProperty(entry, expected));
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (object.properties && typeof object.properties === 'object' && expected in object.properties) {
    return true;
  }
  return Object.values(object).some((entry) => schemaContainsProperty(entry, expected));
}

/**
 * Probe the locally installed binary rather than assuming an experimental
 * protocol from Relay's build-time Codex version. Both methods and the exact
 * no-header EnvironmentAddParams seam are required before a managed session
 * can become teleport-capable.
 */
export async function probeCodexEnvironmentCapability(
  codexBinary = 'codex',
  overrides: Partial<CodexCapabilityProbeDependencies> = {}
): Promise<CodexEnvironmentCapability> {
  const deps = { ...defaultCapabilityProbeDependencies(), ...overrides };
  const directory = await deps.makeTempDir();
  try {
    await deps.execFile(codexBinary, [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      directory,
    ]);
    const [requests, addParams, turnParams] = await Promise.all([
      deps.readFile(path.join(directory, 'ClientRequest.json')),
      deps.readFile(path.join(directory, 'v2', 'EnvironmentAddParams.json')),
      deps.readFile(path.join(directory, 'v2', 'TurnStartParams.json')),
    ]);
    if (!requests.includes('"environment/add"') || !requests.includes('"environment/status"')) {
      throw new Error(
        'This Codex app-server does not expose both experimental environment/add and environment/status.'
      );
    }

    assertEnvironmentAddSchema(addParams);
    assertTurnPolicySchema(turnParams);

    return { environmentAdd: true, environmentStatus: true, explicitTurnPolicy: true };
  } finally {
    await deps.remove(directory);
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CodexAppServerTransportLimits = {
  maxFrameBytes?: number;
  maxBufferedNotifications?: number;
  closeTimeoutMs?: number;
  forceKillTimeoutMs?: number;
};

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_NOTIFICATIONS = 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringAt(value: unknown, ...keys: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined;
}

function notificationThreadId(notification: CodexNotification): string | undefined {
  return (
    stringAt(notification.params, 'threadId') ??
    stringAt(notification.params, 'thread', 'id') ??
    stringAt(notification.params, 'turn', 'threadId')
  );
}

function notificationTurnId(notification: CodexNotification): string | undefined {
  return stringAt(notification.params, 'turnId') ?? stringAt(notification.params, 'turn', 'id');
}

/** Newline-delimited Codex app-server transport. Codex omits the jsonrpc field. */
export class StdioCodexAppServerSession implements CodexAppServerSession {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: CodexNotification[] = [];
  private readonly notificationWaiters = new Set<{
    predicate: (notification: CodexNotification) => boolean;
    resolve: (notification: CodexNotification) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private exited = false;
  private shutdownStarted = false;
  private writeChain = Promise.resolve();
  private readonly exitPromise: Promise<void>;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedNotifications: number;
  private readonly closeTimeoutMs: number;
  private readonly forceKillTimeoutMs: number;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs = 30_000,
    private readonly turnTimeoutMs = 30 * 60_000,
    private readonly onNotification?: (notification: CodexNotification) => void,
    limits: CodexAppServerTransportLimits = {}
  ) {
    this.maxFrameBytes = limits.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxBufferedNotifications = limits.maxBufferedNotifications ?? DEFAULT_MAX_BUFFERED_NOTIFICATIONS;
    this.closeTimeoutMs = limits.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.forceKillTimeoutMs = limits.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    // Drain stderr so the child cannot block, but never reflect provider or
    // model diagnostics into persisted/public controller errors.
    child.stderr.on('data', () => undefined);
    this.exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exited = true;
        this.closed = true;
        this.rejectAll(
          new Error(`Codex app-server exited before completing the request (${code ?? signal ?? 'unknown'}).`)
        );
        resolve();
      });
    });
    child.stdin.once('error', (error) => this.failProtocol(`stdin write failed: ${error.message}`));
  }

  static spawn(options: {
    codexBinary?: string;
    cwd: string;
    onNotification?: (notification: CodexNotification) => void;
  }): StdioCodexAppServerSession {
    const child = spawn(options.codexBinary ?? 'codex', ['app-server', '--stdio'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    return new StdioCodexAppServerSession(child, 30_000, 30 * 60_000, options.onNotification);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'agent-relay', title: 'Agent Relay managed Codex', version: '1' },
      capabilities: { experimentalApi: true },
    });
  }

  async startThread(input: { cwd: string; model?: string }): Promise<string> {
    const result = await this.request('thread/start', {
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
    });
    const threadId =
      stringAt(result, 'threadId') ?? stringAt(result, 'thread', 'id') ?? stringAt(result, 'id');
    if (!threadId) throw new Error('Codex thread/start returned no thread id.');
    return threadId;
  }

  async resumeThread(input: { threadId: string; cwd: string }): Promise<void> {
    await this.request('thread/resume', { threadId: input.threadId, cwd: input.cwd });
  }

  async addEnvironment(input: {
    environmentId: string;
    execServerUrl: string;
    connectTimeoutMs: number;
  }): Promise<void> {
    await this.request('environment/add', input);
  }

  environmentStatus(environmentId: string): Promise<unknown> {
    return this.request('environment/status', { environmentId });
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    execution: CodexTurnExecution;
  }): Promise<CodexTurnResult> {
    let executionParams: Record<string, unknown>;
    if (input.execution.kind === 'remote') {
      executionParams = {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(input.execution.environment ? { environments: [input.execution.environment] } : {}),
      };
    } else {
      const workspaceRoot = input.execution.workspaceRoot;
      if (!path.isAbsolute(workspaceRoot) || path.normalize(workspaceRoot) !== workspaceRoot) {
        throw new Error('Local Codex execution requires an absolute normalized workspace root.');
      }
      executionParams = {
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [workspaceRoot],
          networkAccess: false,
        },
        // Clear any sticky remote environment before a recovered local turn.
        environments: [],
      };
    }
    const response = await this.request(
      'turn/start',
      {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.text }],
        ...executionParams,
      },
      this.turnTimeoutMs
    );
    const turnId =
      stringAt(response, 'turnId') ?? stringAt(response, 'turn', 'id') ?? stringAt(response, 'id');
    const completed = await this.waitForNotification(
      (notification) =>
        notification.method === 'turn/completed' &&
        (!notificationThreadId(notification) || notificationThreadId(notification) === input.threadId) &&
        (!turnId || !notificationTurnId(notification) || notificationTurnId(notification) === turnId),
      this.turnTimeoutMs
    );
    return { turnId, response, completed };
  }

  async close(): Promise<void> {
    this.beginShutdown(new Error('Codex app-server closed.'));
    if (this.exited || this.child.exitCode !== null) return;
    if (await this.waitForExit(this.closeTimeoutMs)) return;
    this.child.kill('SIGKILL');
    if (!(await this.waitForExit(this.forceKillTimeoutMs))) {
      throw new Error('Codex app-server did not exit after SIGKILL.');
    }
  }

  private request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.writeMessage({ id, method, ...(params === undefined ? {} : { params }) }).catch(
        (error: unknown) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new Error(`Could not write Codex ${method}: ${errorMessage(error)}`));
          this.failProtocol(`failed to serialize a client request: ${errorMessage(error)}`);
        }
      );
    });
  }

  private waitForNotification(
    predicate: (notification: CodexNotification) => boolean,
    timeoutMs: number
  ): Promise<CodexNotification> {
    const queuedIndex = this.notifications.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.notifications.splice(queuedIndex, 1)[0]!);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (notification: CodexNotification) => {
          clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          resolve(notification);
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error('Timed out waiting for Codex turn/completed.'));
        }, timeoutMs),
      };
      this.notificationWaiters.add(waiter);
    });
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(frame, 'utf8') > this.maxFrameBytes) {
        this.failProtocol('received an oversized frame');
        return;
      }
      const line = frame.trim();
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.failProtocol('received malformed JSON');
        return;
      }
      if (!isObject(message)) {
        this.failProtocol('received a non-object frame');
        return;
      }
      this.handleMessage(message);
      if (this.closed) return;
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) {
      this.failProtocol('received an oversized unterminated frame');
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      this.handleResponse(message.id, message);
      return;
    }
    if (
      (typeof message.id === 'number' || typeof message.id === 'string') &&
      typeof message.method === 'string'
    ) {
      void this.writeMessage({
        id: message.id,
        error: { code: -32601, message: 'Client request not supported' },
      }).catch((error: unknown) => {
        this.failProtocol(`could not reject an app-server request: ${errorMessage(error)}`);
      });
      return;
    }
    if (typeof message.method !== 'string') {
      this.failProtocol('received a frame without a response or method');
      return;
    }
    const notification = {
      method: message.method,
      ...('params' in message ? { params: message.params } : {}),
    };
    try {
      this.onNotification?.(notification);
    } catch (error) {
      this.failProtocol(`notification handler failed: ${errorMessage(error)}`);
      return;
    }
    const waiter = [...this.notificationWaiters].find((candidate) => candidate.predicate(notification));
    if (waiter) waiter.resolve(notification);
    else if (notification.method === 'turn/completed') {
      if (this.notifications.length >= this.maxBufferedNotifications) {
        this.failProtocol('notification queue exceeded its bound');
        return;
      }
      this.notifications.push(notification);
    }
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in message) {
      if (!isObject(message.error)) {
        pending.reject(new Error('Codex app-server returned a malformed error response.'));
        this.failProtocol('received a malformed error response');
        return;
      }
      pending.reject(
        new Error(
          `${typeof message.error.code === 'number' ? `${message.error.code}: ` : ''}${
            typeof message.error.message === 'string' ? message.error.message : 'Codex request failed'
          }`
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) waiter.reject(error);
    this.notificationWaiters.clear();
  }

  private writeMessage(message: Record<string, unknown>): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame, 'utf8') > this.maxFrameBytes) {
      return Promise.reject(new Error('outbound Codex frame exceeds the transport bound'));
    }
    const write = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.closed || this.child.stdin.destroyed) {
            reject(new Error('Codex app-server is not writable.'));
            return;
          }
          this.child.stdin.write(frame, (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        })
    );
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private failProtocol(detail: string): void {
    this.beginShutdown(new Error(`Codex app-server protocol violation: ${detail}.`));
  }

  private beginShutdown(error: Error): void {
    if (!this.closed) {
      this.closed = true;
      this.rejectAll(error);
    }
    if (this.shutdownStarted || this.exited || this.child.exitCode !== null) return;
    this.shutdownStarted = true;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited || this.child.exitCode !== null) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
