/**
 * Harness detection.
 *
 * Walks the current process's parent chain looking for a known harness
 * basename (Claude Code, Cursor, Codex, etc.). The classification answers
 * the business question "who is *driving* this CLI" — distinct from the
 * spawned child agent's CLI (which the broker already tracks).
 *
 * Detection is best-effort and pure observation:
 *   - On macOS we shell out to `ps -o command= -p <pid>` since `process.platform`
 *     doesn't expose parent process names natively.
 *   - On Linux we read `/proc/<pid>/comm` and `/proc/<pid>/status` (PPid:).
 *   - On Windows we fall back to `'unknown'` (PowerShell-based detection is
 *     possible but adds latency; users on Windows are a long tail today).
 *
 * Failure modes are intentional non-events: any error returns `'unknown'`,
 * so telemetry can size the long tail and we discover new harnesses to
 * classify by watching which `unknown` baselines show up.
 *
 * Schema alignment: the slug set is shared verbatim with
 *   - `src/telemetry.rs` (broker-side detection)
 *   - the relaycast server-side header parser (PR
 *     AgentWorkforce/relaycast#132)
 * Keep all three in sync when adding a harness.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Lower-kebab-case canonical harness values. The relaycast server-side
 * sanitizer is permissive (lowercase, ASCII-only, ≤40 chars) — we send the
 * canonical slug so values round-trip without truncation or coercion.
 */
export type Harness =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'aider'
  | 'cline'
  | 'continue'
  | 'windsurf'
  | 'zed'
  | 'unknown';

/** Env var the CLI sets so the spawned broker doesn't re-detect. */
export const HARNESS_ENV_VAR = 'AGENT_RELAY_HARNESS';

/**
 * Maximum number of ancestor processes to inspect before giving up.
 * Most harnesses are within 2-4 hops; cap to avoid pathological loops
 * on platforms where ppid resolution returns garbage.
 */
const MAX_ANCESTOR_DEPTH = 10;

/**
 * Patterns that map a process basename → harness. Match is case-insensitive
 * against the executable basename (e.g. `claude`, `Cursor Helper`).
 *
 * Ordering matters: more specific patterns first.
 */
const HARNESS_PATTERNS: Array<{ harness: Harness; re: RegExp }> = [
  // Claude Code ships as `claude` on PATH plus a desktop "Claude" app on macOS.
  { harness: 'claude-code', re: /^claude(?:-code)?(?:\.exe)?$/i },
  { harness: 'claude-code', re: /^Claude(?:\s+Helper)?$/ },
  // Cursor: editor + helper processes.
  { harness: 'cursor', re: /^cursor(?:\s+helper)?(?:\.exe)?$/i },
  // Codex CLI (OpenAI).
  { harness: 'codex', re: /^codex(?:\.exe)?$/i },
  // Gemini CLI (Google).
  { harness: 'gemini', re: /^gemini(?:\.exe)?$/i },
  // Aider.
  { harness: 'aider', re: /^aider(?:\.exe)?$/i },
  // Cline (VSCode extension; host process is `Code`/`code-insiders` so this
  // mostly fires when invoked from the CLI sidecar).
  { harness: 'cline', re: /^cline(?:\.exe)?$/i },
  // Continue.dev (similar caveat to cline).
  { harness: 'continue', re: /^continue(?:\.exe)?$/i },
  // Windsurf.
  { harness: 'windsurf', re: /^windsurf(?:\s+helper)?(?:\.exe)?$/i },
  // Zed (with Agent Relay integration).
  { harness: 'zed', re: /^zed(?:\.exe)?$/i },
];

function classifyBasename(basename: string): Harness | null {
  for (const { harness, re } of HARNESS_PATTERNS) {
    if (re.test(basename)) {
      return harness;
    }
  }
  return null;
}

/** Extract a basename from a process command string. */
function commandBasename(command: string): string {
  const trimmed = command.trim().split(/\s+/)[0] ?? '';
  const stripped = trimmed.replace(/^["']|["']$/g, '');
  // Posix and Windows-style separators.
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
}

interface ProcInfo {
  command: string;
  ppid: number;
}

function readLinuxProcInfo(pid: number): ProcInfo | null {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
    const ppid = ppidMatch ? Number.parseInt(ppidMatch[1], 10) : 0;
    return { command: comm, ppid: Number.isFinite(ppid) ? ppid : 0 };
  } catch {
    return null;
  }
}

function readDarwinProcInfo(pid: number): ProcInfo | null {
  try {
    // Single `ps` call returns ppid and full command path.
    const out = execSync(`ps -o ppid=,command= -p ${pid}`, {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const match = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return null;
    const ppid = Number.parseInt(match[1], 10);
    return { command: match[2], ppid: Number.isFinite(ppid) ? ppid : 0 };
  } catch {
    return null;
  }
}

function readProcInfo(pid: number): ProcInfo | null {
  if (process.platform === 'linux') return readLinuxProcInfo(pid);
  if (process.platform === 'darwin') return readDarwinProcInfo(pid);
  return null;
}

let cachedHarness: Harness | null = null;

/**
 * Detect the harness driving this process. Cached after the
 * first call — process trees don't change for a given run.
 *
 * Resolution order:
 *   1. `AGENT_RELAY_HARNESS` env var (set by a parent CLI when
 *      it spawns the broker — saves the broker from re-walking).
 *   2. Process-tree walk via platform-specific APIs.
 *   3. `'unknown'` on any failure.
 */
export function detectHarness(): Harness {
  if (cachedHarness !== null) {
    return cachedHarness;
  }

  // 1. Env-var hint (set by the CLI before spawning the broker).
  const envHint = process.env[HARNESS_ENV_VAR]?.trim().toLowerCase();
  if (envHint) {
    cachedHarness = isKnownHarness(envHint) ? envHint : 'unknown';
    return cachedHarness;
  }

  // 2. Walk the parent chain.
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    cachedHarness = 'unknown';
    return cachedHarness;
  }

  let pid = typeof process.ppid === 'number' ? process.ppid : 0;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && pid > 1; depth += 1) {
    const info = readProcInfo(pid);
    if (!info) break;
    const harness = classifyBasename(commandBasename(info.command));
    if (harness) {
      cachedHarness = harness;
      return cachedHarness;
    }
    if (info.ppid === pid || info.ppid <= 1) break;
    pid = info.ppid;
  }

  cachedHarness = 'unknown';
  return cachedHarness;
}

const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  'claude-code',
  'cursor',
  'codex',
  'gemini',
  'aider',
  'cline',
  'continue',
  'windsurf',
  'zed',
  'unknown',
]);

function isKnownHarness(value: string): value is Harness {
  return KNOWN_HARNESSES.has(value);
}

/** Reset the cache. Test-only — production code should never need this. */
export function resetHarnessCacheForTests(): void {
  cachedHarness = null;
}

// Internal exports for testing.
export const __internal = {
  classifyBasename,
  commandBasename,
};
