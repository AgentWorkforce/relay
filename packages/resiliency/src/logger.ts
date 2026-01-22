/**
 * Structured Logger
 *
 * Provides consistent, structured logging across agent-relay components.
 * - JSON format for machine parsing
 * - Log levels with filtering
 * - Context propagation (correlation IDs, agent names)
 * - File rotation support
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  correlationId?: string;
  agentName?: string;
  pid?: number;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

export interface LoggerConfig {
  level: LogLevel;
  json: boolean; // Output as JSON
  file?: string; // Log file path
  maxFileSize?: number; // Max file size in bytes before rotation
  maxFiles?: number; // Max number of rotated files to keep
  console: boolean; // Log to console
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
};

const RESET = '\x1b[0m';

const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  json: process.env.NODE_ENV === 'production',
  console: true,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
};

export class Logger extends EventEmitter {
  private config: LoggerConfig;
  private component: string;
  private context: Record<string, unknown> = {};
  private fileStream?: fs.WriteStream;
  private currentFileSize = 0;

  constructor(component: string, config: Partial<LoggerConfig> = {}) {
    super();
    this.component = component;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.file) {
      this.initFileStream();
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): Logger {
    const child = new Logger(this.component, this.config);
    child.context = { ...this.context, ...context };
    return child;
  }

  /**
   * Set context that will be included in all log entries
   */
  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Log at debug level
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  /**
   * Log at info level
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  /**
   * Log at warn level
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  /**
   * Log at error level
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  /**
   * Log at fatal level
   */
  fatal(message: string, context?: Record<string, unknown>): void {
    this.log('fatal', message, context);
  }

  /**
   * Log with timing (returns function to end timing)
   */
  time(message: string, context?: Record<string, unknown>): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.info(message, { ...context, duration });
    };
  }

  /**
   * Log an error with stack trace
   */
  logError(error: Error, message?: string, context?: Record<string, unknown>): void {
    this.log('error', message || error.message, {
      ...context,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
  }

  /**
   * Core log method
   */
  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...this.context,
      ...context,
    };

    // Emit for external handlers
    this.emit('log', entry);

    // Console output
    if (this.config.console) {
      this.writeConsole(entry);
    }

    // File output
    if (this.fileStream) {
      this.writeFile(entry);
    }
  }

  /**
   * Write to console
   */
  private writeConsole(entry: LogEntry): void {
    if (this.config.json) {
      console.log(JSON.stringify(entry));
    } else {
      const color = LEVEL_COLORS[entry.level];
      const levelStr = entry.level.toUpperCase().padEnd(5);
      const componentStr = `[${entry.component}]`.padEnd(20);

      let line = `${entry.timestamp} ${color}${levelStr}${RESET} ${componentStr} ${entry.message}`;

      // Add context fields (exclude standard log entry fields)
      const { timestamp: _t, level: _l, component: _c, message: _m, ...contextFields } = entry;

      if (Object.keys(contextFields).length > 0) {
        line += ` ${JSON.stringify(contextFields)}`;
      }

      console.log(line);
    }
  }

  /**
   * Write to file with rotation
   */
  private writeFile(entry: LogEntry): void {
    if (!this.fileStream) return;

    const line = JSON.stringify(entry) + '\n';
    const lineBytes = Buffer.byteLength(line);

    // Check if rotation needed
    if (
      this.config.maxFileSize &&
      this.currentFileSize + lineBytes > this.config.maxFileSize
    ) {
      this.rotateFile();
    }

    this.fileStream.write(line);
    this.currentFileSize += lineBytes;
  }

  /**
   * Initialize file stream
   */
  private initFileStream(): void {
    if (!this.config.file) return;

    const dir = path.dirname(this.config.file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Get current file size
    if (fs.existsSync(this.config.file)) {
      const stats = fs.statSync(this.config.file);
      this.currentFileSize = stats.size;
    }

    this.fileStream = fs.createWriteStream(this.config.file, { flags: 'a' });
  }

  /**
   * Rotate log file
   */
  private rotateFile(): void {
    if (!this.config.file || !this.fileStream) return;

    this.fileStream.end();

    // Rotate existing files
    for (let i = (this.config.maxFiles || 5) - 1; i >= 1; i--) {
      const oldPath = `${this.config.file}.${i}`;
      const newPath = `${this.config.file}.${i + 1}`;

      if (fs.existsSync(oldPath)) {
        if (i === (this.config.maxFiles || 5) - 1) {
          fs.unlinkSync(oldPath); // Delete oldest
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    // Rename current to .1
    if (fs.existsSync(this.config.file)) {
      fs.renameSync(this.config.file, `${this.config.file}.1`);
    }

    // Create new stream
    this.currentFileSize = 0;
    this.fileStream = fs.createWriteStream(this.config.file, { flags: 'a' });
  }

  /**
   * Close the logger
   */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = undefined;
    }
  }
}

// Logger factory with global configuration
let globalConfig: Partial<LoggerConfig> = {};

export function configure(config: Partial<LoggerConfig>): void {
  globalConfig = config;
}

export function createLogger(component: string, config?: Partial<LoggerConfig>): Logger {
  return new Logger(component, { ...globalConfig, ...config });
}

// Pre-configured loggers for common components
export const loggers = {
  daemon: () => createLogger('daemon'),
  spawner: () => createLogger('spawner'),
  router: () => createLogger('router'),
  agent: (name: string) => createLogger('agent').child({ agentName: name }),
  health: () => createLogger('health-monitor'),
  connection: (id: string) => createLogger('connection').child({ connectionId: id }),
};
