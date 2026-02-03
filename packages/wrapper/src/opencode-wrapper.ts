/**
 * OpenCodeWrapper - Wrapper for opencode CLI with HTTP API support
 *
 * This wrapper supports two modes of message injection:
 * 1. HTTP API mode: Uses opencode serve's /tui/append-prompt endpoint
 * 2. PTY fallback: Falls back to PTY-based injection when HTTP is unavailable
 *
 * The wrapper automatically detects which mode to use based on:
 * - Whether `opencode serve` is running (checks localhost:4096)
 * - Configuration options (httpApi.enabled, httpApi.fallbackToPty)
 *
 * Usage with HTTP API:
 * ```
 * const wrapper = new OpenCodeWrapper({
 *   name: 'MyAgent',
 *   command: 'opencode',
 *   httpApi: {
 *     enabled: true,
 *     baseUrl: 'http://localhost:4096',
 *   }
 * });
 * await wrapper.start();
 * ```
 *
 * @see https://github.com/anomalyco/opencode
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { BaseWrapper, type BaseWrapperConfig } from './base-wrapper.js';
import { OpenCodeApi, type OpenCodeApiConfig } from './opencode-api.js';
import { OutputParser, type ParsedCommand } from './parser.js';
import { buildInjectionString, sleep, type QueuedMessage } from './shared.js';

/**
 * Task injection retry configuration.
 * Matches RelayPtyOrchestrator for consistent behavior across wrapper types.
 */
const TASK_INJECTION = {
  /** Maximum retries when injection fails */
  MAX_RETRIES: 3,
  /** Delay between retries (ms) */
  RETRY_DELAY_MS: 500,
};

export interface OpenCodeWrapperConfig extends BaseWrapperConfig {
  /** HTTP API configuration */
  httpApi?: OpenCodeApiConfig & {
    /** Enable HTTP API mode (default: true when wrapping opencode) */
    enabled?: boolean;
    /** Fall back to PTY injection if HTTP is unavailable (default: true) */
    fallbackToPty?: boolean;
    /** Auto-start opencode serve if not running (default: false) */
    autoStartServe?: boolean;
    /** Wait for serve to be available in milliseconds (default: 5000) */
    waitForServeMs?: number;
  };
}

/**
 * Wrapper for opencode CLI with HTTP API support
 */
export class OpenCodeWrapper extends BaseWrapper {
  protected override config: OpenCodeWrapperConfig;

  // OpenCode API client
  private api: OpenCodeApi;
  private httpApiAvailable = false;

  // Process management (for PTY fallback mode)
  private process?: ChildProcess;
  private outputBuffer = '';

  // Output parser for relay commands
  private parser: OutputParser;

  // Serve process (if auto-started)
  private serveProcess?: ChildProcess;

  constructor(config: OpenCodeWrapperConfig) {
    // Default to opencode CLI type
    super({ ...config, cliType: config.cliType ?? 'opencode' });
    this.config = config;

    // Initialize API client
    this.api = new OpenCodeApi({
      baseUrl: config.httpApi?.baseUrl,
      password: config.httpApi?.password,
      timeout: config.httpApi?.timeout,
    });

    // Initialize parser with relay prefix
    this.parser = new OutputParser({
      prefix: this.relayPrefix,
    });
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    if (this.running) return;

    // Try to use HTTP API mode first (if enabled)
    if (this.config.httpApi?.enabled !== false) {
      // Check if opencode serve is available
      this.httpApiAvailable = await this.api.isAvailable();

      if (!this.httpApiAvailable && this.config.httpApi?.autoStartServe) {
        // Auto-start opencode serve
        await this.startServe();
        this.httpApiAvailable = await this.api.waitForAvailable(
          this.config.httpApi?.waitForServeMs ?? 5000
        );
      }

      if (this.httpApiAvailable) {
        console.log('[OpenCodeWrapper] Using HTTP API mode');
        await this.startHttpMode();
        return;
      }

      // Check if we should fall back to PTY
      if (this.config.httpApi?.fallbackToPty === false) {
        throw new Error(
          'OpenCode serve is not available and fallbackToPty is disabled. ' +
            'Start opencode serve or enable fallbackToPty.'
        );
      }

      console.log('[OpenCodeWrapper] HTTP API unavailable, falling back to PTY mode');
    }

    // Fall back to PTY mode
    await this.startPtyMode();
  }

  async stop(): Promise<void> {
    this.running = false;

    // Disconnect from relay daemon
    this.client.disconnect();

    // Stop the main process
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }

    // Stop the serve process if we started it
    if (this.serveProcess) {
      this.serveProcess.kill();
      this.serveProcess = undefined;
    }
  }

  // =========================================================================
  // HTTP API Mode
  // =========================================================================

  /**
   * Start in HTTP API mode
   * In this mode, we don't spawn opencode ourselves - we communicate via HTTP API
   */
  private async startHttpMode(): Promise<void> {
    this.running = true;

    // Connect to relay daemon
    await this.client.connect();

    // Subscribe to opencode events for output parsing
    this.subscribeToEvents();

    // Show a toast to indicate relay is connected
    await this.api.showToast('Agent Relay connected', { variant: 'success', duration: 2000 });
  }

  /**
   * Subscribe to opencode SSE events for output parsing
   */
  private subscribeToEvents(): void {
    this.api.subscribeToEvents(
      event => {
        // Parse events for relay commands
        if (event.type === 'message' || event.type === 'assistant_message') {
          const content = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
          this.handleOutput(content);
        }
      },
      error => {
        console.error('[OpenCodeWrapper] SSE error:', error.message);
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (this.running && this.httpApiAvailable) {
            this.subscribeToEvents();
          }
        }, 5000);
      }
    );
  }

  // =========================================================================
  // PTY Fallback Mode
  // =========================================================================

  /**
   * Start in PTY mode (fallback when HTTP is unavailable)
   */
  private async startPtyMode(): Promise<void> {
    this.running = true;

    // Connect to relay daemon
    await this.client.connect();

    // Spawn opencode process
    const args = this.config.args ?? [];
    this.process = spawn(this.config.command, args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.outputBuffer += text;
      this.handleOutput(text);
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.outputBuffer += text;
    });

    // Handle exit
    this.process.on('exit', (code, signal) => {
      this.running = false;
      this.emit('exit', code, signal);
    });
  }

  // =========================================================================
  // Output Handling
  // =========================================================================

  /**
   * Handle output from opencode (either via SSE or PTY)
   */
  private handleOutput(text: string): void {
    // Feed to idle detector
    this.idleDetector.onOutput(text);

    // Feed to stuck detector
    this.stuckDetector.onOutput(text);

    // Parse for relay commands
    const result = this.parser.parse(text);
    for (const cmd of result.commands) {
      this.handleParsedCommand(cmd);
    }
  }

  /**
   * Handle a parsed relay command
   */
  private handleParsedCommand(cmd: ParsedCommand): void {
    // Send message via relay client
    this.client.sendMessage(
      cmd.to,
      cmd.body,
      cmd.kind,
      cmd.data,
      cmd.thread
    );
  }

  // =========================================================================
  // Message Injection
  // =========================================================================

  protected async performInjection(content: string): Promise<void> {
    if (this.httpApiAvailable) {
      await this.performHttpInjection(content);
    } else {
      await this.performPtyInjection(content);
    }
  }

  /**
   * Inject content via HTTP API
   */
  private async performHttpInjection(content: string): Promise<void> {
    const result = await this.api.appendPrompt(content);
    if (!result.success) {
      throw new Error(`HTTP injection failed: ${result.error}`);
    }
  }

  /**
   * Inject content via PTY stdin
   */
  private async performPtyInjection(content: string): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error('PTY stdin not available');
    }

    // Write to stdin
    this.process.stdin.write(content + '\n');
  }

  protected getCleanOutput(): string {
    return this.outputBuffer;
  }

  // =========================================================================
  // Serve Process Management
  // =========================================================================

  /**
   * Auto-start opencode serve
   */
  private async startServe(): Promise<void> {
    console.log('[OpenCodeWrapper] Auto-starting opencode serve...');

    this.serveProcess = spawn('opencode', ['serve'], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: 'ignore',
      detached: true,
    });

    // Don't wait for serve process - it runs in background
    this.serveProcess.unref();
  }

  // =========================================================================
  // Message Queue Processing (override for HTTP mode optimization)
  // =========================================================================

  /**
   * Process the message queue
   * Override to use HTTP API's direct injection when available
   */
  protected async processMessageQueue(): Promise<void> {
    if (this.isInjecting || this.messageQueue.length === 0) {
      return;
    }

    // Check if we should wait for idle (only in PTY mode)
    if (!this.httpApiAvailable) {
      const idleResult = this.idleDetector.checkIdle();
      if (!idleResult.isIdle) {
        // In PTY mode, wait for idle before injection
        return;
      }
    }

    this.isInjecting = true;

    try {
      // Sort by importance (higher first) and process
      const sortedQueue = [...this.messageQueue].sort(
        (a, b) => (b.importance ?? 0) - (a.importance ?? 0)
      );

      for (const msg of sortedQueue) {
        const injectionString = buildInjectionString(msg);
        await this.performInjection(injectionString);

        // Remove from queue
        const index = this.messageQueue.indexOf(msg);
        if (index !== -1) {
          this.messageQueue.splice(index, 1);
        }

        // Update metrics
        this.injectionMetrics.successFirstTry++;
        this.injectionMetrics.total++;
      }
    } catch (error) {
      this.injectionMetrics.failed++;
      this.injectionMetrics.total++;
      console.error('[OpenCodeWrapper] Injection error:', error);
    } finally {
      this.isInjecting = false;
    }
  }

  // =========================================================================
  // Spawner Compatibility Methods
  // =========================================================================

  /**
   * Get the process ID (undefined in HTTP mode, defined in PTY mode)
   */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Log path (not applicable for OpenCodeWrapper)
   */
  get logPath(): string | undefined {
    return undefined;
  }

  /**
   * Kill the wrapper (alias for stop())
   */
  async kill(): Promise<void> {
    await this.stop();
  }

  /**
   * Write to the process stdin (PTY mode only)
   */
  write(data: string): void {
    if (this.process?.stdin) {
      this.process.stdin.write(data);
    }
  }

  /**
   * Inject a task into the agent with retry logic.
   *
   * Retries on transient failures to match RelayPtyOrchestrator behavior.
   * This ensures consistent reliability across all wrapper types.
   *
   * @param task - The task description to inject
   * @param _from - The sender name (used for formatting)
   * @returns true if injection succeeded, false otherwise
   */
  async injectTask(task: string, _from?: string): Promise<boolean> {
    const { MAX_RETRIES, RETRY_DELAY_MS } = TASK_INJECTION;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[OpenCodeWrapper] Retry ${attempt}/${MAX_RETRIES} - waiting ${RETRY_DELAY_MS}ms before retry`);
        await sleep(RETRY_DELAY_MS);
      }

      try {
        await this.performInjection(task);
        console.log(`[OpenCodeWrapper] Task delivered successfully${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
        return true;
      } catch (error) {
        console.error(`[OpenCodeWrapper] Task delivery failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, error);
        // Continue to next retry attempt
      }
    }

    console.error(`[OpenCodeWrapper] Task injection failed after ${MAX_RETRIES + 1} attempts`);
    return false;
  }

  /**
   * Get output lines (for compatibility with spawner)
   */
  getOutput(limit?: number): string[] {
    const lines = this.outputBuffer.split('\n');
    return limit ? lines.slice(-limit) : lines;
  }

  /**
   * Get raw output (for compatibility with spawner)
   */
  getRawOutput(): string {
    return this.outputBuffer;
  }

  /**
   * Wait until the wrapper is ready to receive messages
   * In HTTP mode, this checks if the API is available
   * In PTY mode, this waits for the process to start
   */
  async waitUntilReadyForMessages(timeoutMs = 15000, _pollMs = 100): Promise<boolean> {
    if (!this.running) {
      return false;
    }

    if (this.httpApiAvailable) {
      // HTTP mode: check if API responds
      return await this.api.waitForAvailable(timeoutMs);
    }

    // PTY mode: process is ready if stdin is available
    return this.process?.stdin !== null;
  }

  /**
   * Wait until CLI is ready (alias for waitUntilReadyForMessages)
   */
  async waitUntilCliReady(timeoutMs = 15000, pollMs = 100): Promise<boolean> {
    return this.waitUntilReadyForMessages(timeoutMs, pollMs);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Check if HTTP API mode is active
   */
  get isHttpApiMode(): boolean {
    return this.httpApiAvailable;
  }

  /**
   * Get the OpenCode API client for advanced operations
   */
  get openCodeApi(): OpenCodeApi {
    return this.api;
  }

  /**
   * Switch to a specific session
   */
  async switchSession(sessionId: string): Promise<boolean> {
    if (!this.httpApiAvailable) {
      console.warn('[OpenCodeWrapper] Cannot switch sessions in PTY mode');
      return false;
    }

    const result = await this.api.selectSession(sessionId);
    return result.success;
  }

  /**
   * List available sessions
   */
  async listSessions(): Promise<{ id: string; title?: string }[]> {
    if (!this.httpApiAvailable) {
      console.warn('[OpenCodeWrapper] Cannot list sessions in PTY mode');
      return [];
    }

    const result = await this.api.listSessions();
    return result.data ?? [];
  }
}
