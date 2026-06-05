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

interface HarnessCommandContext {
  base: string;
  lower: string;
  normalized: string;
}

const HARNESS_COMMAND_MATCHERS: ReadonlyArray<{
  harness: string;
  matches: (ctx: HarnessCommandContext) => boolean;
}> = [
  {
    harness: 'claude-code',
    matches: ({ base, lower }) => base === 'claude' || lower.includes('claude-code'),
  },
  {
    harness: 'codex',
    matches: ({ base, normalized }) => base === 'codex' || normalized.includes('/codex'),
  },
  {
    harness: 'cursor',
    matches: ({ base, lower }) => base === 'cursor' || base === 'cursor-agent' || lower.includes('cursor'),
  },
  {
    harness: 'gemini-cli',
    matches: ({ base, lower }) => base === 'gemini' || base === 'gemini-cli' || lower.includes('gemini-cli'),
  },
  { harness: 'aider', matches: ({ base, lower }) => base === 'aider' || lower.includes('aider') },
  {
    harness: 'opencode',
    matches: ({ base, lower }) => base === 'opencode' || lower.includes('opencode'),
  },
  { harness: 'goose', matches: ({ base, lower }) => base === 'goose' || lower.includes('goose') },
  { harness: 'droid', matches: ({ base, lower }) => base === 'droid' || lower.includes('droid') },
  { harness: 'grok', matches: ({ base }) => base === 'grok' },
  { harness: 'amp', matches: ({ base, normalized }) => base === 'amp' || normalized.includes('/amp') },
  { harness: 'github-copilot', matches: ({ lower }) => lower.includes('copilot') },
  { harness: 'zed', matches: ({ base, lower }) => base === 'zed' || lower.includes('zed') },
];

export function inferHarnessFromCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const lower = command.toLowerCase();
  const normalized = lower.replace(/\\/g, '/');
  const base = path.basename(normalized).replace(/\.(exe|cmd|bat)$/i, '');
  const ctx: HarnessCommandContext = { base, lower, normalized };

  for (const matcher of HARNESS_COMMAND_MATCHERS) {
    if (matcher.matches(ctx)) return matcher.harness;
  }

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
