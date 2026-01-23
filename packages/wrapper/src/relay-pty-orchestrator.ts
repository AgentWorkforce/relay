/**
 * RelayPtyOrchestrator - Orchestrates the relay-pty Rust binary
 *
 * This wrapper spawns the relay-pty binary and communicates via Unix socket.
 * It provides the same interface as PtyWrapper but with improved latency
 * (~550ms vs ~1700ms) by using direct PTY writes instead of tmux send-keys.
 *
 * Architecture:
 * 1. Spawn relay-pty --name {agentName} -- {command} as child process
 * 2. Connect to socket for injection:
 *    - With WORKSPACE_ID: /tmp/relay/{workspaceId}/sockets/{agentName}.sock
 *    - Without: /tmp/relay-pty-{agentName}.sock (legacy)
 * 3. Parse stdout for relay commands (relay-pty echoes all output)
 * 4. Translate SEND envelopes → inject messages via socket
 *
 * @see docs/RUST_WRAPPER_DESIGN.md for protocol details
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createConnection, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { existsSync, unlinkSync, mkdirSync, symlinkSync, lstatSync, rmSync, watch, readdirSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { getProjectPaths } from '@agent-relay/config/project-namespace';
import { getAgentOutboxTemplate } from '@agent-relay/config/relay-file-writer';
import { fileURLToPath } from 'node:url';

// Get the directory where this module is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { BaseWrapper, type BaseWrapperConfig } from './base-wrapper.js';
import { parseSummaryWithDetails, parseSessionEndFromOutput } from './parser.js';
import type { SendPayload, SendMeta } from '@agent-relay/protocol/types';
import {
  type QueuedMessage,
  stripAnsi,
  sleep,
  buildInjectionString,
  verifyInjection,
  INJECTION_CONSTANTS,
  AdaptiveThrottle,
} from './shared.js';
import {
  getMemoryMonitor,
  type AgentMemoryMonitor,
  type MemoryAlert,
  formatBytes,
} from '@agent-relay/resiliency';

// ============================================================================
// Types for relay-pty socket protocol
// ============================================================================

const MAX_SOCKET_PATH_LENGTH = 107;

function hashWorkspaceId(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 12);
}

/**
 * Request types sent to relay-pty socket
 */
interface InjectRequest {
  type: 'inject';
  id: string;
  from: string;
  body: string;
  priority: number;
}

interface StatusRequest {
  type: 'status';
}

interface ShutdownRequest {
  type: 'shutdown';
}

type RelayPtyRequest = InjectRequest | StatusRequest | ShutdownRequest;

/**
 * Response types received from relay-pty socket
 */
interface InjectResultResponse {
  type: 'inject_result';
  id: string;
  status: 'queued' | 'injecting' | 'delivered' | 'failed';
  timestamp: number;
  error?: string;
}

interface StatusResponse {
  type: 'status';
  agent_idle: boolean;
  queue_length: number;
  cursor_position?: [number, number];
  last_output_ms: number;
}

interface BackpressureResponse {
  type: 'backpressure';
  queue_length: number;
  accept: boolean;
}

interface ErrorResponse {
  type: 'error';
  message: string;
}

interface ShutdownAckResponse {
  type: 'shutdown_ack';
}

type RelayPtyResponse =
  | InjectResultResponse
  | StatusResponse
  | BackpressureResponse
  | ErrorResponse
  | ShutdownAckResponse;

/**
 * Configuration for RelayPtyOrchestrator
 */
export interface RelayPtyOrchestratorConfig extends BaseWrapperConfig {
  /** Path to relay-pty binary (default: searches PATH and ./relay-pty/target/release) */
  relayPtyPath?: string;
  /** Socket connect timeout in ms (default: 5000) */
  socketConnectTimeoutMs?: number;
  /** Socket reconnect attempts (default: 3) */
  socketReconnectAttempts?: number;
  /** Callback when agent exits */
  onExit?: (code: number) => void;
  /** Callback when injection fails after retries */
  onInjectionFailed?: (messageId: string, error: string) => void;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Force headless mode (use pipes instead of inheriting TTY) */
  headless?: boolean;
}

/**
 * Events emitted by RelayPtyOrchestrator
 */
export interface RelayPtyOrchestratorEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
  'injection-failed': (event: { messageId: string; from: string; error: string }) => void;
  'backpressure': (event: { queueLength: number; accept: boolean }) => void;
  'summary': (event: { agentName: string; summary: unknown }) => void;
  'session-end': (event: { agentName: string; marker: unknown }) => void;
}

/**
 * Orchestrator for relay-pty Rust binary
 *
 * Extends BaseWrapper to provide the same interface as PtyWrapper
 * but uses the relay-pty binary for improved injection reliability.
 */
export class RelayPtyOrchestrator extends BaseWrapper {
  protected override config: RelayPtyOrchestratorConfig;

  // Process management
  private relayPtyProcess?: ChildProcess;
  private socketPath: string;
  private _logPath: string;
  private _outboxPath: string;
  private _legacyOutboxPath: string; // Legacy /tmp/relay-outbox path for backwards compat
  private _canonicalOutboxPath: string; // Canonical ~/.agent-relay/outbox path (agents write here)
  private _workspaceId?: string; // For symlink setup
  private socket?: Socket;
  private socketConnected = false;

  // Output buffering
  private outputBuffer = '';
  private rawBuffer = '';
  private lastParsedLength = 0;

  // Interactive mode (show output to terminal)
  private isInteractive = false;

  // Injection state
  private pendingInjections: Map<string, {
    resolve: (success: boolean) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    from: string;        // For verification pattern matching
    shortId: string;     // First 8 chars of messageId for verification
    retryCount: number;  // Track retry attempts
    originalBody: string; // Original injection content for retries
  }> = new Map();
  private backpressureActive = false;
  private readyForMessages = false;

  // Adaptive throttle for message queue - adjusts delay based on success/failure
  private throttle = new AdaptiveThrottle();

  // Unread message indicator state
  private lastUnreadIndicatorTime = 0;
  private readonly UNREAD_INDICATOR_COOLDOWN_MS = 5000; // Don't spam indicators

  // Track whether any output has been received from the CLI
  private hasReceivedOutput = false;

  // Queue monitor for stuck message detection
  private queueMonitorTimer?: NodeJS.Timeout;
  private readonly QUEUE_MONITOR_INTERVAL_MS = 30000; // Check every 30 seconds
  private injectionStartTime = 0; // Track when isInjecting was set to true
  private readonly MAX_INJECTION_STUCK_MS = 60000; // Force reset after 60 seconds

  // Protocol monitor for detecting agent mistakes (e.g., empty AGENT_RELAY_NAME)
  private protocolWatcher?: FSWatcher;
  private protocolReminderCooldown = 0; // Prevent spam
  private readonly PROTOCOL_REMINDER_COOLDOWN_MS = 30000; // 30 second cooldown between reminders

  // Periodic protocol reminder for long sessions (agents sometimes forget the protocol)
  private periodicReminderTimer?: NodeJS.Timeout;
  private readonly PERIODIC_REMINDER_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes
  private sessionStartTime = 0;

  // Track if agent is being gracefully stopped (vs crashed)
  private isGracefulStop = false;

  // Memory/CPU monitoring
  private memoryMonitor: AgentMemoryMonitor;
  private memoryAlertHandler: ((alert: MemoryAlert) => void) | null = null;

  // Note: sessionEndProcessed and lastSummaryRawContent are inherited from BaseWrapper

  constructor(config: RelayPtyOrchestratorConfig) {
    super(config);
    this.config = config;

    // Get project paths (used for logs and local mode)
    const projectPaths = getProjectPaths(config.cwd);

    // Canonical outbox path - agents ALWAYS write here (transparent symlink in workspace mode)
    // Uses ~/.agent-relay/outbox/{agentName}/ so agents don't need to know about workspace IDs
    this._canonicalOutboxPath = join(projectPaths.dataDir, 'outbox', config.name);

    // Check for workspace namespacing (for multi-tenant cloud deployment)
    // WORKSPACE_ID can be in process.env or passed via config.env
    const workspaceId = config.env?.WORKSPACE_ID || process.env.WORKSPACE_ID;
    this._workspaceId = workspaceId;

    if (workspaceId) {
      // Workspace mode: relay-pty watches the actual workspace path
      // Canonical path (~/.agent-relay/outbox/) will be symlinked to workspace path
      const getWorkspacePaths = (id: string) => {
        const workspaceDir = `/tmp/relay/${id}`;
        return {
          workspaceDir,
          socketPath: `${workspaceDir}/sockets/${config.name}.sock`,
          outboxPath: `${workspaceDir}/outbox/${config.name}`,
        };
      };

      let paths = getWorkspacePaths(workspaceId);
      if (paths.socketPath.length > MAX_SOCKET_PATH_LENGTH) {
        const hashedWorkspaceId = hashWorkspaceId(workspaceId);
        const hashedPaths = getWorkspacePaths(hashedWorkspaceId);
        console.warn(
          `[relay-pty-orchestrator:${config.name}] Socket path too long (${paths.socketPath.length} chars); using hashed workspace id ${hashedWorkspaceId}`
        );
        paths = hashedPaths;
      }

      if (paths.socketPath.length > MAX_SOCKET_PATH_LENGTH) {
        throw new Error(`Socket path exceeds ${MAX_SOCKET_PATH_LENGTH} chars: ${paths.socketPath.length}`);
      }

      this.socketPath = paths.socketPath;
      // relay-pty watches the actual workspace path
      this._outboxPath = paths.outboxPath;
      // Legacy path for backwards compat (older agents might still use /tmp/relay-outbox)
      this._legacyOutboxPath = `/tmp/relay-outbox/${config.name}`;
    } else {
      // Local mode: use ~/.agent-relay paths directly (no symlinks needed)
      this._outboxPath = this._canonicalOutboxPath;
      // Socket at {projectRoot}/.agent-relay/sockets/{agentName}.sock
      let localSocketPath = join(projectPaths.dataDir, 'sockets', `${config.name}.sock`);

      // If socket path is too long, fall back to /tmp/relay-local/{projectId}/sockets/
      if (localSocketPath.length > MAX_SOCKET_PATH_LENGTH) {
        const tmpSocketPath = `/tmp/relay-local/${projectPaths.projectId}/sockets/${config.name}.sock`;
        console.warn(
          `[relay-pty-orchestrator:${config.name}] Socket path too long (${localSocketPath.length} chars); using /tmp fallback`
        );
        localSocketPath = tmpSocketPath;
      }

      this.socketPath = localSocketPath;
      // No legacy path needed for local mode
      this._legacyOutboxPath = this._outboxPath;
    }
    if (this.socketPath.length > MAX_SOCKET_PATH_LENGTH) {
      throw new Error(`Socket path exceeds ${MAX_SOCKET_PATH_LENGTH} chars: ${this.socketPath.length}`);
    }

    // Generate log path using project paths
    this._logPath = join(projectPaths.teamDir, 'worker-logs', `${config.name}.log`);

    // Check if we're running interactively (stdin is a TTY)
    // If headless mode is forced via config, always use pipes
    this.isInteractive = config.headless ? false : (process.stdin.isTTY === true);

    // Initialize memory monitor (shared singleton, 10s polling interval)
    this.memoryMonitor = getMemoryMonitor({ checkIntervalMs: 10_000 });
  }

  /**
   * Debug log - only outputs when debug is enabled
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[relay-pty-orchestrator:${this.config.name}] ${message}`);
    }
  }

  /**
   * Error log - always outputs (errors are important)
   */
  private logError(message: string): void {
    if (this.config.debug) {
      console.error(`[relay-pty-orchestrator:${this.config.name}] ERROR: ${message}`);
    }
  }

  /**
   * Get the outbox path for this agent (for documentation purposes)
   */
  get outboxPath(): string {
    return this._outboxPath;
  }

  // =========================================================================
  // Abstract method implementations (required by BaseWrapper)
  // =========================================================================

  /**
   * Start the relay-pty process and connect to socket
   */
  override async start(): Promise<void> {
    if (this.running) return;

    this.log(` Starting...`);

    // Ensure socket directory exists (for workspace-namespaced paths)
    const socketDir = dirname(this.socketPath);
    try {
      if (!existsSync(socketDir)) {
        mkdirSync(socketDir, { recursive: true });
        this.log(` Created socket directory: ${socketDir}`);
      }
    } catch (err: any) {
      this.logError(` Failed to create socket directory: ${err.message}`);
    }

    // Clean up any stale socket from previous crashed process
    try {
      if (existsSync(this.socketPath)) {
        this.log(` Removing stale socket: ${this.socketPath}`);
        unlinkSync(this.socketPath);
      }
    } catch (err: any) {
      this.logError(` Failed to clean up socket: ${err.message}`);
    }

    // Set up outbox directory structure
    // - Workspace mode:
    //   1. Create actual workspace path /tmp/relay/{workspaceId}/outbox/{name}
    //   2. Symlink canonical ~/.agent-relay/outbox/{name} -> workspace path
    //   3. Optional: symlink /tmp/relay-outbox/{name} -> workspace path (backwards compat)
    // - Local mode: just create ~/.agent-relay/{projectId}/outbox/{name} directly
    try {
      // Ensure the actual outbox directory exists (where relay-pty watches)
      const outboxDir = dirname(this._outboxPath);
      if (!existsSync(outboxDir)) {
        mkdirSync(outboxDir, { recursive: true });
      }
      if (!existsSync(this._outboxPath)) {
        mkdirSync(this._outboxPath, { recursive: true });
      }
      this.log(` Created outbox directory: ${this._outboxPath}`);

      // In workspace mode, create symlinks so agents can use canonical path
      if (this._workspaceId) {
        // Helper to create a symlink, cleaning up existing path first
        const createSymlinkSafe = (linkPath: string, targetPath: string) => {
          const linkParent = dirname(linkPath);
          if (!existsSync(linkParent)) {
            mkdirSync(linkParent, { recursive: true });
          }
          if (existsSync(linkPath)) {
            try {
              const stats = lstatSync(linkPath);
              if (stats.isSymbolicLink() || stats.isFile()) {
                unlinkSync(linkPath);
              } else if (stats.isDirectory()) {
                rmSync(linkPath, { recursive: true, force: true });
              }
            } catch {
              // Ignore cleanup errors
            }
          }
          symlinkSync(targetPath, linkPath);
          this.log(` Created symlink: ${linkPath} -> ${targetPath}`);
        };

        // Symlink canonical path (~/.agent-relay/outbox/{name}) -> workspace path
        // This is the PRIMARY symlink - agents write to canonical path, relay-pty watches workspace path
        if (this._canonicalOutboxPath !== this._outboxPath) {
          createSymlinkSafe(this._canonicalOutboxPath, this._outboxPath);
        }

        // Also create legacy /tmp/relay-outbox symlink for backwards compat with older agents
        if (this._legacyOutboxPath !== this._outboxPath && this._legacyOutboxPath !== this._canonicalOutboxPath) {
          createSymlinkSafe(this._legacyOutboxPath, this._outboxPath);
        }
      }
    } catch (err: any) {
      this.logError(` Failed to set up outbox: ${err.message}`);
    }

    // Find relay-pty binary
    const binaryPath = this.findRelayPtyBinary();
    if (!binaryPath) {
      throw new Error('relay-pty binary not found. Build with: cd relay-pty && cargo build --release');
    }

    this.log(` Using binary: ${binaryPath}`);

    // Connect to relay daemon first
    try {
      await this.client.connect();
      this.log(` Relay daemon connected`);
    } catch (err: any) {
      this.logError(` Relay connect failed: ${err.message}`);
    }

    // Spawn relay-pty process
    await this.spawnRelayPty(binaryPath);

    // Wait for socket to become available and connect
    await this.connectToSocket();

    this.running = true;
    this.readyForMessages = true;
    this.startStuckDetection();
    this.startQueueMonitor();
    this.startProtocolMonitor();
    this.startPeriodicReminder();

    this.log(` Ready for messages`);
    this.log(` Socket connected: ${this.socketConnected}`);
    this.log(` Relay client state: ${this.client.state}`);

    // Process any queued messages
    this.processMessageQueue();
  }

  /**
   * Stop the relay-pty process gracefully
   */
  override async stop(): Promise<void> {
    if (!this.running) return;
    this.isGracefulStop = true; // Mark as graceful to prevent crash broadcast
    this.running = false;
    this.stopStuckDetection();
    this.stopQueueMonitor();
    this.stopProtocolMonitor();
    this.stopPeriodicReminder();

    // Unregister from memory monitor
    this.memoryMonitor.unregister(this.config.name);
    if (this.memoryAlertHandler) {
      this.memoryMonitor.off('alert', this.memoryAlertHandler);
      this.memoryAlertHandler = null;
    }

    this.log(` Stopping...`);

    // Send shutdown command via socket
    if (this.socket && this.socketConnected) {
      try {
        await this.sendSocketRequest({ type: 'shutdown' });
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Close socket
    this.disconnectSocket();

    // Kill process if still running
    if (this.relayPtyProcess && !this.relayPtyProcess.killed) {
      this.relayPtyProcess.kill('SIGTERM');

      // Force kill after timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          this.relayPtyProcess?.on('exit', () => resolve());
        }),
        sleep(5000).then(() => {
          if (this.relayPtyProcess && !this.relayPtyProcess.killed) {
            this.relayPtyProcess.kill('SIGKILL');
          }
        }),
      ]);
    }

    // Cleanup relay client
    this.destroyClient();

    // Clean up socket file
    try {
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
        this.log(` Cleaned up socket: ${this.socketPath}`);
      }
    } catch (err: any) {
      this.logError(` Failed to clean up socket: ${err.message}`);
    }

    this.log(` Stopped`);
  }

  /**
   * Inject content into the agent via socket
   */
  protected async performInjection(_content: string): Promise<void> {
    // This is called by BaseWrapper but we handle injection differently
    // via the socket protocol in processMessageQueue
    throw new Error('Use injectMessage() instead of performInjection()');
  }

  /**
   * Get cleaned output for parsing
   */
  protected getCleanOutput(): string {
    return stripAnsi(this.rawBuffer);
  }

  // =========================================================================
  // Process management
  // =========================================================================

  /**
   * Find the relay-pty binary
   */
  private findRelayPtyBinary(): string | null {
    // Check config path first
    if (this.config.relayPtyPath && existsSync(this.config.relayPtyPath)) {
      return this.config.relayPtyPath;
    }

    // Get the project root (three levels up from packages/wrapper/dist/)
    // packages/wrapper/dist/ -> packages/wrapper -> packages -> project root
    const projectRoot = join(__dirname, '..', '..', '..');

    // Check common locations (ordered by priority)
    const candidates = [
      // Primary: installed by postinstall from platform-specific binary
      join(projectRoot, 'bin', 'relay-pty'),
      // Development: local Rust build
      join(projectRoot, 'relay-pty', 'target', 'release', 'relay-pty'),
      join(projectRoot, 'relay-pty', 'target', 'debug', 'relay-pty'),
      // Local build in cwd (for development)
      join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
      join(process.cwd(), 'relay-pty', 'target', 'debug', 'relay-pty'),
      // Installed globally
      '/usr/local/bin/relay-pty',
      // In node_modules (when installed as dependency)
      join(process.cwd(), 'node_modules', 'agent-relay', 'bin', 'relay-pty'),
      join(process.cwd(), 'node_modules', '.bin', 'relay-pty'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Spawn the relay-pty process
   */
  private async spawnRelayPty(binaryPath: string): Promise<void> {
    // Get terminal dimensions for proper rendering
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    const args = [
      '--name', this.config.name,
      '--socket', this.socketPath,
      '--idle-timeout', String(this.config.idleBeforeInjectMs ?? 500),
      '--json-output', // Enable Rust parsing output
      '--rows', String(rows),
      '--cols', String(cols),
      '--log-level', 'warn', // Only show warnings and errors
      '--log-file', this._logPath, // Enable output logging
      '--outbox', this._outboxPath, // Enable file-based relay messages
      '--', this.config.command,
      ...(this.config.args ?? []),
    ];

    this.log(` Spawning: ${binaryPath} ${args.join(' ')}`);

    // For interactive mode, let Rust directly inherit stdin/stdout from the terminal
    // This is more robust than manual forwarding through pipes
    // We still pipe stderr to capture JSON parsed commands
    const stdio: ('inherit' | 'pipe')[] = this.isInteractive
      ? ['inherit', 'inherit', 'pipe']  // Rust handles terminal directly
      : ['pipe', 'pipe', 'pipe'];       // Headless mode - we handle I/O

    const proc = spawn(binaryPath, args, {
      cwd: this.config.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.config.env,
        AGENT_RELAY_NAME: this.config.name,
        AGENT_RELAY_OUTBOX: this._canonicalOutboxPath, // Agents use this for outbox path
        TERM: 'xterm-256color',
      },
      stdio,
    });
    this.relayPtyProcess = proc;

    // Handle stdout (agent output) - only in headless mode
    if (!this.isInteractive && proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        this.handleOutput(text);
      });
    }

    // Handle stderr (relay-pty logs and JSON output) - always needed
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        this.handleStderr(text);
      });
    }

    // Handle exit
    proc.on('exit', (code, signal) => {
      const exitCode = code ?? (signal === 'SIGKILL' ? 137 : 1);
      this.log(` Process exited: code=${exitCode} signal=${signal}`);
      this.running = false;

      // Get crash context before unregistering from memory monitor
      const crashContext = this.memoryMonitor.getCrashContext(this.config.name);

      // Unregister from memory monitor
      this.memoryMonitor.unregister(this.config.name);
      if (this.memoryAlertHandler) {
        this.memoryMonitor.off('alert', this.memoryAlertHandler);
        this.memoryAlertHandler = null;
      }

      // Broadcast crash notification if not a graceful stop
      if (!this.isGracefulStop && this.client.state === 'READY') {
        const canBroadcast = typeof (this.client as any).broadcast === 'function';
        const isNormalExit = exitCode === 0;
        const wasKilled = signal === 'SIGKILL' || signal === 'SIGTERM' || exitCode === 137;

        if (!isNormalExit) {
          const reason = wasKilled
            ? `killed by signal ${signal || 'SIGKILL'}`
            : `exit code ${exitCode}`;

          // Include crash context analysis if available
          const contextInfo = crashContext.likelyCause !== 'unknown'
            ? ` Likely cause: ${crashContext.likelyCause}. ${crashContext.analysisNotes.slice(0, 2).join('. ')}`
            : '';

          const message = `AGENT CRASHED: "${this.config.name}" has died unexpectedly (${reason}).${contextInfo}`;

          this.log(` Broadcasting crash notification: ${message}`);
          if (canBroadcast) {
            this.client.broadcast(message, 'message', {
              isSystemMessage: true,
              agentName: this.config.name,
              exitCode,
              signal: signal || undefined,
              crashType: 'unexpected_exit',
              crashContext: {
                likelyCause: crashContext.likelyCause,
                peakMemory: crashContext.peakMemory,
                averageMemory: crashContext.averageMemory,
                memoryTrend: crashContext.memoryTrend,
              },
            });
          } else {
            this.log(' broadcast skipped: client.broadcast not available');
          }
        }
      }

      this.emit('exit', exitCode);
      this.config.onExit?.(exitCode);
    });

    // Handle error
    proc.on('error', (err) => {
      this.logError(` Process error: ${err.message}`);
      this.emit('error', err);
    });

    // Wait for process to start
    await sleep(500);

    if (proc.exitCode !== null) {
      throw new Error(`relay-pty exited immediately with code ${proc.exitCode}`);
    }

    // Register for memory/CPU monitoring
    if (proc.pid) {
      this.memoryMonitor.register(this.config.name, proc.pid);
      this.memoryMonitor.start(); // Idempotent - starts if not already running

      // Set up alert handler to send resource alerts to dashboard only (not other agents)
      this.memoryAlertHandler = (alert: MemoryAlert) => {
        if (alert.agentName !== this.config.name) return;
        if (this.client.state !== 'READY') return;

        const message = alert.type === 'recovered'
          ? `AGENT RECOVERED: "${this.config.name}" memory usage returned to normal.`
          : `AGENT RESOURCE ALERT: "${this.config.name}" - ${alert.message} (${formatBytes(alert.currentRss)})`;

        this.log(` Sending resource alert to users: ${message}`);
        // Send to all human users - agents don't need to know about each other's resource usage
        this.client.sendMessage('@users', message, 'message', {
          isSystemMessage: true,
          agentName: this.config.name,
          alertType: alert.type,
          currentMemory: alert.currentRss,
          threshold: alert.threshold,
          recommendation: alert.recommendation,
        });
      };
      this.memoryMonitor.on('alert', this.memoryAlertHandler);
    }
  }

  /**
   * Handle output from relay-pty stdout (headless mode only)
   * In interactive mode, stdout goes directly to terminal via inherited stdio
   */
  private handleOutput(data: string): void {
    // Skip processing if agent is no longer running (prevents ghost messages after release)
    if (!this.running) {
      return;
    }

    this.rawBuffer += data;
    this.outputBuffer += data;
    this.hasReceivedOutput = true;

    // Feed to idle detector
    this.feedIdleDetectorOutput(data);

    // Check for unread messages and append indicator if needed
    const indicator = this.formatUnreadIndicator();
    const outputWithIndicator = indicator ? data + indicator : data;

    // Emit output event (with indicator if present)
    this.emit('output', outputWithIndicator);

    // Stream to daemon if configured
    if (this.config.streamLogs !== false && this.client.state === 'READY') {
      this.client.sendLog(outputWithIndicator);
    }

    // Parse for relay commands
    this.parseRelayCommands();

    // Check for summary and session end
    const cleanContent = stripAnsi(this.rawBuffer);
    this.checkForSummary(cleanContent);
    this.checkForSessionEnd(cleanContent);
  }

  /**
   * Format an unread message indicator if there are pending messages.
   * Returns empty string if no pending messages or within cooldown period.
   *
   * Example output:
   * ───────────────────────────
   * 📬 2 unread messages (from: Alice, Bob)
   */
  private formatUnreadIndicator(): string {
    const queueLength = this.messageQueue.length;
    if (queueLength === 0) {
      return '';
    }

    // Check cooldown to avoid spamming
    const now = Date.now();
    if (now - this.lastUnreadIndicatorTime < this.UNREAD_INDICATOR_COOLDOWN_MS) {
      return '';
    }
    this.lastUnreadIndicatorTime = now;

    // Collect unique sender names
    const senders = [...new Set(this.messageQueue.map(m => m.from))];
    const senderList = senders.slice(0, 3).join(', ');
    const moreCount = senders.length > 3 ? ` +${senders.length - 3} more` : '';

    const line = '─'.repeat(27);
    const messageWord = queueLength === 1 ? 'message' : 'messages';

    return `\n${line}\n📬 ${queueLength} unread ${messageWord} (from: ${senderList}${moreCount})\n`;
  }

  /**
   * Handle stderr from relay-pty (logs and JSON parsed commands)
   */
  private handleStderr(data: string): void {
    // Skip processing if agent is no longer running (prevents ghost messages after release)
    if (!this.running) {
      return;
    }

    // relay-pty outputs JSON parsed commands to stderr with --json-output
    const lines = data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (line.startsWith('{')) {
        // JSON output - parsed relay command from Rust
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'relay_command' && parsed.kind) {
            // Log parsed commands (only in debug mode to avoid TUI pollution)
            if (parsed.kind === 'spawn' || parsed.kind === 'release') {
              this.log(`Rust parsed [${parsed.kind}]: ${JSON.stringify({
                spawn_name: parsed.spawn_name,
                spawn_cli: parsed.spawn_cli,
                spawn_task: parsed.spawn_task?.substring(0, 50),
                release_name: parsed.release_name,
              })}`);
            } else {
              this.log(`Rust parsed [${parsed.kind}]: ${parsed.from} -> ${parsed.to}`);
            }
            this.handleRustParsedCommand(parsed);
          }
        } catch (e) {
          // Not JSON, just log (only in debug mode)
          if (this.config.debug) {
            console.error(`[relay-pty:${this.config.name}] ${line}`);
          }
        }
      } else {
        // Non-JSON stderr - only show in debug mode (logs, info messages)
        if (this.config.debug) {
          console.error(`[relay-pty:${this.config.name}] ${line}`);
        }
      }
    }
  }

  /**
   * Handle a parsed command from Rust relay-pty
   * Rust outputs structured JSON with 'kind' field: "message", "spawn", "release"
   */
  private handleRustParsedCommand(parsed: {
    type: string;
    kind: string;
    from: string;
    to: string;
    body: string;
    raw: string;
    thread?: string;
    spawn_name?: string;
    spawn_cli?: string;
    spawn_task?: string;
    release_name?: string;
  }): void {
    switch (parsed.kind) {
      case 'spawn':
        if (parsed.spawn_name && parsed.spawn_cli) {
          this.log(` Spawn detected: ${parsed.spawn_name} (${parsed.spawn_cli})`);
          this.handleSpawnCommand(parsed.spawn_name, parsed.spawn_cli, parsed.spawn_task || '');
        }
        break;

      case 'release':
        if (parsed.release_name) {
          this.log(`Release: ${parsed.release_name}`);
          this.handleReleaseCommand(parsed.release_name);
        } else {
          this.logError(`Missing release_name in parsed command: ${JSON.stringify(parsed)}`);
        }
        break;

      case 'message':
      default:
        this.sendRelayCommand({
          to: parsed.to,
          kind: 'message',
          body: parsed.body,
          thread: parsed.thread,
          raw: parsed.raw,
        });
        break;
    }
  }

  /**
   * Handle spawn command (from Rust stderr JSON parsing)
   *
   * Note: We do NOT send the initial task message here because the spawner
   * now handles it after waitUntilCliReady(). Sending it here would cause
   * duplicate task delivery.
   */
  private handleSpawnCommand(name: string, cli: string, task: string): void {
    const key = `spawn:${name}:${cli}`;
    if (this.processedSpawnCommands.has(key)) {
      this.log(`Spawn already processed: ${key}`);
      return;
    }
    this.processedSpawnCommands.add(key);

    // Log spawn attempts (only in debug mode to avoid TUI pollution)
    this.log(`SPAWN REQUEST: ${name} (${cli})`);
    this.log(`  dashboardPort=${this.config.dashboardPort}, onSpawn=${!!this.config.onSpawn}`);

    // Try dashboard API first, fall back to callback
    // The spawner will send the task after waitUntilCliReady()
    if (this.config.dashboardPort) {
      this.log(`Calling dashboard API at port ${this.config.dashboardPort}`);
      this.spawnViaDashboardApi(name, cli, task)
        .then(() => {
          this.log(`SPAWN SUCCESS: ${name} via dashboard API`);
        })
        .catch(err => {
          this.logError(`SPAWN FAILED: ${name} - ${err.message}`);
          if (this.config.onSpawn) {
            this.log(`Falling back to onSpawn callback`);
            Promise.resolve(this.config.onSpawn(name, cli, task))
              .catch(e => this.logError(`SPAWN CALLBACK FAILED: ${e.message}`));
          }
        });
    } else if (this.config.onSpawn) {
      this.log(`Using onSpawn callback directly`);
      Promise.resolve(this.config.onSpawn(name, cli, task))
        .catch(e => this.logError(`SPAWN CALLBACK FAILED: ${e.message}`));
    } else {
      this.logError(`SPAWN FAILED: No spawn mechanism available! (dashboardPort=${this.config.dashboardPort}, onSpawn=${!!this.config.onSpawn})`);
    }
  }

  /**
   * Handle release command
   */
  private handleReleaseCommand(name: string): void {
    const key = `release:${name}`;
    if (this.processedReleaseCommands.has(key)) {
      return;
    }
    this.processedReleaseCommands.add(key);

    this.log(` Release: ${name}`);

    // Try dashboard API first, fall back to callback
    if (this.config.dashboardPort) {
      this.releaseViaDashboardApi(name).catch(err => {
        this.logError(` Dashboard release failed: ${err.message}`);
        this.config.onRelease?.(name);
      });
    } else if (this.config.onRelease) {
      this.config.onRelease(name);
    }
  }

  /**
   * Spawn agent via dashboard API
   */
  private async spawnViaDashboardApi(name: string, cli: string, task: string): Promise<void> {
    const url = `http://localhost:${this.config.dashboardPort}/api/spawn`;
    const body = {
      name,
      cli,
      task,
      spawnerName: this.config.name, // Include spawner name so task appears from correct agent
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (result.success === false) {
        throw new Error(result.error || 'Spawn failed without specific error');
      }
    } catch (err: any) {
      // Enhance error with context
      if (err.code === 'ECONNREFUSED') {
        throw new Error(`Dashboard not reachable at ${url} (connection refused)`);
      }
      throw err;
    }
  }

  /**
   * Release agent via dashboard API
   */
  private async releaseViaDashboardApi(name: string): Promise<void> {
    const response = await fetch(`http://localhost:${this.config.dashboardPort}/api/spawned/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unknown' })) as { error?: string };
      throw new Error(`HTTP ${response.status}: ${body.error || 'Unknown error'}`);
    }
    this.log(`Released ${name} via dashboard API`);
  }

  // =========================================================================
  // Socket communication
  // =========================================================================

  /**
   * Connect to the relay-pty socket
   */
  private async connectToSocket(): Promise<void> {
    const timeout = this.config.socketConnectTimeoutMs ?? 5000;
    const maxAttempts = this.config.socketReconnectAttempts ?? 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.attemptSocketConnection(timeout);
        this.log(` Socket connected`);
        return;
      } catch (err: any) {
        this.logError(` Socket connect attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        if (attempt < maxAttempts) {
          await sleep(1000 * attempt); // Exponential backoff
        }
      }
    }

    throw new Error(`Failed to connect to socket after ${maxAttempts} attempts`);
  }

  /**
   * Attempt a single socket connection
   */
  private attemptSocketConnection(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Socket connection timeout'));
      }, timeout);

      this.socket = createConnection(this.socketPath, () => {
        clearTimeout(timer);
        this.socketConnected = true;
        resolve();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        this.socketConnected = false;
        reject(err);
      });

      this.socket.on('close', () => {
        this.socketConnected = false;
        this.log(` Socket closed`);
      });

      // Handle incoming data (responses)
      let buffer = '';
      this.socket.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.handleSocketResponse(line);
          }
        }
      });
    });
  }

  /**
   * Disconnect from socket
   */
  private disconnectSocket(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
      this.socketConnected = false;
    }

    // Reject all pending injections
    for (const [_id, pending] of this.pendingInjections) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Socket disconnected'));
    }
    this.pendingInjections.clear();
  }

  /**
   * Send a request to the socket and optionally wait for response
   */
  private sendSocketRequest(request: RelayPtyRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socketConnected) {
        reject(new Error('Socket not connected'));
        return;
      }

      const json = JSON.stringify(request) + '\n';
      this.socket.write(json, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Handle a response from the socket
   */
  private handleSocketResponse(line: string): void {
    try {
      const response = JSON.parse(line) as RelayPtyResponse;

      switch (response.type) {
        case 'inject_result':
          // handleInjectResult is async (does verification), but we don't await here
          // Errors are handled internally by the method
          this.handleInjectResult(response).catch((err: Error) => {
            this.logError(` Error handling inject result: ${err.message}`);
          });
          break;

        case 'status':
          // Status responses are typically requested explicitly
          this.log(` Status: idle=${response.agent_idle} queue=${response.queue_length}`);
          break;

        case 'backpressure':
          this.handleBackpressure(response);
          break;

        case 'error':
          this.logError(` Socket error: ${response.message}`);
          break;

        case 'shutdown_ack':
          this.log(` Shutdown acknowledged`);
          break;
      }
    } catch (err: any) {
      this.logError(` Failed to parse socket response: ${err.message}`);
    }
  }

  /**
   * Handle injection result response
   * After Rust reports 'delivered', verifies the message appeared in output.
   * If verification fails, retries up to MAX_RETRIES times.
   */
  private async handleInjectResult(response: InjectResultResponse): Promise<void> {
    this.log(` handleInjectResult: id=${response.id.substring(0, 8)} status=${response.status}`);

    const pending = this.pendingInjections.get(response.id);
    if (!pending) {
      // Response for unknown message - might be from a previous session
      this.log(` No pending injection found for ${response.id.substring(0, 8)}`);
      return;
    }

    if (response.status === 'delivered') {
      // Rust says it sent the message + Enter key
      // Now verify the message actually appeared in the terminal output
      this.log(` Message ${pending.shortId} marked delivered by Rust, verifying in output...`);

      // In interactive mode, we can't verify because stdout goes directly to terminal
      // Trust Rust's "delivered" status in this case
      if (this.isInteractive) {
        this.log(` Interactive mode - trusting Rust delivery status`);
        clearTimeout(pending.timeout);
        this.pendingInjections.delete(response.id);
        if (pending.retryCount === 0) {
          this.injectionMetrics.successFirstTry++;
        } else {
          this.injectionMetrics.successWithRetry++;
        }
        this.injectionMetrics.total++;
        pending.resolve(true);
        this.log(` Message ${pending.shortId} delivered (interactive mode) ✓`);
        return;
      }

      // Skip verification if queue is backing up - trust Rust's delivery status
      // relay-pty writes directly to PTY which is more reliable than tmux
      const queueBackingUp = this.messageQueue.length >= 2;
      if (queueBackingUp) {
        this.log(` Queue backing up (${this.messageQueue.length} pending), skipping verification for ${pending.shortId}`);
        clearTimeout(pending.timeout);
        this.pendingInjections.delete(response.id);
        if (pending.retryCount === 0) {
          this.injectionMetrics.successFirstTry++;
        } else {
          this.injectionMetrics.successWithRetry++;
        }
        this.injectionMetrics.total++;
        pending.resolve(true);
        return;
      }

      // Give a brief moment for output to be captured
      await sleep(100);

      // Verify the message pattern appears in captured output
      const verified = await verifyInjection(
        pending.shortId,
        pending.from,
        async () => this.getCleanOutput()
      );

      if (verified) {
        clearTimeout(pending.timeout);
        this.pendingInjections.delete(response.id);
        // Update metrics based on retry count (0 = first try)
        if (pending.retryCount === 0) {
          this.injectionMetrics.successFirstTry++;
        } else {
          this.injectionMetrics.successWithRetry++;
          this.log(` Message ${pending.shortId} succeeded on attempt ${pending.retryCount + 1}`);
        }
        this.injectionMetrics.total++;
        pending.resolve(true);
        this.log(` Message ${pending.shortId} verified in output ✓`);
      } else {
        // Message was "delivered" but not found in output
        // This is the bug case - Enter key may not have been processed
        this.log(` Message ${pending.shortId} NOT found in output after delivery`);

        // Check if we should retry
        if (pending.retryCount < INJECTION_CONSTANTS.MAX_RETRIES - 1) {
          this.log(` Retrying injection (attempt ${pending.retryCount + 2}/${INJECTION_CONSTANTS.MAX_RETRIES})`);
          clearTimeout(pending.timeout);
          this.pendingInjections.delete(response.id);

          // Wait before retry with backoff
          await sleep(INJECTION_CONSTANTS.RETRY_BACKOFF_MS * (pending.retryCount + 1));

          // IMPORTANT: Check again if message appeared (late verification / race condition fix)
          // The previous injection may have succeeded but verification timed out
          const lateVerified = await verifyInjection(
            pending.shortId,
            pending.from,
            async () => this.getCleanOutput()
          );
          if (lateVerified) {
            this.log(` Message ${pending.shortId} found on late verification, skipping retry`);
            if (pending.retryCount === 0) {
              this.injectionMetrics.successFirstTry++;
            } else {
              this.injectionMetrics.successWithRetry++;
            }
            this.injectionMetrics.total++;
            pending.resolve(true);
            return;
          }

          // Re-inject by sending another socket request
          // The original promise will be resolved when this retry completes
          // Prepend [RETRY] to help agent notice this is a retry
          const retryBody = pending.originalBody.startsWith('[RETRY]')
            ? pending.originalBody
            : `[RETRY] ${pending.originalBody}`;
          const retryRequest: InjectRequest = {
            type: 'inject',
            id: response.id,
            from: pending.from,
            body: retryBody,
            priority: 1, // Higher priority for retries
          };

          // Create new pending entry with incremented retry count
          const newTimeout = setTimeout(() => {
            this.logError(` Retry timeout for ${pending.shortId}`);
            this.pendingInjections.delete(response.id);
            pending.resolve(false);
          }, 30000);

          this.pendingInjections.set(response.id, {
            ...pending,
            timeout: newTimeout,
            retryCount: pending.retryCount + 1,
            originalBody: retryBody, // Use retry body for subsequent retries
          });

          this.sendSocketRequest(retryRequest).catch((err) => {
            this.logError(` Retry request failed: ${err.message}`);
            clearTimeout(newTimeout);
            this.pendingInjections.delete(response.id);
            pending.resolve(false);
          });
        } else {
          // Max retries exceeded
          this.logError(` Message ${pending.shortId} failed after ${INJECTION_CONSTANTS.MAX_RETRIES} attempts - NOT found in output`);
          clearTimeout(pending.timeout);
          this.pendingInjections.delete(response.id);
          this.injectionMetrics.failed++;
          this.injectionMetrics.total++;
          pending.resolve(false);
          this.emit('injection-failed', {
            messageId: response.id,
            from: pending.from,
            error: 'Message delivered but not verified in output after max retries',
          });
        }
      }
    } else if (response.status === 'failed') {
      clearTimeout(pending.timeout);
      this.pendingInjections.delete(response.id);
      this.injectionMetrics.failed++;
      this.injectionMetrics.total++;
      pending.resolve(false);
      this.logError(` Message ${pending.shortId} failed: ${response.error}`);
      this.emit('injection-failed', {
        messageId: response.id,
        from: pending.from,
        error: response.error ?? 'Unknown error',
      });
    }
    // queued/injecting are intermediate states - wait for final status
  }

  /**
   * Handle backpressure notification
   */
  private handleBackpressure(response: BackpressureResponse): void {
    const wasActive = this.backpressureActive;
    this.backpressureActive = !response.accept;

    if (this.backpressureActive !== wasActive) {
      this.log(` Backpressure: ${this.backpressureActive ? 'ACTIVE' : 'cleared'} (queue=${response.queue_length})`);
      this.emit('backpressure', { queueLength: response.queue_length, accept: response.accept });

      // Resume processing if backpressure cleared
      if (!this.backpressureActive) {
        this.processMessageQueue();
      }
    }
  }

  // =========================================================================
  // Message handling
  // =========================================================================

  /**
   * Inject a message into the agent via socket
   */
  private async injectMessage(msg: QueuedMessage, retryCount = 0): Promise<boolean> {
    const shortId = msg.messageId.substring(0, 8);
    this.log(` === INJECT START: ${shortId} from ${msg.from} (attempt ${retryCount + 1}) ===`);

    if (!this.socket || !this.socketConnected) {
      this.logError(` Cannot inject - socket not connected`);
      return false;
    }

    // Build injection content
    const content = buildInjectionString(msg);
    this.log(` Injection content (${content.length} bytes): ${content.substring(0, 100)}...`);

    // Create request
    const request: InjectRequest = {
      type: 'inject',
      id: msg.messageId,
      from: msg.from,
      body: content,
      priority: msg.importance ?? 0,
    };

    this.log(` Sending inject request to socket...`);

    // Create promise for result
    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.logError(` Inject timeout for ${shortId} after 30s`);
        this.pendingInjections.delete(msg.messageId);
        resolve(false); // Timeout = failure
      }, 30000); // 30 second timeout for injection

      this.pendingInjections.set(msg.messageId, {
        resolve,
        reject,
        timeout,
        from: msg.from,
        shortId,
        retryCount,
        originalBody: content,
      });

      // Send request
      this.sendSocketRequest(request)
        .then(() => {
          this.log(` Socket request sent for ${shortId}`);
        })
        .catch((err) => {
          this.logError(` Socket request failed for ${shortId}: ${err.message}`);
          clearTimeout(timeout);
          this.pendingInjections.delete(msg.messageId);
          resolve(false);
        });
    });
  }

  /** Maximum retries for failed injections before giving up */
  private static readonly MAX_INJECTION_RETRIES = 5;
  /** Backoff delay multiplier (ms) for retries: delay = BASE * 2^retryCount */
  private static readonly INJECTION_RETRY_BASE_MS = 2000;

  /**
   * Process queued messages
   */
  private async processMessageQueue(): Promise<void> {
    if (!this.readyForMessages || this.backpressureActive || this.isInjecting) {
      return;
    }

    if (this.messageQueue.length === 0) {
      return;
    }

    // Check if agent is in editor mode - delay injection if so
    const idleResult = this.idleDetector.checkIdle();
    if (idleResult.inEditorMode) {
      this.log(` Agent in editor mode, delaying injection (queue: ${this.messageQueue.length})`);
      // Check again in 2 seconds
      setTimeout(() => this.processMessageQueue(), 2000);
      return;
    }

    this.isInjecting = true;
    this.injectionStartTime = Date.now();

    const msg = this.messageQueue.shift()!;
    const retryCount = (msg as any)._retryCount ?? 0;
    const bodyPreview = msg.body.substring(0, 50).replace(/\n/g, '\\n');
    this.log(` Processing message from ${msg.from}: "${bodyPreview}..." (remaining=${this.messageQueue.length}, retry=${retryCount})`);

    try {
      const success = await this.injectMessage(msg);

      // Metrics are now tracked in handleInjectResult which knows about retries
      if (!success) {
        // Record failure for adaptive throttling
        this.throttle.recordFailure();

        // Re-queue with backoff if under retry limit
        if (retryCount < RelayPtyOrchestrator.MAX_INJECTION_RETRIES) {
          const backoffMs = RelayPtyOrchestrator.INJECTION_RETRY_BASE_MS * Math.pow(2, retryCount);
          this.log(` Re-queuing message ${msg.messageId.substring(0, 8)} for retry ${retryCount + 1} in ${backoffMs}ms`);
          (msg as any)._retryCount = retryCount + 1;
          // Add to front of queue for priority
          this.messageQueue.unshift(msg);
          // Wait before retrying
          this.isInjecting = false;
          setTimeout(() => this.processMessageQueue(), backoffMs);
          return;
        }

        this.logError(` Injection failed for message ${msg.messageId.substring(0, 8)} after ${retryCount} retries`);
        this.config.onInjectionFailed?.(msg.messageId, 'Injection failed after max retries');
        this.sendSyncAck(msg.messageId, msg.sync, 'ERROR', { error: 'injection_failed_max_retries' });
      } else {
        // Record success for adaptive throttling
        this.throttle.recordSuccess();
        this.sendSyncAck(msg.messageId, msg.sync, 'OK');
      }
    } catch (err: any) {
      this.logError(` Injection error: ${err.message}`);
      // Track metrics for exceptions (not handled by handleInjectResult)
      this.injectionMetrics.failed++;
      this.injectionMetrics.total++;
      // Record failure for adaptive throttling
      this.throttle.recordFailure();
      this.sendSyncAck(msg.messageId, msg.sync, 'ERROR', { error: err.message });
    } finally {
      this.isInjecting = false;
      this.injectionStartTime = 0;

      // Process next message after adaptive delay (faster when healthy, slower under stress)
      if (this.messageQueue.length > 0 && !this.backpressureActive) {
        const delay = this.throttle.getDelay();
        setTimeout(() => this.processMessageQueue(), delay);
      }
    }
  }

  /**
   * Override handleIncomingMessage to trigger queue processing
   */
  protected override handleIncomingMessage(
    from: string,
    payload: SendPayload,
    messageId: string,
    meta?: SendMeta,
    originalTo?: string
  ): void {
    this.log(` === MESSAGE RECEIVED: ${messageId.substring(0, 8)} from ${from} ===`);
    this.log(` Body preview: ${payload.body?.substring(0, 100) ?? '(no body)'}...`);
    super.handleIncomingMessage(from, payload, messageId, meta, originalTo);
    this.log(` Queue length after add: ${this.messageQueue.length}`);
    this.processMessageQueue();
  }

  // =========================================================================
  // Queue monitor - Detect and process stuck messages
  // =========================================================================

  /**
   * Start the queue monitor to periodically check for stuck messages.
   * This ensures messages don't get orphaned in the queue when the agent is idle.
   */
  private startQueueMonitor(): void {
    if (this.queueMonitorTimer) {
      return; // Already started
    }

    this.log(` Starting queue monitor (interval: ${this.QUEUE_MONITOR_INTERVAL_MS}ms)`);

    this.queueMonitorTimer = setInterval(() => {
      this.checkForStuckQueue();
    }, this.QUEUE_MONITOR_INTERVAL_MS);

    // Don't keep process alive just for queue monitoring
    this.queueMonitorTimer.unref?.();
  }

  /**
   * Stop the queue monitor.
   */
  private stopQueueMonitor(): void {
    if (this.queueMonitorTimer) {
      clearInterval(this.queueMonitorTimer);
      this.queueMonitorTimer = undefined;
      this.log(` Queue monitor stopped`);
    }
  }

  // =========================================================================
  // Protocol monitoring (detect agent mistakes like empty AGENT_RELAY_NAME)
  // =========================================================================

  /**
   * Start watching for protocol issues in the outbox directory.
   * Detects common mistakes like:
   * - Empty AGENT_RELAY_NAME causing files at outbox//
   * - Files created directly in outbox/ instead of agent subdirectory
   */
  private startProtocolMonitor(): void {
    // Get the outbox parent directory (one level up from agent's outbox)
    const parentDir = dirname(this._canonicalOutboxPath);

    // Ensure parent directory exists
    try {
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
    } catch {
      // Ignore - directory may already exist
    }

    try {
      this.protocolWatcher = watch(parentDir, (eventType, filename) => {
        if (eventType === 'rename' && filename) {
          // Check for files directly in parent (not in agent subdirectory)
          // This happens when $AGENT_RELAY_NAME is empty
          const fullPath = join(parentDir, filename);
          try {
            // If it's a file (not directory) directly in the parent, that's an issue
            if (existsSync(fullPath) && !lstatSync(fullPath).isDirectory()) {
              this.handleProtocolIssue('file_in_root', filename);
            }
            // Check for empty-named directory (double slash symptom)
            if (filename === '' || filename.startsWith('/')) {
              this.handleProtocolIssue('empty_agent_name', filename);
            }
          } catch {
            // Ignore stat errors
          }
        }
      });

      // Don't keep process alive just for protocol monitoring
      this.protocolWatcher.unref?.();
      this.log(` Protocol monitor started on ${parentDir}`);
    } catch (err: any) {
      // Don't fail start() if protocol monitoring fails
      this.logError(` Failed to start protocol monitor: ${err.message}`);
    }

    // Also do an initial scan for existing issues
    this.scanForProtocolIssues();
  }

  /**
   * Stop the protocol monitor.
   */
  private stopProtocolMonitor(): void {
    if (this.protocolWatcher) {
      this.protocolWatcher.close();
      this.protocolWatcher = undefined;
      this.log(` Protocol monitor stopped`);
    }
  }

  /**
   * Scan for existing protocol issues (called once at startup).
   */
  private scanForProtocolIssues(): void {
    const parentDir = dirname(this._canonicalOutboxPath);
    try {
      if (!existsSync(parentDir)) return;

      const entries = readdirSync(parentDir);
      for (const entry of entries) {
        const fullPath = join(parentDir, entry);
        try {
          // Check for files directly in parent (should only be directories)
          if (!lstatSync(fullPath).isDirectory()) {
            this.handleProtocolIssue('file_in_root', entry);
            break; // Only report once
          }
        } catch {
          // Ignore stat errors
        }
      }
    } catch {
      // Ignore scan errors
    }
  }

  /**
   * Handle a detected protocol issue by injecting a helpful reminder.
   */
  private handleProtocolIssue(issue: 'empty_agent_name' | 'file_in_root', filename: string): void {
    const now = Date.now();

    // Respect cooldown to avoid spamming
    if (now - this.protocolReminderCooldown < this.PROTOCOL_REMINDER_COOLDOWN_MS) {
      return;
    }
    this.protocolReminderCooldown = now;

    this.log(` Protocol issue detected: ${issue} (${filename})`);

    const reminders: Record<string, string> = {
      empty_agent_name: `⚠️ **Protocol Issue Detected**

Your \`$AGENT_RELAY_NAME\` environment variable appears to be empty or unset.
Your agent name is: **${this.config.name}**

Correct outbox path: \`$AGENT_RELAY_OUTBOX\`

When writing relay files, use:
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: TargetAgent

Your message here
EOF
\`\`\`
Then output: \`->relay-file:msg\``,

      file_in_root: `⚠️ **Protocol Issue Detected**

Found file "${filename}" directly in the outbox root instead of using the proper path.
Your agent name is: **${this.config.name}**

The \`$AGENT_RELAY_OUTBOX\` path already points to your agent's directory.
Write files directly inside it:

\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: TargetAgent

Your message here
EOF
\`\`\`
Then output: \`->relay-file:msg\``,
    };

    const reminder = reminders[issue];
    if (reminder) {
      this.injectProtocolReminder(reminder);
    }
  }

  /**
   * Inject a protocol reminder message to the agent.
   */
  private injectProtocolReminder(message: string): void {
    const queuedMsg: QueuedMessage = {
      from: 'system',
      body: message,
      messageId: `protocol-reminder-${Date.now()}`,
      importance: 2, // Higher priority
    };

    this.messageQueue.unshift(queuedMsg); // Add to front of queue
    this.log(` Queued protocol reminder (queue size: ${this.messageQueue.length})`);

    // Trigger processing if not already in progress
    if (!this.isInjecting && this.readyForMessages) {
      this.processMessageQueue();
    }
  }

  // =========================================================================
  // Periodic protocol reminders (for long sessions where agents forget protocol)
  // =========================================================================

  /**
   * Start sending periodic protocol reminders.
   * Agents in long sessions sometimes forget the relay protocol - these
   * reminders help them stay on track without user intervention.
   */
  private startPeriodicReminder(): void {
    this.sessionStartTime = Date.now();

    this.periodicReminderTimer = setInterval(() => {
      this.sendPeriodicProtocolReminder();
    }, this.PERIODIC_REMINDER_INTERVAL_MS);

    // Don't keep process alive just for reminders
    this.periodicReminderTimer.unref?.();

    const intervalMinutes = Math.round(this.PERIODIC_REMINDER_INTERVAL_MS / 60000);
    this.log(` Periodic protocol reminder started (interval: ${intervalMinutes} minutes)`);
  }

  /**
   * Stop periodic protocol reminders.
   */
  private stopPeriodicReminder(): void {
    if (this.periodicReminderTimer) {
      clearInterval(this.periodicReminderTimer);
      this.periodicReminderTimer = undefined;
      this.log(` Periodic protocol reminder stopped`);
    }
  }

  /**
   * Send a periodic protocol reminder to the agent.
   * This reminds agents about proper relay communication format after long sessions.
   */
  private sendPeriodicProtocolReminder(): void {
    // Don't send if not ready
    if (!this.running || !this.readyForMessages) {
      return;
    }

    const sessionDurationMinutes = Math.round((Date.now() - this.sessionStartTime) / 60000);

    const reminder = `📋 **Protocol Reminder** (Session: ${sessionDurationMinutes} minutes)

You are **${this.config.name}** in a multi-agent relay system. Here's how to communicate:

**Sending Messages:**
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: *

Your message here
EOF
\`\`\`
Then output: \`->relay-file:msg\`

Use \`TO: *\` to broadcast to all agents, or \`TO: AgentName\` for a specific agent.

**Spawning Agents:**
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here
EOF
\`\`\`
Then output: \`->relay-file:spawn\`

**Protocol Tips:**
- Always ACK when you receive a task: "ACK: Brief description"
- Send DONE when complete: "DONE: What was accomplished"
- Keep your lead informed of progress

📖 See **AGENTS.md** in the project root for full protocol documentation.`;

    this.log(` Sending periodic protocol reminder (session: ${sessionDurationMinutes}m)`);
    this.injectProtocolReminder(reminder);
  }

  /**
   * Check for messages stuck in the queue and process them if the agent is idle.
   *
   * This handles cases where:
   * 1. Messages arrived while the agent was busy and the retry mechanism failed
   * 2. Socket disconnection/reconnection left messages orphaned
   * 3. Injection timeouts occurred without proper queue resumption
   */
  private checkForStuckQueue(): void {
    // Skip if not ready for messages
    if (!this.readyForMessages || !this.running) {
      return;
    }

    // Skip if queue is empty
    if (this.messageQueue.length === 0) {
      return;
    }

    // Check if currently injecting
    if (this.isInjecting) {
      // Check if injection has been stuck for too long
      const stuckDuration = Date.now() - this.injectionStartTime;
      if (stuckDuration > this.MAX_INJECTION_STUCK_MS) {
        this.logError(` ⚠️ Injection stuck for ${Math.round(stuckDuration / 1000)}s - force resetting`);
        this.isInjecting = false;
        this.injectionStartTime = 0;
        // Clear any pending injections that might be stuck
        for (const [id, pending] of this.pendingInjections) {
          clearTimeout(pending.timeout);
          this.logError(` Clearing stuck pending injection: ${id.substring(0, 8)}`);
        }
        this.pendingInjections.clear();
        // Continue to process the queue below
      } else {
        return; // Still within normal injection time
      }
    }

    // Skip if backpressure is active
    if (this.backpressureActive) {
      return;
    }

    // Check if the agent is idle (high confidence)
    const idleResult = this.idleDetector.checkIdle({ minSilenceMs: 2000 });
    if (!idleResult.isIdle) {
      // Agent is still working, let it finish
      return;
    }

    // We have messages in the queue, agent is idle, not currently injecting
    // This is a stuck queue situation - trigger processing
    const senders = [...new Set(this.messageQueue.map(m => m.from))];
    this.log(` ⚠️ Queue monitor: Found ${this.messageQueue.length} stuck message(s) from [${senders.join(', ')}]`);
    this.log(` ⚠️ Agent is idle (confidence: ${(idleResult.confidence * 100).toFixed(0)}%), triggering queue processing`);

    // Process the queue
    this.processMessageQueue();
  }

  // =========================================================================
  // Output parsing
  // =========================================================================

  /**
   * Parse relay commands from output
   */
  private parseRelayCommands(): void {
    const cleanContent = stripAnsi(this.rawBuffer);

    if (cleanContent.length <= this.lastParsedLength) {
      return;
    }

    // Parse new content with lookback for fenced messages
    const lookbackStart = Math.max(0, this.lastParsedLength - 500);
    const contentToParse = cleanContent.substring(lookbackStart);

    // Parse fenced messages
    this.parseFencedMessages(contentToParse);

    // Parse single-line messages
    this.parseSingleLineMessages(contentToParse);

    // Parse spawn/release commands
    this.parseSpawnReleaseCommands(contentToParse);

    this.lastParsedLength = cleanContent.length;
  }

  /**
   * Parse fenced multi-line messages
   */
  private parseFencedMessages(content: string): void {
    const escapedPrefix = this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fencePattern = new RegExp(
      `${escapedPrefix}(\\S+)(?:\\s+\\[thread:([\\w-]+)\\])?\\s*<<<([\\s\\S]*?)>>>`,
      'g'
    );

    let match;
    while ((match = fencePattern.exec(content)) !== null) {
      const target = match[1];
      const thread = match[2];
      const body = match[3].trim();

      if (!body || target === 'spawn' || target === 'release') {
        continue;
      }

      this.sendRelayCommand({
        to: target,
        kind: 'message',
        body,
        thread,
        raw: match[0],
      });
    }
  }

  /**
   * Parse single-line messages
   */
  private parseSingleLineMessages(content: string): void {
    const lines = content.split('\n');
    const escapedPrefix = this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedPrefix}(\\S+)(?:\\s+\\[thread:([\\w-]+)\\])?\\s+(.+)$`);

    for (const line of lines) {
      // Skip fenced messages
      if (line.includes('<<<') || line.includes('>>>')) {
        continue;
      }

      const match = line.match(pattern);
      if (!match) {
        continue;
      }

      const target = match[1];
      const thread = match[2];
      const body = match[3].trim();

      if (!body || target === 'spawn' || target === 'release') {
        continue;
      }

      this.sendRelayCommand({
        to: target,
        kind: 'message',
        body,
        thread,
        raw: line,
      });
    }
  }

  // =========================================================================
  // Summary and session end detection
  // =========================================================================

  /**
   * Check for [[SUMMARY]] blocks
   */
  private checkForSummary(content: string): void {
    const result = parseSummaryWithDetails(content);
    if (!result.found || !result.valid) {
      return;
    }

    if (result.rawContent === this.lastSummaryRawContent) {
      return;
    }
    this.lastSummaryRawContent = result.rawContent ?? '';

    this.emit('summary', {
      agentName: this.config.name,
      summary: result.summary,
    });
  }

  /**
   * Check for [[SESSION_END]] blocks
   */
  private checkForSessionEnd(content: string): void {
    if (this.sessionEndProcessed) {
      return;
    }

    const sessionEnd = parseSessionEndFromOutput(content);
    if (!sessionEnd) {
      return;
    }

    this.sessionEndProcessed = true;
    this.emit('session-end', {
      agentName: this.config.name,
      marker: sessionEnd,
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Query status from relay-pty
   */
  async queryStatus(): Promise<StatusResponse | null> {
    if (!this.socket || !this.socketConnected) {
      return null;
    }

    try {
      await this.sendSocketRequest({ type: 'status' });
      // Response will come asynchronously via handleSocketResponse
      // For now, return null - could implement request/response matching
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for the CLI to be ready to receive messages.
   * This waits for:
   * 1. The CLI to produce at least one output (it has started)
   * 2. The CLI to become idle (it's ready for input)
   *
   * This is more reliable than a random sleep because it waits for
   * actual signals from the CLI rather than guessing how long it takes to start.
   *
   * @param timeoutMs Maximum time to wait (default: 30s)
   * @param pollMs Polling interval (default: 100ms)
   * @returns true if CLI is ready, false if timeout
   */
  async waitUntilCliReady(timeoutMs = 30000, pollMs = 100): Promise<boolean> {
    const startTime = Date.now();
    this.log(` Waiting for CLI to be ready (timeout: ${timeoutMs}ms)`);

    // In interactive mode, stdout is inherited (not captured), so hasReceivedOutput
    // will never be set. Trust that the process is ready if it's running.
    if (this.isInteractive) {
      this.log(` Interactive mode - trusting process is ready`);
      // Give a brief moment for the CLI to initialize its TUI.
      // 500ms is a conservative estimate based on typical CLI startup times:
      // - Claude CLI: ~200-300ms to show initial prompt
      // - Codex/Gemini: ~300-400ms
      // This delay is only used in interactive mode where we can't detect output.
      // In non-interactive mode, we poll for actual output instead.
      await sleep(500);
      return this.running;
    }

    // Phase 1: Wait for first output (CLI has started)
    while (Date.now() - startTime < timeoutMs) {
      if (this.hasReceivedOutput) {
        this.log(` CLI has started producing output`);
        break;
      }
      await sleep(pollMs);
    }

    if (!this.hasReceivedOutput) {
      this.log(` Timeout waiting for CLI to produce output`);
      return false;
    }

    // Phase 2: Wait for idle state (CLI is ready for input)
    const remainingTime = timeoutMs - (Date.now() - startTime);
    if (remainingTime <= 0) {
      return false;
    }

    const idleResult = await this.waitForIdleState(remainingTime, pollMs);
    if (idleResult.isIdle) {
      this.log(` CLI is idle and ready (confidence: ${idleResult.confidence.toFixed(2)})`);
      return true;
    }

    this.log(` Timeout waiting for CLI to become idle`);
    return false;
  }

  /**
   * Check if the CLI has produced any output yet.
   * Useful for checking if the CLI has started without blocking.
   * In interactive mode, returns true if process is running (output isn't captured).
   */
  hasCliStarted(): boolean {
    // In interactive mode, stdout isn't captured so hasReceivedOutput is never set
    if (this.isInteractive) {
      return this.running;
    }
    return this.hasReceivedOutput;
  }

  /**
   * Check if the orchestrator is ready to receive and inject messages.
   * This requires:
   * 1. relay-pty process spawned
   * 2. Socket connected to relay-pty
   * 3. running flag set
   *
   * Use this to verify the agent can actually receive injected messages,
   * not just that the CLI is running.
   */
  isReadyForMessages(): boolean {
    return this.readyForMessages && this.running && this.socketConnected;
  }

  /**
   * Wait until the orchestrator is ready to receive and inject messages.
   * This is more comprehensive than waitUntilCliReady because it ensures:
   * 1. CLI is ready (has output and is idle)
   * 2. Orchestrator is ready (socket connected, can inject)
   *
   * @param timeoutMs Maximum time to wait (default: 30s)
   * @param pollMs Polling interval (default: 100ms)
   * @returns true if ready, false if timeout
   */
  async waitUntilReadyForMessages(timeoutMs = 30000, pollMs = 100): Promise<boolean> {
    const startTime = Date.now();
    this.log(` Waiting for orchestrator to be ready for messages (timeout: ${timeoutMs}ms)`);

    // First wait for CLI to be ready (output + idle)
    const cliReady = await this.waitUntilCliReady(timeoutMs, pollMs);
    if (!cliReady) {
      this.log(` CLI not ready within timeout`);
      return false;
    }

    // Then wait for readyForMessages flag
    const remainingTime = timeoutMs - (Date.now() - startTime);
    if (remainingTime <= 0) {
      this.log(` No time remaining to wait for readyForMessages`);
      return this.isReadyForMessages();
    }

    while (Date.now() - startTime < timeoutMs) {
      if (this.isReadyForMessages()) {
        this.log(` Orchestrator is ready for messages`);
        return true;
      }
      await sleep(pollMs);
    }

    this.log(` Timeout waiting for orchestrator to be ready for messages`);
    return false;
  }

  /**
   * Get raw output buffer
   */
  getRawOutput(): string {
    return this.rawBuffer;
  }

  /**
   * Check if backpressure is active
   */
  isBackpressureActive(): boolean {
    return this.backpressureActive;
  }

  /**
   * Get the socket path
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Get the relay-pty process PID
   */
  get pid(): number | undefined {
    return this.relayPtyProcess?.pid;
  }

  /**
   * Get the log file path (not used by relay-pty, returns undefined)
   */
  get logPath(): string | undefined {
    return this._logPath;
  }

  /**
   * Kill the process forcefully
   */
  async kill(): Promise<void> {
    this.isGracefulStop = true; // Mark as intentional to prevent crash broadcast
    if (this.relayPtyProcess && !this.relayPtyProcess.killed) {
      this.relayPtyProcess.kill('SIGKILL');
    }
    this.running = false;
    this.disconnectSocket();
    this.destroyClient();
  }

  /**
   * Get output lines (for compatibility with PtyWrapper)
   * @param limit Maximum number of lines to return
   */
  getOutput(limit?: number): string[] {
    const lines = this.rawBuffer.split('\n');
    if (limit && limit > 0) {
      return lines.slice(-limit);
    }
    return lines;
  }

  /**
   * Write data directly to the process stdin
   * @param data Data to write
   */
  async write(data: string | Buffer): Promise<void> {
    if (!this.relayPtyProcess || !this.relayPtyProcess.stdin) {
      throw new Error('Process not running');
    }
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    this.relayPtyProcess.stdin.write(buffer);
  }

  /**
   * Inject a task using the socket-based injection system with verification.
   * This is the preferred method for spawned agent task delivery.
   *
   * @param task The task text to inject
   * @param from The sender name (default: "spawner")
   * @returns Promise resolving to true if injection succeeded, false otherwise
   */
  async injectTask(task: string, from = 'spawner'): Promise<boolean> {
    if (!this.socket || !this.socketConnected) {
      this.log(` Socket not connected for task injection, falling back to stdin write`);
      // Fallback to direct write if socket not available
      try {
        await this.write(task + '\n');
        return true;
      } catch (err: any) {
        this.logError(` Stdin write fallback failed: ${err.message}`);
        return false;
      }
    }

    const messageId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const shortId = messageId.substring(0, 8);

    this.log(` Injecting task via socket: ${shortId}`);

    // Create request
    const request: InjectRequest = {
      type: 'inject',
      id: messageId,
      from,
      body: task,
      priority: 0, // High priority for initial task
    };

    // Send with timeout and verification
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.logError(` Task inject timeout for ${shortId} after 30s`);
        this.pendingInjections.delete(messageId);
        resolve(false);
      }, 30000);

      this.pendingInjections.set(messageId, {
        resolve,
        reject: () => resolve(false),
        timeout,
        from,
        shortId,
        retryCount: 0,
        originalBody: task,
      });

      this.sendSocketRequest(request)
        .then(() => {
          this.log(` Task inject request sent: ${shortId}`);
        })
        .catch((err) => {
          this.logError(` Task inject socket request failed: ${err.message}`);
          clearTimeout(timeout);
          this.pendingInjections.delete(messageId);
          resolve(false);
        });
    });
  }

  /**
   * Get the agent ID (from continuity if available)
   */
  getAgentId(): string | undefined {
    return this.agentId;
  }
}
