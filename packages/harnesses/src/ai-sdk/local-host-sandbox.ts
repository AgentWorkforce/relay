import { createHash, randomUUID } from 'node:crypto';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from '@ai-sdk/harness';
import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stateSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface LocalHostSandboxProviderOptions {
  workspace: string;
  runtimeRoot?: string;
  /** Host path used by official adapters for their derived `/tmp/harness/*` bootstrap files. */
  adapterBootstrapRoot?: string;
  env?: Record<string, string>;
  gracefulShutdownMs?: number;
}

export interface LocalHostPreflightResult {
  ok: boolean;
  checks: {
    node22: boolean;
    pnpm: boolean;
    workspace: boolean;
    port: boolean;
    cache: boolean;
    platform: boolean;
  };
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

interface LoopbackPortReservation {
  port: number;
  server: Server;
}

async function reserveLoopbackPort(excluded: ReadonlySet<number>): Promise<LoopbackPortReservation> {
  for (;;) {
    const reservation = await new Promise<LoopbackPortReservation>((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolvePort({ port, server });
      });
    });
    if (reservation.port > 0 && !excluded.has(reservation.port)) return reservation;
    await new Promise<void>((resolveClose, reject) =>
      reservation.server.close((error) => (error ? reject(error) : resolveClose()))
    );
  }
}

class LocalHostSandboxSession implements HarnessV1NetworkSandboxSession {
  readonly description: string;
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly #runtimeRoot: string;
  readonly #adapterBootstrapRoot: string;
  readonly #env: Record<string, string>;
  readonly #gracefulShutdownMs: number;
  readonly #children = new Set<ChildProcess>();
  readonly #releasePorts: (ports: readonly number[]) => Promise<void>;
  readonly #handoffPort: (port: number) => Promise<void>;
  readonly #onStop: () => void;
  #ports: number[];
  #stopped = false;

  constructor(options: {
    id: string;
    workspace: string;
    runtimeRoot: string;
    adapterBootstrapRoot: string;
    env: Record<string, string>;
    port: number;
    gracefulShutdownMs: number;
    releasePorts: (ports: readonly number[]) => Promise<void>;
    handoffPort: (port: number) => Promise<void>;
    onStop: () => void;
  }) {
    this.id = options.id;
    this.defaultWorkingDirectory = options.workspace;
    this.#runtimeRoot = options.runtimeRoot;
    this.#adapterBootstrapRoot = options.adapterBootstrapRoot;
    this.#env = options.env;
    this.#ports = [options.port];
    this.#gracefulShutdownMs = options.gracefulShutdownMs;
    this.#releasePorts = options.releasePorts;
    this.#handoffPort = options.handoffPort;
    this.#onStop = options.onStop;
    this.description = `Local host process rooted at ${options.workspace}; this is lifecycle ownership, not filesystem isolation.`;
  }

  get ports(): readonly number[] {
    return this.#ports;
  }

  #lexicalPath(path: string): { path: string; root: string } {
    const resolved = resolve(this.defaultWorkingDirectory, path);
    const root = isInside(this.defaultWorkingDirectory, resolved)
      ? this.defaultWorkingDirectory
      : isInside(this.#runtimeRoot, resolved)
        ? this.#runtimeRoot
        : isInside(this.#adapterBootstrapRoot, resolved)
          ? this.#adapterBootstrapRoot
          : undefined;
    if (!root) {
      throw new Error(
        `Path is outside the local harness workspace, runtime cache, and adapter bootstrap cache: ${path}`
      );
    }
    return { path: resolved, root };
  }

  async #path(path: string): Promise<string> {
    const lexical = this.#lexicalPath(path);
    let existing = lexical.path;
    for (;;) {
      try {
        await access(existing, constants.F_OK);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    const [canonicalRoot, canonicalExisting] = await Promise.all([
      realpath(lexical.root),
      realpath(existing),
    ]);
    if (!isInside(canonicalRoot, canonicalExisting)) {
      throw new Error(`Path resolves through a symlink outside the local harness roots: ${path}`);
    }
    return lexical.path;
  }

  async #workingDirectory(path?: string): Promise<string> {
    return this.#path(path ?? this.defaultWorkingDirectory);
  }

  async readFile(options: { path: string; abortSignal?: AbortSignal }) {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => (controller.enqueue(bytes), controller.close()),
    });
  }

  async readBinaryFile(options: { path: string; abortSignal?: AbortSignal }) {
    assertNotAborted(options.abortSignal);
    try {
      const path = await this.#path(options.path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return new Uint8Array(await handle.readFile({ signal: options.abortSignal }));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readTextFile(options: {
    path: string;
    abortSignal?: AbortSignal;
    encoding?: string;
    startLine?: number;
    endLine?: number;
  }) {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    const text = Buffer.from(bytes).toString((options.encoding ?? 'utf8') as BufferEncoding);
    if (options.startLine === undefined && options.endLine === undefined) return text;
    const lines = text.split('\n');
    return lines.slice(Math.max(0, (options.startLine ?? 1) - 1), options.endLine).join('\n');
  }

  async writeFile(options: { path: string; content: ReadableStream<Uint8Array>; abortSignal?: AbortSignal }) {
    await this.writeBinaryFile({
      path: options.path,
      content: await streamToBytes(options.content),
      abortSignal: options.abortSignal,
    });
  }

  async writeBinaryFile(options: { path: string; content: Uint8Array; abortSignal?: AbortSignal }) {
    assertNotAborted(options.abortSignal);
    const path = await this.#path(options.path);
    await mkdir(resolve(path, '..'), { recursive: true });
    await this.#path(resolve(path, '..'));
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(options.content, { signal: options.abortSignal });
    } finally {
      await handle.close();
    }
  }

  async writeTextFile(options: {
    path: string;
    content: string;
    abortSignal?: AbortSignal;
    encoding?: string;
  }) {
    assertNotAborted(options.abortSignal);
    const path = await this.#path(options.path);
    await mkdir(resolve(path, '..'), { recursive: true });
    await this.#path(resolve(path, '..'));
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(options.content, {
        encoding: (options.encoding ?? 'utf8') as BufferEncoding,
        signal: options.abortSignal,
      });
    } finally {
      await handle.close();
    }
  }

  async spawn(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<SandboxProcess> {
    if (this.#stopped) throw new Error(`Local sandbox session ${this.id} is stopped`);
    assertNotAborted(options.abortSignal);
    for (const port of this.#ports) {
      const portText = String(port);
      const commandMentionsPort = options.command.includes(portText);
      const environmentMentionsPort = Object.values(options.env ?? {}).includes(portText);
      if (commandMentionsPort || environmentMentionsPort) await this.#handoffPort(port);
    }
    const child = spawnChild('/bin/sh', ['-lc', options.command], {
      cwd: await this.#workingDirectory(options.workingDirectory),
      env: {
        ...process.env,
        // Official adapters bootstrap their pinned bridge dependencies with
        // `pnpm --dir /tmp/harness/<adapter>`. Corepack otherwise inspects the
        // Relay workspace cwd first and rejects pnpm because Relay declares npm
        // as its package manager. Explicit caller/provider env still wins.
        COREPACK_ENABLE_PROJECT_SPEC: '0',
        ...this.#env,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.#children.add(child);
    const cleanup = () => this.#children.delete(child);
    child.once('exit', cleanup);
    child.once('error', cleanup);

    const kill = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      } else {
        child.kill('SIGTERM');
      }
    };
    const onAbort = () => void kill();
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const completion = new Promise<{ exitCode: number }>((resolveWait, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        options.abortSignal?.removeEventListener('abort', onAbort);
        if (options.abortSignal?.aborted) reject(abortError(options.abortSignal));
        else resolveWait({ exitCode: code ?? 1 });
      });
    });
    const wait = () => completion;

    return {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      wait,
      kill,
    };
  }

  async run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }) {
    const processHandle = await this.spawn(options);
    const [stdout, stderr, result] = await Promise.all([
      streamToBytes(processHandle.stdout),
      streamToBytes(processHandle.stderr),
      processHandle.wait(),
    ]);
    return { exitCode: result.exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
  }

  async getPortUrl(options: { port: number; protocol?: 'http' | 'https' | 'ws' }) {
    if (!this.#ports.includes(options.port)) throw new Error(`Port ${options.port} is not leased`);
    const protocol = options.protocol ?? 'https';
    return `${protocol === 'https' ? 'http' : protocol}://127.0.0.1:${options.port}`;
  }

  async setPorts(ports: readonly number[]) {
    if (ports.some((port) => !this.#ports.includes(port))) {
      throw new Error('Local sandbox ports are exclusively allocated by the provider');
    }
    this.#ports = [...ports];
  }

  restricted(): SandboxSession {
    return {
      description: this.description,
      readFile: this.readFile.bind(this),
      readBinaryFile: this.readBinaryFile.bind(this),
      readTextFile: this.readTextFile.bind(this),
      writeFile: this.writeFile.bind(this),
      writeBinaryFile: this.writeBinaryFile.bind(this),
      writeTextFile: this.writeTextFile.bind(this),
      spawn: this.spawn.bind(this),
      run: this.run.bind(this),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const children = [...this.#children];
    await Promise.allSettled(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      })
    );
    if (children.some((child) => child.exitCode === null && child.signalCode === null)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, this.#gracefulShutdownMs));
    }
    await Promise.allSettled(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      })
    );
    await this.#releasePorts(this.#ports);
    this.#ports = [];
    this.#onStop();
  }

  async destroy(): Promise<void> {
    await this.stop();
    await rm(resolve(this.#runtimeRoot, 'sessions', stateSegment(this.id)), {
      recursive: true,
      force: true,
    });
  }
}

export class LocalHostSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = 'relay-local-host';
  readonly workspace: string;
  readonly runtimeRoot: string;
  readonly adapterBootstrapRoot: string;
  readonly #env: Record<string, string>;
  readonly #gracefulShutdownMs: number;
  readonly #ports = new Set<number>();
  readonly #usedPorts = new Set<number>();
  readonly #portReservations = new Map<number, Server>();
  readonly #sessions = new Map<string, LocalHostSandboxSession>();
  readonly #bootstrap = new Map<string, Promise<void>>();

  constructor(options: LocalHostSandboxProviderOptions) {
    if (!isAbsolute(options.workspace)) throw new Error('Local host workspace must be absolute');
    this.workspace = resolve(options.workspace);
    this.runtimeRoot = resolve(options.runtimeRoot ?? resolve(tmpdir(), 'agent-relay', 'harness'));
    this.adapterBootstrapRoot = resolve(options.adapterBootstrapRoot ?? '/tmp/harness');
    if (this.workspace === '/' || this.runtimeRoot === '/' || this.adapterBootstrapRoot === '/') {
      throw new Error(
        'Local host workspace, runtime cache, and adapter bootstrap cache cannot be the filesystem root'
      );
    }
    this.#env = { ...options.env };
    this.#gracefulShutdownMs = options.gracefulShutdownMs ?? 1_000;
  }

  async #port(): Promise<number> {
    const reservation = await reserveLoopbackPort(this.#usedPorts);
    this.#ports.add(reservation.port);
    this.#usedPorts.add(reservation.port);
    this.#portReservations.set(reservation.port, reservation.server);
    return reservation.port;
  }

  async #handoffPort(port: number): Promise<void> {
    const reservation = this.#portReservations.get(port);
    if (!reservation) return;
    this.#portReservations.delete(port);
    await new Promise<void>((resolveClose, reject) =>
      reservation.close((error) => (error ? reject(error) : resolveClose()))
    );
  }

  async #releasePorts(ports: readonly number[]): Promise<void> {
    for (const port of ports) {
      await this.#handoffPort(port);
      this.#ports.delete(port);
    }
  }

  async createSession(
    options: {
      sessionId?: string;
      abortSignal?: AbortSignal;
      identity?: string;
      onFirstCreate?: (session: SandboxSession, options: { abortSignal?: AbortSignal }) => Promise<void>;
    } = {}
  ): Promise<HarnessV1NetworkSandboxSession> {
    assertNotAborted(options.abortSignal);
    if (process.platform === 'win32') {
      throw new Error(
        'The Relay local-host AI SDK runtime currently supports macOS and Linux; use the PTY runtime on Windows'
      );
    }
    await mkdir(this.workspace, { recursive: true });
    await mkdir(this.runtimeRoot, { recursive: true });
    await mkdir(this.adapterBootstrapRoot, { recursive: true });
    const id = options.sessionId ?? randomUUID();
    if (this.#sessions.has(id)) throw new Error(`Local sandbox session ${id} already exists`);
    const session = new LocalHostSandboxSession({
      id,
      workspace: this.workspace,
      runtimeRoot: this.runtimeRoot,
      adapterBootstrapRoot: this.adapterBootstrapRoot,
      env: this.#env,
      port: await this.#port(),
      gracefulShutdownMs: this.#gracefulShutdownMs,
      releasePorts: (ports) => this.#releasePorts(ports),
      handoffPort: (port) => this.#handoffPort(port),
      onStop: () => this.#sessions.delete(id),
    });
    this.#sessions.set(id, session);

    if (options.identity && options.onFirstCreate) {
      const marker = resolve(
        this.runtimeRoot,
        '.relay-bootstrap',
        createHash('sha256').update(options.identity).digest('hex')
      );
      let bootstrap = this.#bootstrap.get(options.identity);
      if (!bootstrap) {
        bootstrap = (async () => {
          try {
            await access(marker, constants.F_OK);
          } catch {
            await options.onFirstCreate!(session.restricted(), { abortSignal: options.abortSignal });
            await mkdir(resolve(marker, '..'), { recursive: true });
            await writeFile(marker, encoder.encode(options.identity!));
          }
        })();
        this.#bootstrap.set(options.identity, bootstrap);
      }
      try {
        await bootstrap;
      } catch (error) {
        this.#bootstrap.delete(options.identity);
        this.#sessions.delete(id);
        await session.destroy();
        throw error;
      }
    }
    return session;
  }

  async resumeSession(options: { sessionId: string; abortSignal?: AbortSignal }) {
    assertNotAborted(options.abortSignal);
    const session = this.#sessions.get(options.sessionId);
    if (!session) throw new Error(`Local sandbox session ${options.sessionId} is unavailable`);
    return session;
  }

  async preflight(): Promise<LocalHostPreflightResult> {
    await mkdir(this.workspace, { recursive: true });
    await mkdir(this.runtimeRoot, { recursive: true });
    await mkdir(this.adapterBootstrapRoot, { recursive: true });
    const command = async (value: string) => {
      const child = spawnChild(value, ['--version'], {
        stdio: 'ignore',
        env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0', ...this.#env },
      });
      return new Promise<boolean>((resolveCheck) => {
        child.once('error', () => resolveCheck(false));
        child.once('exit', (code) => resolveCheck(code === 0));
      });
    };
    const [pnpm, port] = await Promise.all([
      command(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
      reserveLoopbackPort(this.#usedPorts).then(
        ({ server }) => new Promise<boolean>((resolveClose) => server.close(() => resolveClose(true))),
        () => false
      ),
    ]);
    const checks = {
      node22: Number(process.versions.node.split('.')[0]) >= 22,
      pnpm,
      workspace: await access(this.workspace, constants.R_OK | constants.W_OK).then(
        () => true,
        () => false
      ),
      port,
      cache: await Promise.all([
        access(this.runtimeRoot, constants.R_OK | constants.W_OK),
        access(this.adapterBootstrapRoot, constants.R_OK | constants.W_OK),
      ]).then(
        () => true,
        () => false
      ),
      platform: process.platform !== 'win32',
    };
    return { ok: Object.values(checks).every(Boolean), checks };
  }
}
