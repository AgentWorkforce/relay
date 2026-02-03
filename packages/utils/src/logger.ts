/**
 * Lightweight DIY Logger for Agent Relay
 *
 * Minimal logging utility (~50 lines) with:
 * - JSON output for easy parsing with jq
 * - Configurable via environment variables
 * - Debug-only verbose logging
 * - No external dependencies
 */

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  [key: string]: unknown;
}

// Configuration getters - read env at runtime to allow late binding
// (CLI sets AGENT_RELAY_LOG_FILE after imports complete)
function getLogFile(): string | undefined {
  return process.env.AGENT_RELAY_LOG_FILE;
}

function getLogLevel(): LogLevel {
  return (process.env.AGENT_RELAY_LOG_LEVEL ?? 'INFO').toUpperCase() as LogLevel;
}

function isLogJson(): boolean {
  return process.env.AGENT_RELAY_LOG_JSON === '1';
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Track which log directories we've already created
const createdLogDirs = new Set<string>();

function ensureLogDir(logFile: string): void {
  const logDir = path.dirname(logFile);
  if (!createdLogDirs.has(logDir) && !fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    createdLogDirs.add(logDir);
  }
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getLogLevel()];
}

function formatMessage(entry: LogEntry): string {
  if (isLogJson()) {
    return JSON.stringify(entry);
  }
  const { ts, level, component, msg, ...extra } = entry;
  const extraStr = Object.keys(extra).length > 0
    ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  return `${ts} [${level}] [${component}] ${msg}${extraStr}`;
}

function log(level: LogLevel, component: string, msg: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...extra,
  };

  const formatted = formatMessage(entry);

  // Write to file if configured (read at runtime to pick up late binding)
  const logFile = getLogFile();
  if (logFile) {
    ensureLogDir(logFile);
    fs.appendFileSync(logFile, formatted + '\n');
    // When logging to file, skip console output to avoid polluting TUI terminals
    return;
  }

  // Only write to console if no log file is configured (fallback mode)
  if (level === 'ERROR' || level === 'WARN') {
    console.error(formatted);
  } else {
    console.log(formatted);
  }
}

/**
 * Create a logger for a specific component.
 * @param component - Component name (e.g., 'daemon', 'router', 'connection')
 */
export function createLogger(component: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log('DEBUG', component, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log('INFO', component, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('WARN', component, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('ERROR', component, msg, extra),
  };
}

// Pre-created loggers for common components
export const daemonLog = createLogger('daemon');
export const routerLog = createLogger('router');
export const connectionLog = createLogger('connection');

// Default export for simple usage
export default createLogger;
