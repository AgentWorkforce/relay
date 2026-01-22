/**
 * UniversalIdleDetector - Detect when an agent is waiting for input
 *
 * Works across all CLI tools (Claude, Codex, Gemini, Aider, etc.) by combining:
 * 1. Process state inspection via /proc/{pid}/stat (Linux, 95% confidence)
 * 2. Output silence analysis (cross-platform, 60-80% confidence)
 * 3. Natural ending detection (heuristic, 60% confidence)
 *
 * The hybrid approach ensures reliable idle detection regardless of CLI type.
 */

import fs from 'node:fs';

export interface IdleSignal {
  source: 'process_state' | 'output_silence' | 'natural_ending';
  confidence: number; // 0-1
  timestamp: number;
  details?: string;
}

export interface IdleResult {
  isIdle: boolean;
  confidence: number;
  signals: IdleSignal[];
}

export interface IdleDetectorConfig {
  /** Minimum silence duration to consider for idle (ms) */
  minSilenceMs?: number;
  /** Output buffer size limit */
  bufferLimit?: number;
  /** Confidence threshold for idle detection (0-1) */
  confidenceThreshold?: number;
}

const DEFAULT_CONFIG: Required<IdleDetectorConfig> = {
  minSilenceMs: 500,
  bufferLimit: 10000,
  confidenceThreshold: 0.7,
};

/**
 * Universal idle detector for any CLI-based agent.
 */
export class UniversalIdleDetector {
  private lastOutputTime = 0;
  private outputBuffer = '';
  private pid: number | null = null;
  private config: Required<IdleDetectorConfig>;

  constructor(config: IdleDetectorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Initialize lastOutputTime to now to avoid immediate false positives
    this.lastOutputTime = Date.now();
  }

  /**
   * Set the PID of the agent process to monitor.
   * Required for Linux process state inspection.
   */
  setPid(pid: number): void {
    this.pid = pid;
  }

  /**
   * Get the current PID being monitored.
   */
  getPid(): number | null {
    return this.pid;
  }

  /**
   * Process output chunk from the agent.
   * Call this for every output received from the agent process.
   */
  onOutput(chunk: string): void {
    this.lastOutputTime = Date.now();
    this.outputBuffer += chunk;

    // Keep buffer bounded
    if (this.outputBuffer.length > this.config.bufferLimit) {
      this.outputBuffer = this.outputBuffer.slice(-Math.floor(this.config.bufferLimit / 2));
    }
  }

  /**
   * Check if the agent process is blocked on read (waiting for input).
   * This is the most reliable signal - the OS knows when a process is waiting.
   *
   * Linux-only; returns null on other platforms.
   */
  private isProcessWaitingForInput(): { waiting: boolean; wchan?: string } | null {
    if (process.platform !== 'linux' || !this.pid) {
      return null; // Can't determine on non-Linux
    }

    try {
      // Check process state from /proc/{pid}/stat
      // State codes: R=running, S=sleeping, D=disk sleep, Z=zombie, T=stopped
      const statPath = `/proc/${this.pid}/stat`;
      const stat = fs.readFileSync(statPath, 'utf-8');
      const fields = stat.split(' ');
      const state = fields[2]; // Third field is state

      // S (sleeping) often means waiting for I/O
      if (state !== 'S') {
        return { waiting: false }; // Running or other state = not waiting
      }

      // More precise: check what the process is blocked on
      const wchanPath = `/proc/${this.pid}/wchan`;
      const wchan = fs.readFileSync(wchanPath, 'utf-8').trim();

      // Common wait channels for terminal input
      const inputWaitChannels = [
        'wait_woken',
        'poll_schedule_timeout',
        'do_select',
        'n_tty_read',
        'unix_stream_read_generic',
        'pipe_read',
        'ep_poll',  // epoll wait
        'futex_wait_queue',  // sometimes seen
      ];

      const isWaiting = inputWaitChannels.some(ch => wchan.includes(ch));
      return { waiting: isWaiting, wchan };
    } catch {
      return null; // Process may have exited or permission denied
    }
  }

  /**
   * Get milliseconds since last output.
   */
  private getOutputSilenceMs(): number {
    return Date.now() - this.lastOutputTime;
  }

  /**
   * Check if the last output ends "naturally" (complete thought vs mid-sentence).
   * Helps distinguish between pauses in output and waiting for input.
   */
  private hasNaturalEnding(): boolean {
    const lastChars = this.outputBuffer.slice(-100).trim();
    if (lastChars.length === 0) return true;

    // Positive signals: output ended cleanly
    const naturalEndings = [
      /[.!?]\s*$/,           // Sentence ended
      /```\s*$/,             // Code block closed
      /\n\n$/,               // Paragraph break
      />\s*$/,               // Prompt character
      /\$\s*$/,              // Shell prompt
      />>>\s*$/,             // Python/Aider prompt
      /❯\s*$/,               // Fancy prompts
      /λ\s*$/,               // Lambda prompts
      /→\s*$/,               // Arrow prompts
    ];

    // Negative signals: output mid-thought
    const midThought = [
      /[,;:]\s*$/,           // Comma, semicolon = more coming
      /\w$/,                 // Ended mid-word (no trailing space)
      /[-–—]\s*$/,           // Dash = continuation
      /\(\s*$/,              // Open paren
      /\[\s*$/,              // Open bracket
      /\{\s*$/,              // Open brace
      /\\\s*$/,              // Line continuation
    ];

    for (const pattern of midThought) {
      if (pattern.test(lastChars)) {
        return false;
      }
    }

    for (const pattern of naturalEndings) {
      if (pattern.test(lastChars)) {
        return true;
      }
    }

    // Default: assume natural if no negative signals and some silence
    return true;
  }

  /**
   * Determine if the agent is idle and ready for input.
   * Combines multiple signals for reliability across all CLI types.
   */
  checkIdle(options: { minSilenceMs?: number } = {}): IdleResult {
    const minSilence = options.minSilenceMs ?? this.config.minSilenceMs;
    const signals: IdleSignal[] = [];

    // Signal 1: Process state (most reliable on Linux)
    const processState = this.isProcessWaitingForInput();
    if (processState !== null) {
      if (processState.waiting) {
        signals.push({
          source: 'process_state',
          confidence: 0.95, // Very high - OS-level truth
          timestamp: Date.now(),
          details: processState.wchan,
        });
      } else {
        // Process is actively running - definitely not idle
        return {
          isIdle: false,
          confidence: 0.95,
          signals: [{
            source: 'process_state',
            confidence: 0.95,
            timestamp: Date.now(),
            details: 'process running',
          }],
        };
      }
    }
    // processState === null means we can't determine (non-Linux)

    // Signal 2: Output silence
    const silenceMs = this.getOutputSilenceMs();
    if (silenceMs > minSilence) {
      // Confidence scales with silence duration (up to 0.8)
      // 500ms = 0.13, 1000ms = 0.27, 2000ms = 0.53, 3000ms = 0.8
      const silenceConfidence = Math.min(silenceMs / 3000, 0.8);
      signals.push({
        source: 'output_silence',
        confidence: silenceConfidence,
        timestamp: Date.now(),
        details: `${silenceMs}ms`,
      });
    }

    // Signal 3: Natural ending (only if some silence)
    if (silenceMs > 200 && this.hasNaturalEnding()) {
      signals.push({
        source: 'natural_ending',
        confidence: 0.6,
        timestamp: Date.now(),
      });
    }

    // No signals = not idle
    if (signals.length === 0) {
      return { isIdle: false, confidence: 0, signals: [] };
    }

    // Combine signals
    // Use max confidence, boosted if multiple signals agree
    const maxConfidence = Math.max(...signals.map(s => s.confidence));
    const boost = signals.length > 1 ? 0.1 : 0;
    const combinedConfidence = Math.min(maxConfidence + boost, 1.0);

    return {
      isIdle: combinedConfidence >= this.config.confidenceThreshold,
      confidence: combinedConfidence,
      signals,
    };
  }

  /**
   * Wait for idle state with timeout.
   * Returns the idle result when achieved or after timeout.
   */
  async waitForIdle(timeoutMs = 30000, pollMs = 200): Promise<IdleResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = this.checkIdle();
      if (result.isIdle) {
        return result;
      }
      await new Promise(r => setTimeout(r, pollMs));
    }

    // Timeout - return current state
    return this.checkIdle();
  }

  /**
   * Reset state (call when agent starts new response).
   */
  reset(): void {
    this.outputBuffer = '';
    this.lastOutputTime = Date.now();
  }

  /**
   * Get time since last output in milliseconds.
   */
  getTimeSinceLastOutput(): number {
    return this.getOutputSilenceMs();
  }
}

/**
 * Get the PID of a process running in a tmux pane.
 * Uses tmux list-panes with format specifier.
 */
export async function getTmuxPanePid(
  tmuxPath: string,
  sessionName: string
): Promise<number | null> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    // Get the PID of the command running in the pane
    const { stdout } = await execAsync(
      `"${tmuxPath}" list-panes -t ${sessionName} -F "#{pane_pid}" 2>/dev/null`
    );
    const pid = parseInt(stdout.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Create an idle detector configured for the current platform.
 * Logs a warning on non-Linux platforms where process state inspection isn't available.
 */
export function createIdleDetector(
  config: IdleDetectorConfig = {},
  options: { quiet?: boolean } = {}
): UniversalIdleDetector {
  const detector = new UniversalIdleDetector(config);

  if (!options.quiet) {
    if (process.platform === 'darwin') {
      console.warn('[idle-detector] macOS: using output analysis only (less reliable)');
    } else if (process.platform === 'win32') {
      console.warn('[idle-detector] Windows: using output analysis only (less reliable)');
    }
  }

  return detector;
}
