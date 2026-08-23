import fs from 'node:fs';
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
  runTurn(input: {
    threadId: string;
    text: string;
    environment?: { environmentId: string; cwd: string };
  }): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export type CodexEnvironmentCapability = {
  environmentAdd: true;
  environmentStatus: true;
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
    const [requests, addParams] = await Promise.all([
      deps.readFile(path.join(directory, 'ClientRequest.json')),
      deps.readFile(path.join(directory, 'v2', 'EnvironmentAddParams.json')),
    ]);
    if (!requests.includes('"environment/add"') || !requests.includes('"environment/status"')) {
      throw new Error(
        'This Codex app-server does not expose both experimental environment/add and environment/status.'
      );
    }

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

    return { environmentAdd: true, environmentStatus: true };
  } finally {
    await deps.remove(directory);
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  private stderr = '';
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs = 30_000,
    private readonly turnTimeoutMs = 30 * 60_000,
    private readonly onNotification?: (notification: CodexNotification) => void
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    child.once('exit', (code, signal) => {
      this.closed = true;
      const detail = this.stderr.trim().split('\n').at(-1);
      this.rejectAll(
        new Error(
          `Codex app-server exited before completing the request (${code ?? signal ?? 'unknown'}).${
            detail ? ` ${detail}` : ''
          }`
        )
      );
    });
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
    environment?: { environmentId: string; cwd: string };
  }): Promise<CodexTurnResult> {
    const response = await this.request(
      'turn/start',
      {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.text }],
        ...(input.environment ? { environments: [input.environment] } : {}),
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
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('Codex app-server closed.'));
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
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
      this.child.stdin.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`
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
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (isObject(message)) this.handleMessage(message);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      this.handleResponse(message.id, message);
      return;
    }
    if (typeof message.method !== 'string') return;
    const notification = {
      method: message.method,
      ...('params' in message ? { params: message.params } : {}),
    };
    this.onNotification?.(notification);
    const waiter = [...this.notificationWaiters].find((candidate) => candidate.predicate(notification));
    if (waiter) waiter.resolve(notification);
    else this.notifications.push(notification);
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in message && isObject(message.error)) {
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
}

export function isRelayfileMount(
  workspaceRoot: string
): { kind: 'relayfile-mount'; mountStatePath: string } | null {
  const mountStatePath = path.join(workspaceRoot, '.relayfile-mount-state.json');
  return fs.existsSync(mountStatePath) ? { kind: 'relayfile-mount', mountStatePath } : null;
}
