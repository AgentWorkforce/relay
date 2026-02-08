/**
 * HostedRunner — thin orchestrator that wraps CLIs with relay-pty and bridges
 * to a messaging backend (relaycast or custom hosted daemon).
 *
 * This is the "one command" experience:
 *   relay run claude
 *
 * Architecture:
 *   messaging backend ──WebSocket──► runner ──Unix socket──► relay-pty ──PTY──► claude
 *
 * What it does:
 *   1. Spawns relay-pty wrapping the target CLI (proven PTY injection)
 *   2. Connects to messaging backend (relaycast WebSocket or custom daemon)
 *   3. Incoming messages → inject into CLI via relay-pty's socket
 *   4. Outgoing messages → agent uses MCP tools (relaycast) or outbox files
 *   5. Spawn/release → creates/stops additional relay-pty instances locally
 *
 * Two messaging modes:
 *   - relaycast: Uses relaycast.dev hosted messaging (RELAYCAST_API_KEY)
 *   - custom:    Uses our own hosted daemon WebSocket (RELAY_URL)
 *
 * Why relay-pty?
 *   - Proven PTY injection (~550ms latency)
 *   - Handles all CLIs (claude, codex, gemini, aider, goose)
 *   - Output parsing for relay triggers
 *   - Cross-platform via Rust binary
 */

import { createConnection, type Socket } from 'node:net';
import { watch, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, symlinkSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type DeliverEnvelope,
} from '@agent-relay/protocol/types';
import { RelaycastInjector, type RelaycastInjectorConfig } from './relaycast-injector.js';

function generateId(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

export interface HostedRunnerConfig {
  /** Command to run (e.g. 'claude') */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Agent name (default: auto-generated) */
  agentName?: string;
  /** Working directory for the CLI */
  cwd?: string;
  /** Enable debug logging */
  debug?: boolean;

  // ─── Messaging backend (choose one) ────────────────────────────────

  /**
   * Relaycast API key (rk_live_...) — uses relaycast.dev for messaging.
   * If set, relaycast mode is used. Agent uses relaycast MCP tools for outbound.
   * Default: RELAYCAST_API_KEY env var
   */
  relaycastApiKey?: string;

  /**
   * Pre-existing relaycast agent token (skips registration).
   * Default: RELAYCAST_AGENT_TOKEN env var
   */
  relaycastAgentToken?: string;

  /** Relaycast API base URL (default: https://api.relaycast.dev) */
  relaycastApiUrl?: string;

  /** Channels to subscribe to in relaycast (default: ['general']) */
  channels?: string[];

  /**
   * Custom hosted daemon WebSocket URL — uses our own hosted daemon.
   * If set (and no relaycastApiKey), custom daemon mode is used.
   * Default: RELAY_URL env var
   */
  url?: string;

  /** Auth token for custom hosted daemon. Default: RELAY_TOKEN env var */
  token?: string;
}

/** Tracked relay-pty worker (primary agent or spawned agent) */
interface PtyWorker {
  name: string;
  cli: string;
  socketPath: string;
  outboxDir: string;
  process: import('node:child_process').ChildProcess;
  socket?: Socket;
  socketConnected: boolean;
  outboxWatcher?: FSWatcher;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingFiles: Set<string>;
  /** Relaycast injector for this worker (relaycast mode only) */
  injector?: RelaycastInjector;
}

/**
 * Parse a header-format outbox file.
 */
function parseOutboxFile(content: string): {
  to?: string;
  kind?: string;
  name?: string;
  cli?: string;
  thread?: string;
  action?: string;
  body: string;
} | null {
  const blankLineIdx = content.indexOf('\n\n');
  let headerSection: string;
  let body: string;

  if (blankLineIdx === -1) {
    headerSection = content;
    body = '';
  } else {
    headerSection = content.substring(0, blankLineIdx);
    body = content.substring(blankLineIdx + 2);
  }

  const headers: Record<string, string> = {};
  for (const line of headerSection.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toUpperCase();
    const value = line.substring(colonIdx + 1).trim();
    if (key && value) {
      headers[key] = value;
    }
  }

  if (!headers['TO'] && !headers['KIND']) {
    try {
      const json = JSON.parse(content);
      return {
        to: json.to,
        kind: json.kind ?? 'message',
        name: json.name,
        cli: json.cli,
        thread: json.thread,
        body: json.body ?? '',
      };
    } catch {
      return null;
    }
  }

  return {
    to: headers['TO'],
    kind: headers['KIND'] ?? 'message',
    name: headers['NAME'],
    cli: headers['CLI'],
    thread: headers['THREAD'],
    action: headers['ACTION'],
    body: body.trim(),
  };
}

type MessagingMode = 'relaycast' | 'custom';

export class HostedRunner {
  private config: HostedRunnerConfig;
  private mode: MessagingMode;
  private agentName: string;
  private workers: Map<string, PtyWorker> = new Map();
  private baseDir: string;
  private stopped = false;

  // Custom daemon mode fields
  private ws?: WebSocket;
  private wsConnected = false;
  private sessionId?: string;
  private resumeToken?: string;
  private reconnectDelay = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private customUrl: string;
  private customToken?: string;

  // Relaycast mode fields
  private relaycastApiKey?: string;
  private relaycastApiUrl: string;
  private relaycastAgentToken?: string;

  constructor(config: HostedRunnerConfig) {
    this.config = config;
    this.agentName = config.agentName ?? `${config.command}-${generateId().substring(0, 6)}`;

    // Determine messaging mode
    this.relaycastApiKey = config.relaycastApiKey || process.env.RELAYCAST_API_KEY;
    this.relaycastAgentToken = config.relaycastAgentToken || process.env.RELAYCAST_AGENT_TOKEN;
    this.relaycastApiUrl = config.relaycastApiUrl || process.env.RELAYCAST_API_URL || 'https://api.relaycast.dev';
    this.customUrl = config.url || process.env.RELAY_URL || process.env.AGENT_RELAY_URL || '';
    this.customToken = config.token || process.env.RELAY_TOKEN || process.env.AGENT_RELAY_TOKEN;

    if (this.relaycastApiKey || this.relaycastAgentToken) {
      this.mode = 'relaycast';
    } else {
      this.mode = 'custom';
    }

    // Base directory for sockets and outboxes
    const workspaceId = process.env.RELAY_WORKSPACE_ID
      || process.env.AGENT_RELAY_WORKSPACE_ID
      || process.env.WORKSPACE_ID;

    if (workspaceId) {
      this.baseDir = `/tmp/relay/${workspaceId}`;
    } else {
      this.baseDir = path.join(os.homedir(), '.agent-relay', 'hosted');
    }
  }

  // ─── Main Entry Point ──────────────────────────────────────────────

  async run(): Promise<number> {
    if (this.mode === 'relaycast') {
      return this.runRelaycast();
    } else {
      return this.runCustomDaemon();
    }
  }

  // ─── Relaycast Mode ────────────────────────────────────────────────

  /**
   * Relaycast mode:
   * 1. Spawn relay-pty wrapping the CLI
   * 2. Create RelaycastInjector (registers agent, connects WebSocket)
   * 3. Injector pushes incoming messages → relay-pty socket → CLI stdin
   * 4. Agent uses relaycast MCP tools for outbound (send_dm, post_message)
   */
  private async runRelaycast(): Promise<number> {
    if (!this.relaycastApiKey && !this.relaycastAgentToken) {
      console.error('[relay run] RELAYCAST_API_KEY not set.');
      console.error('  export RELAYCAST_API_KEY=rk_live_...');
      return 1;
    }

    this.log(`Mode: relaycast`);
    this.log(`Agent: ${this.agentName}`);
    this.log(`API: ${this.relaycastApiUrl}`);

    // Ensure base dirs
    mkdirSync(path.join(this.baseDir, 'sockets'), { recursive: true });
    mkdirSync(path.join(this.baseDir, 'outbox'), { recursive: true });

    // Step 1: Spawn relay-pty for the primary CLI
    const worker = await this.spawnRelayPty(
      this.agentName,
      this.config.command,
      this.config.args ?? [],
      false // interactive
    );

    if (!worker) {
      console.error('[relay run] Failed to spawn relay-pty');
      return 1;
    }

    // Step 2: Create and start the relaycast injector
    const injector = new RelaycastInjector({
      apiKey: this.relaycastApiKey!,
      agentToken: this.relaycastAgentToken,
      agentName: this.agentName,
      apiUrl: this.relaycastApiUrl,
      socketPath: worker.socketPath,
      channels: this.config.channels ?? ['general'],
      debug: this.config.debug,
    });

    worker.injector = injector;

    try {
      await injector.start();
    } catch (err) {
      console.error(`[relay run] Failed to connect to relaycast: ${(err as Error).message}`);
      // Continue anyway — the CLI can still work, just no injection
    }

    // Pass the agent token to the CLI environment for MCP tools
    if (injector.token) {
      // The relaycast MCP server can use this token
      process.env.RELAYCAST_AGENT_TOKEN = injector.token;
    }

    // Step 3: Watch outbox for spawn/release (relaycast handles messaging)
    this.startOutboxWatcher(worker);

    // Step 4: Wait for process exit
    return new Promise<number>((resolve) => {
      worker.process.on('exit', (code) => {
        this.log(`Agent exited with code ${code ?? 0}`);
        injector.stop();
        this.cleanupWorker(this.agentName);
        resolve(code ?? 0);
      });

      worker.process.on('error', (err) => {
        console.error(`[relay run] Process error: ${err.message}`);
        injector.stop();
        resolve(1);
      });
    });
  }

  // ─── Custom Daemon Mode ────────────────────────────────────────────

  /**
   * Custom daemon mode:
   * Uses our own hosted daemon WebSocket for messaging.
   * Full bidirectional bridge: relay-pty ↔ WebSocket ↔ hosted daemon.
   */
  private async runCustomDaemon(): Promise<number> {
    if (!this.customUrl) {
      console.error('[relay run] No messaging backend configured.');
      console.error('  Set RELAYCAST_API_KEY for relaycast, or RELAY_URL for custom daemon.');
      return 1;
    }

    this.log(`Mode: custom daemon`);
    this.log(`Agent: ${this.agentName}`);
    this.log(`URL: ${this.customUrl}`);

    mkdirSync(path.join(this.baseDir, 'sockets'), { recursive: true });
    mkdirSync(path.join(this.baseDir, 'outbox'), { recursive: true });

    // Connect to custom hosted daemon
    try {
      await this.connectCustomDaemon();
    } catch (err) {
      console.error(`[relay run] Failed to connect: ${(err as Error).message}`);
      return 1;
    }

    // Spawn relay-pty for the primary CLI
    const worker = await this.spawnRelayPty(
      this.agentName,
      this.config.command,
      this.config.args ?? [],
      false
    );

    if (!worker) {
      console.error('[relay run] Failed to spawn relay-pty');
      return 1;
    }

    this.startOutboxWatcher(worker);

    return new Promise<number>((resolve) => {
      worker.process.on('exit', (code) => {
        this.log(`Agent exited with code ${code ?? 0}`);
        this.shutdown();
        resolve(code ?? 0);
      });

      worker.process.on('error', (err) => {
        console.error(`[relay run] Process error: ${err.message}`);
        this.shutdown();
        resolve(1);
      });
    });
  }

  // ─── Custom Daemon WebSocket ───────────────────────────────────────

  private connectCustomDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      let wsUrl = this.customUrl;
      if (this.customToken) {
        const sep = wsUrl.includes('?') ? '&' : '?';
        wsUrl = `${wsUrl}${sep}token=${this.customToken}`;
      }

      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('Connection timeout'));
      }, 10000);

      this.ws.on('open', () => {
        const hello: Envelope<HelloPayload> = {
          v: PROTOCOL_VERSION,
          type: 'HELLO',
          id: generateId(),
          ts: Date.now(),
          payload: {
            agent: this.agentName,
            capabilities: { ack: true, resume: true, max_inflight: 100, supports_topics: true },
            cli: this.config.command,
            ...(this.resumeToken ? { session: { resume_token: this.resumeToken } } : {}),
          },
        };
        this.ws!.send(JSON.stringify(hello));
      });

      this.ws.on('message', (data) => {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        try {
          const envelope = JSON.parse(raw) as Envelope;
          this.handleCustomEnvelope(envelope, resolve, clearTimeout.bind(null, timeout));
        } catch {}
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        this.wsConnected = false;
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.wsConnected) reject(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectCustomDaemon();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private handleCustomEnvelope(
    envelope: Envelope,
    onWelcome?: (value: void) => void,
    clearConnTimeout?: () => void
  ): void {
    switch (envelope.type) {
      case 'WELCOME': {
        const welcome = envelope as Envelope<WelcomePayload>;
        this.sessionId = welcome.payload.session_id;
        this.resumeToken = welcome.payload.resume_token;
        this.wsConnected = true;
        this.reconnectDelay = 1000;
        clearConnTimeout?.();
        onWelcome?.();
        this.log(`Connected to daemon (session: ${this.sessionId})`);
        break;
      }

      case 'DELIVER': {
        const deliver = envelope as DeliverEnvelope;
        const from = deliver.from ?? 'unknown';
        const to = deliver.to ?? this.agentName;
        const body = deliver.payload?.body ?? '';
        this.injectToWorker(to, from, body, deliver.id);
        this.wsSend({
          v: PROTOCOL_VERSION,
          type: 'ACK',
          id: generateId(),
          ts: Date.now(),
          from: this.agentName,
          to: from,
          payload: { ack_id: deliver.id },
        });
        break;
      }

      case 'PING': {
        this.wsSend({
          v: PROTOCOL_VERSION,
          type: 'PONG',
          id: generateId(),
          ts: Date.now(),
          payload: (envelope.payload as { nonce?: string }) ?? {},
        });
        break;
      }

      case 'ERROR': {
        const err = envelope.payload as { message?: string; fatal?: boolean };
        console.error(`[relay] Error: ${err.message}`);
        if (err.fatal) this.shutdown();
        break;
      }
    }
  }

  // ─── relay-pty Spawning ────────────────────────────────────────────

  private async spawnRelayPty(
    name: string,
    command: string,
    args: string[],
    headless: boolean
  ): Promise<PtyWorker | null> {
    const socketPath = path.join(this.baseDir, 'sockets', `${name}.sock`);
    const outboxDir = path.join(this.baseDir, 'outbox', name);
    const logPath = path.join(this.baseDir, 'logs', `${name}.log`);

    try { unlinkSync(socketPath); } catch {}
    mkdirSync(path.dirname(socketPath), { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(path.dirname(logPath), { recursive: true });

    // Canonical outbox symlink at ~/.agent-relay/outbox/<name>
    const canonicalOutbox = path.join(os.homedir(), '.agent-relay', 'outbox', name);
    try {
      mkdirSync(path.dirname(canonicalOutbox), { recursive: true });
      if (canonicalOutbox !== outboxDir) {
        try { unlinkSync(canonicalOutbox); } catch {}
        symlinkSync(outboxDir, canonicalOutbox);
      }
    } catch {}

    const relayPtyBin = await this.findRelayPtyBinary();
    if (!relayPtyBin) {
      console.error('[relay run] relay-pty binary not found.');
      return null;
    }

    const ptyArgs = [
      '--name', name,
      '--socket', socketPath,
      '--idle-timeout', '500',
      '--json-output',
      '--rows', '24',
      '--cols', '80',
      '--log-level', this.config.debug ? 'debug' : 'warn',
      '--log-file', logPath,
      '--outbox', outboxDir,
      '--',
      command,
      ...args,
    ];

    this.log(`Spawning: ${relayPtyBin} ... -- ${command} ${args.join(' ')}`);

    const { spawn } = await import('node:child_process');
    const proc = spawn(relayPtyBin, ptyArgs, {
      stdio: headless
        ? ['pipe', 'pipe', 'pipe']
        : ['inherit', 'inherit', 'pipe'],
      cwd: this.config.cwd || process.cwd(),
      env: {
        ...process.env,
        AGENT_RELAY_NAME: name,
        RELAY_AGENT_NAME: name,
        AGENT_RELAY_OUTBOX: canonicalOutbox,
        ...(this.customUrl ? { RELAY_URL: this.customUrl } : {}),
        ...(this.customToken ? { RELAY_TOKEN: this.customToken } : {}),
        ...(this.relaycastApiKey ? { RELAYCAST_API_KEY: this.relaycastApiKey } : {}),
        ...(this.relaycastAgentToken ? { RELAYCAST_AGENT_TOKEN: this.relaycastAgentToken } : {}),
        TERM: process.env.TERM || 'xterm-256color',
      },
    });

    const worker: PtyWorker = {
      name,
      cli: command,
      socketPath,
      outboxDir,
      process: proc,
      socketConnected: false,
      debounceTimers: new Map(),
      pendingFiles: new Set(),
    };

    this.workers.set(name, worker);

    // Parse stderr for relay commands
    if (proc.stderr) {
      let buf = '';
      proc.stderr.on('data', (data: Buffer) => {
        buf += data.toString('utf-8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          this.handleRelayPtyOutput(worker, line.trim());
        }
      });
    }

    // Connect to injection socket
    await this.connectToSocket(worker);

    return worker;
  }

  private async findRelayPtyBinary(): Promise<string | null> {
    if (process.env.RELAY_PTY_PATH && existsSync(process.env.RELAY_PTY_PATH)) {
      return process.env.RELAY_PTY_PATH;
    }

    const candidates = [
      path.join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
      path.join(os.homedir(), '.npm', 'bin', 'relay-pty'),
      path.resolve(import.meta.dirname ?? '.', '..', '..', '..', 'relay-pty', 'target', 'release', 'relay-pty'),
    ];

    for (const c of candidates) {
      if (existsSync(c)) return c;
    }

    try {
      const { execSync } = await import('node:child_process');
      const result = execSync('which relay-pty', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (result && existsSync(result)) return result;
    } catch {}

    try {
      const { findRelayPtyBinary: findBin } = await import('@agent-relay/utils/relay-pty-path');
      return await findBin();
    } catch {}

    return null;
  }

  // ─── Injection Socket ──────────────────────────────────────────────

  private async connectToSocket(worker: PtyWorker, attempt = 0): Promise<void> {
    const MAX = 20;
    const DELAY = 300;

    if (attempt >= MAX) {
      this.log(`Socket connect failed for ${worker.name} after ${MAX} attempts`);
      return;
    }

    if (!existsSync(worker.socketPath)) {
      await new Promise(r => setTimeout(r, DELAY * Math.min(attempt + 1, 5)));
      return this.connectToSocket(worker, attempt + 1);
    }

    return new Promise<void>((resolve) => {
      const socket = createConnection(worker.socketPath);

      socket.on('connect', () => {
        worker.socket = socket;
        worker.socketConnected = true;
        this.log(`Injection socket connected: ${worker.name}`);
        resolve();
      });

      socket.on('data', (data) => {
        for (const line of data.toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r.type === 'inject_result') {
              this.log(`Inject ${r.id?.substring(0, 8)}: ${r.status}`);
            }
          } catch {}
        }
      });

      socket.on('error', () => {
        worker.socketConnected = false;
        worker.socket = undefined;
        if (attempt < MAX - 1) {
          setTimeout(() => this.connectToSocket(worker, attempt + 1).then(resolve), DELAY * Math.min(attempt + 1, 5));
        } else {
          resolve();
        }
      });

      socket.on('close', () => {
        worker.socketConnected = false;
        worker.socket = undefined;
        if (!this.stopped && worker.process.exitCode === null) {
          setTimeout(() => this.connectToSocket(worker, 0), 1000);
        }
      });
    });
  }

  private injectToWorker(targetAgent: string, from: string, body: string, messageId: string): void {
    const worker = this.workers.get(targetAgent) ?? this.workers.get(this.agentName);
    if (!worker?.socket || !worker.socketConnected) {
      this.log(`Cannot inject to ${targetAgent}: socket not connected`);
      return;
    }

    const request = JSON.stringify({
      type: 'inject',
      id: messageId,
      from,
      body,
      priority: 0,
    }) + '\n';

    worker.socket.write(request);
    this.log(`Injected: ${from} → ${targetAgent} (${body.length}B)`);
  }

  // ─── Outbox Watcher ────────────────────────────────────────────────

  private startOutboxWatcher(worker: PtyWorker): void {
    try {
      worker.outboxWatcher = watch(worker.outboxDir, (_type, filename) => {
        if (!filename) return;
        const existing = worker.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);
        worker.debounceTimers.set(filename, setTimeout(() => {
          worker.debounceTimers.delete(filename);
          this.processOutboxFile(worker, filename);
        }, 100));
      });
    } catch {}

    try {
      for (const f of readdirSync(worker.outboxDir)) {
        this.processOutboxFile(worker, f);
      }
    } catch {}
  }

  private processOutboxFile(worker: PtyWorker, filename: string): void {
    if (filename.startsWith('.') || filename.endsWith('.tmp')) return;
    if (worker.pendingFiles.has(filename)) return;

    const filePath = path.join(worker.outboxDir, filename);
    if (!existsSync(filePath)) return;

    worker.pendingFiles.add(filename);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseOutboxFile(content);
      if (!parsed) { worker.pendingFiles.delete(filename); return; }

      switch (parsed.kind) {
        case 'spawn': {
          if (parsed.name && parsed.cli) {
            this.handleSpawn(parsed.name, parsed.cli, parsed.body, worker.name);
          }
          break;
        }
        case 'release': {
          if (parsed.name) this.handleRelease(parsed.name);
          break;
        }
        default: {
          // In custom daemon mode, forward messages via WebSocket
          // In relaycast mode, agent uses MCP tools — but handle local routing
          if (this.mode === 'custom' && parsed.to) {
            const targetWorker = this.workers.get(parsed.to);
            if (targetWorker?.socketConnected) {
              this.injectToWorker(parsed.to, worker.name, parsed.body, generateId());
            } else {
              this.wsSend({
                v: PROTOCOL_VERSION,
                type: 'SEND',
                id: generateId(),
                ts: Date.now(),
                from: worker.name,
                to: parsed.to,
                payload: {
                  kind: (parsed.kind as SendPayload['kind']) ?? 'message',
                  body: parsed.body,
                  thread: parsed.thread,
                },
              });
            }
          } else if (this.mode === 'relaycast' && parsed.to) {
            // Local-to-local routing for spawned agents
            const targetWorker = this.workers.get(parsed.to);
            if (targetWorker?.socketConnected) {
              this.injectToWorker(parsed.to, worker.name, parsed.body, generateId());
            }
            // Remote messages go through relaycast MCP tools (agent handles it)
          }
          break;
        }
      }

      try { unlinkSync(filePath); } catch {}
    } catch (err) {
      this.log(`Outbox error ${filename}: ${(err as Error).message}`);
    } finally {
      worker.pendingFiles.delete(filename);
    }
  }

  // ─── relay-pty stderr parsing ──────────────────────────────────────

  private handleRelayPtyOutput(worker: PtyWorker, line: string): void {
    if (!line.startsWith('{')) return;

    try {
      const event = JSON.parse(line);
      if (event.type !== 'relay_command') return;

      switch (event.kind) {
        case 'spawn':
          if (event.name && event.cli) {
            this.handleSpawn(event.name, event.cli, event.task || event.body || '', worker.name);
          }
          break;
        case 'release':
          if (event.name) this.handleRelease(event.name);
          break;
        case 'message':
          // In custom mode, route via WebSocket. In relaycast mode, agent uses MCP.
          if (this.mode === 'custom' && event.to && event.body) {
            const target = this.workers.get(event.to);
            if (target?.socketConnected) {
              this.injectToWorker(event.to, worker.name, event.body, generateId());
            } else {
              this.wsSend({
                v: PROTOCOL_VERSION,
                type: 'SEND',
                id: generateId(),
                ts: Date.now(),
                from: worker.name,
                to: event.to,
                payload: { kind: 'message', body: event.body, thread: event.thread },
              });
            }
          }
          break;
      }
    } catch {}
  }

  // ─── Spawn / Release ───────────────────────────────────────────────

  private async handleSpawn(name: string, cli: string, task: string, spawner: string): Promise<void> {
    if (this.workers.has(name)) {
      this.log(`Agent ${name} already running`);
      return;
    }

    this.log(`Spawning: ${name} (cli: ${cli}, spawner: ${spawner})`);

    const cliArgs: string[] = [];
    switch (cli) {
      case 'claude': cliArgs.push('--dangerously-skip-permissions'); break;
      case 'codex': cliArgs.push('--dangerously-bypass-approvals-and-sandbox'); break;
      case 'gemini': cliArgs.push('--yolo'); break;
    }

    const worker = await this.spawnRelayPty(name, cli, cliArgs, true);
    if (!worker) {
      this.injectToWorker(spawner, '_system', `Failed to spawn ${name}`, generateId());
      return;
    }

    // In relaycast mode, create an injector for the spawned agent too
    if (this.mode === 'relaycast' && this.relaycastApiKey) {
      const injector = new RelaycastInjector({
        apiKey: this.relaycastApiKey,
        agentName: name,
        apiUrl: this.relaycastApiUrl,
        socketPath: worker.socketPath,
        channels: this.config.channels ?? ['general'],
        debug: this.config.debug,
      });
      worker.injector = injector;
      try { await injector.start(); } catch {}
    }

    this.startOutboxWatcher(worker);

    // Wait for socket, then inject task
    const start = Date.now();
    while (!worker.socketConnected && Date.now() - start < 20000) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (worker.socketConnected && task) {
      await new Promise(r => setTimeout(r, 2000));
      this.injectToWorker(name, spawner, task, generateId());
      this.log(`Task injected to ${name}`);
    }

    this.injectToWorker(spawner, name, `ACK: ${name} spawned and ready`, generateId());

    worker.process.on('exit', (code) => {
      this.log(`Worker ${name} exited (${code ?? 0})`);
      worker.injector?.stop();
      this.cleanupWorker(name);
      if (this.workers.has(spawner)) {
        this.injectToWorker(spawner, name, `DONE: ${name} exited (${code ?? 0})`, generateId());
      }
    });
  }

  private handleRelease(name: string): void {
    const worker = this.workers.get(name);
    if (!worker) return;

    this.log(`Releasing: ${name}`);
    worker.injector?.stop();

    if (worker.socket && worker.socketConnected) {
      worker.socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    }

    setTimeout(() => {
      if (worker.process.exitCode === null) {
        worker.process.kill('SIGTERM');
        setTimeout(() => {
          if (worker.process.exitCode === null) worker.process.kill('SIGKILL');
        }, 5000);
      }
    }, 10000);
  }

  private cleanupWorker(name: string): void {
    const worker = this.workers.get(name);
    if (!worker) return;

    worker.outboxWatcher?.close();
    for (const t of worker.debounceTimers.values()) clearTimeout(t);
    worker.socket?.destroy();
    try { unlinkSync(worker.socketPath); } catch {}
    this.workers.delete(name);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private wsSend(envelope: Envelope): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  private log(msg: string): void {
    if (this.config.debug) {
      process.stderr.write(`[relay run] ${msg}\n`);
    }
  }

  private shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    for (const [name, worker] of this.workers) {
      worker.injector?.stop();
      this.cleanupWorker(name);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'BYE',
          id: generateId(),
          ts: Date.now(),
          payload: {},
        }));
      } catch {}
      this.ws.close();
    }
  }
}

/**
 * Run a CLI with relay messaging (one-liner API).
 *
 * Auto-detects messaging backend:
 *   - RELAYCAST_API_KEY → uses relaycast.dev
 *   - RELAY_URL → uses custom hosted daemon
 *
 * Usage:
 *   const exitCode = await hostedRun({ command: 'claude' });
 */
export async function hostedRun(config: HostedRunnerConfig): Promise<number> {
  const runner = new HostedRunner(config);
  return runner.run();
}
