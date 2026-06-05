import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const UNKNOWN_ORCHESTRATOR_HARNESS = 'unknown';
export const ORCHESTRATOR_HARNESS_ENV = 'AGENT_RELAY_ORCHESTRATOR_HARNESS';

const HARNESS_MAX_LENGTH = 120;
const HARNESS_ALLOWED = /^[a-z0-9 ._\-/():=;,+]+$/i;
const EXPLICIT_HARNESS_ENV_KEYS = [
  ORCHESTRATOR_HARNESS_ENV,
  'RELAYCAST_HARNESS',
  'X_RELAYCAST_HARNESS',
] as const;

export interface ProcessInfo {
  pid: number;
  ppid?: number;
  command?: string;
}

export interface DetectOrchestratorHarnessOptions {
  env?: NodeJS.ProcessEnv;
  startPid?: number;
  maxDepth?: number;
  processLookup?: (pid: number) => ProcessInfo | undefined;
}

export function sanitizeOrchestratorHarness(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!HARNESS_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, HARNESS_MAX_LENGTH).toLowerCase();
}

export function inferHarnessFromCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const lower = command.toLowerCase();
  const normalized = lower.replace(/\\/g, '/');
  const base = path.basename(normalized).replace(/\.(exe|cmd|bat)$/i, '');

  if (base === 'claude' || lower.includes('claude-code')) return 'claude-code';
  if (base === 'codex' || normalized.includes('/codex')) return 'codex';
  if (base === 'cursor' || base === 'cursor-agent' || lower.includes('cursor')) return 'cursor';
  if (base === 'gemini' || base === 'gemini-cli' || lower.includes('gemini-cli')) return 'gemini-cli';
  if (base === 'aider' || lower.includes('aider')) return 'aider';
  if (base === 'opencode' || lower.includes('opencode')) return 'opencode';
  if (base === 'goose' || lower.includes('goose')) return 'goose';
  if (base === 'droid' || lower.includes('droid')) return 'droid';
  if (base === 'grok' || lower.includes('/grok')) return 'grok';
  if (base === 'amp' || normalized.includes('/amp')) return 'amp';
  if (lower.includes('copilot')) return 'github-copilot';
  if (base === 'zed' || lower.includes('zed')) return 'zed';

  return undefined;
}

function lookupProcessInfo(pid: number): ProcessInfo | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'win32') return undefined;

  try {
    const result = spawnSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    if (result.status !== 0) return undefined;
    const line = result.stdout.trim();
    if (!line) return undefined;
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) return undefined;
    return {
      pid,
      ppid: Number.parseInt(match[1], 10),
      command: match[2].trim(),
    };
  } catch {
    return undefined;
  }
}

export function detectOrchestratorHarness(options: DetectOrchestratorHarnessOptions = {}): string {
  const env = options.env ?? process.env;
  for (const key of EXPLICIT_HARNESS_ENV_KEYS) {
    const value = sanitizeOrchestratorHarness(env[key]);
    if (value) return value;
  }

  const lookup = options.processLookup ?? lookupProcessInfo;
  let pid = options.startPid ?? process.ppid;
  const maxDepth = Math.max(1, options.maxDepth ?? 8);
  const seen = new Set<number>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break;
    seen.add(pid);

    const info = lookup(pid);
    const harness = inferHarnessFromCommand(info?.command);
    if (harness) return harness;

    if (!info?.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }

  return UNKNOWN_ORCHESTRATOR_HARNESS;
}
