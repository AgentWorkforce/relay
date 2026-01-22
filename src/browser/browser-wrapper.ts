/**
 * BrowserWrapper - Wraps the Python browser-use agent for relay integration
 *
 * This wrapper:
 * 1. Spawns the Python browser agent process
 * 2. Connects to the relay daemon as a client
 * 3. Forwards messages to/from the Python process
 * 4. Handles process lifecycle and reconnection
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayClient } from '../wrapper/client.js';
import type { SendPayload, SendMeta } from '../protocol/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BrowserWrapperConfig {
  /** Agent name (default: Browser) */
  name?: string;
  /** Python executable path */
  pythonPath?: string;
  /** LLM model to use (default: gpt-4o) */
  model?: string;
  /** Run browser headless (default: true) */
  headless?: boolean;
  /** Task timeout in seconds (default: 300) */
  timeout?: number;
  /** Relay daemon socket path */
  socketPath?: string;
  /** Working directory */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

export class BrowserWrapper extends EventEmitter {
  private config: Required<BrowserWrapperConfig>;
  private process: ChildProcess | null = null;
  private client: RelayClient | null = null;
  private running = false;
  private outputBuffer = '';

  constructor(config: BrowserWrapperConfig = {}) {
    super();

    this.config = {
      name: config.name ?? 'Browser',
      pythonPath: config.pythonPath ?? 'python3',
      model: config.model ?? process.env.BROWSER_USE_MODEL ?? 'gpt-4o',
      headless: config.headless ?? (process.env.BROWSER_USE_HEADLESS !== 'false'),
      timeout: config.timeout ?? parseInt(process.env.BROWSER_USE_TIMEOUT ?? '300', 10),
      socketPath: config.socketPath ?? '',
      cwd: config.cwd ?? process.cwd(),
      env: config.env ?? {},
    };
  }

  /**
   * Start the browser wrapper
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('BrowserWrapper is already running');
    }

    // Connect to relay daemon
    this.client = new RelayClient({
      agentName: this.config.name,
      socketPath: this.config.socketPath || undefined,
      cli: 'browser-use',
      task: 'Browser automation agent powered by browser-use',
      quiet: true,
    });

    // Handle incoming messages using callback
    this.client.onMessage = (from: string, payload: SendPayload, messageId: string, meta?: SendMeta) => {
      this.handleRelayMessage(from, payload, messageId, meta);
    };

    await this.client.connect();
    console.error(`[${this.config.name}] Connected to relay daemon`);

    // Spawn Python browser agent
    await this.spawnPythonAgent();

    this.running = true;
    this.emit('ready');
  }

  /**
   * Stop the browser wrapper
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }

    this.emit('stopped');
  }

  /**
   * Spawn the Python browser agent process
   */
  private async spawnPythonAgent(): Promise<void> {
    const scriptPath = path.resolve(__dirname, 'python', 'browser_agent.py');

    const args = [
      scriptPath,
      '--name', this.config.name,
      '--model', this.config.model,
      '--timeout', this.config.timeout.toString(),
    ];

    if (this.config.headless) {
      args.push('--headless');
    }

    const env = {
      ...process.env,
      ...this.config.env,
      AGENT_RELAY_NAME: this.config.name,
    };

    this.process = spawn(this.config.pythonPath, args, {
      cwd: this.config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout - look for relay triggers
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.outputBuffer += text;

      // Process complete lines
      const lines = this.outputBuffer.split('\n');
      this.outputBuffer = lines.pop() ?? '';

      for (const line of lines) {
        this.handlePythonOutput(line);
      }
    });

    // Handle stderr - log it
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[${this.config.name}] ${text}`);
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.error(`[${this.config.name}] Python process exited (code: ${code}, signal: ${signal})`);
      this.emit('process-exit', { code, signal });

      // Attempt restart if still running
      if (this.running) {
        console.error(`[${this.config.name}] Restarting Python process...`);
        setTimeout(() => this.spawnPythonAgent(), 1000);
      }
    });

    this.process.on('error', (err) => {
      console.error(`[${this.config.name}] Process error: ${err.message}`);
      this.emit('error', err);
    });

    console.error(`[${this.config.name}] Python browser agent started (pid: ${this.process.pid})`);
  }

  /**
   * Handle output from the Python agent
   */
  private handlePythonOutput(line: string): void {
    // Check for relay file triggers
    if (line.startsWith('->relay-file:')) {
      const filename = line.substring('->relay-file:'.length).trim();
      this.handleRelayFileTrigger(filename);
    }
  }

  /**
   * Handle relay file trigger from Python
   */
  private async handleRelayFileTrigger(filename: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');

    const outboxDir = path.join(os.tmpdir(), 'relay-outbox', this.config.name);
    const filePath = path.join(outboxDir, filename);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.sendRelayMessage(content);
      // Clean up the file
      await fs.unlink(filePath);
    } catch (err) {
      console.error(`[${this.config.name}] Failed to read relay file: ${err}`);
    }
  }

  /**
   * Send a message via the relay client
   */
  private sendRelayMessage(content: string): void {
    if (!this.client) {
      console.error(`[${this.config.name}] Cannot send - not connected`);
      return;
    }

    // Parse the message content
    const lines = content.split('\n');
    let to = '';
    let thread = '';
    let bodyStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('TO: ')) {
        to = line.substring(4).trim();
      } else if (line.startsWith('THREAD: ')) {
        thread = line.substring(8).trim();
      } else if (line === '') {
        bodyStart = i + 1;
        break;
      } else {
        bodyStart = i;
        break;
      }
    }

    const body = lines.slice(bodyStart).join('\n').trim();

    if (!to) {
      console.error(`[${this.config.name}] Message missing TO field`);
      return;
    }

    try {
      if (to === '*') {
        this.client.broadcast(body);
      } else {
        this.client.sendMessage(to, body, 'message', undefined, thread || undefined);
      }
    } catch (err) {
      console.error(`[${this.config.name}] Failed to send message: ${err}`);
    }
  }

  /**
   * Handle incoming relay message
   */
  private handleRelayMessage(from: string, payload: SendPayload, messageId: string, _meta?: SendMeta): void {
    if (!this.process?.stdin) {
      console.error(`[${this.config.name}] Cannot forward message - process not running`);
      return;
    }

    const thread = payload.thread ?? '';
    const body = payload.body;

    // Format message for Python agent
    const message = `Relay message from ${from} [${messageId}]${thread ? ` [thread:${thread}]` : ''}: ${body}\n`;

    try {
      this.process.stdin.write(message);
    } catch (err) {
      console.error(`[${this.config.name}] Failed to forward message: ${err}`);
    }
  }

  /**
   * Send a task directly (programmatic API)
   */
  async sendTask(task: string): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error('Browser agent not running');
    }

    this.process.stdin.write(`FROM: API\n\n${task}\n\n`);
  }

  /**
   * Check if browser-use is available
   */
  static async checkDependencies(pythonPath = 'python3'): Promise<{
    available: boolean;
    pythonVersion?: string;
    browserUseVersion?: string;
    error?: string;
  }> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    try {
      // Check Python version
      const { stdout: pythonVersion } = await execAsync(`${pythonPath} --version`);

      // Check browser-use installation
      const checkScript = `
import sys
try:
    import browser_use
    print(f"browser_use:{browser_use.__version__ if hasattr(browser_use, '__version__') else 'installed'}")
except ImportError:
    print("browser_use:not_installed")
    sys.exit(1)
`;
      const { stdout: browserUseCheck } = await execAsync(
        `${pythonPath} -c "${checkScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`
      );

      const browserUseVersion = browserUseCheck.includes(':')
        ? browserUseCheck.split(':')[1].trim()
        : undefined;

      if (browserUseCheck.includes('not_installed')) {
        return {
          available: false,
          pythonVersion: pythonVersion.trim(),
          error: 'browser-use is not installed. Run: pip install browser-use',
        };
      }

      return {
        available: true,
        pythonVersion: pythonVersion.trim(),
        browserUseVersion,
      };
    } catch (err) {
      return {
        available: false,
        error: `Failed to check dependencies: ${err}`,
      };
    }
  }
}

export default BrowserWrapper;
