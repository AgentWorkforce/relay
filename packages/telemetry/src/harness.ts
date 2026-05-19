/**
 * Harness detection.
 *
 * Walks the current process's parent chain looking for a known harness
 * basename (Claude Code, Cursor, Codex, etc.). The classification answers
 * the business question "who is *driving* this CLI" — distinct from the
 * spawned child agent's CLI (which the broker already tracks).
 *
 * Detection is best-effort and pure observation:
 *   - On macOS we invoke `ps -o command= -p <pid>` since `process.platform`
 *     doesn't expose parent process names natively.
 *   - On Linux we read `/proc/<pid>/comm` and `/proc/<pid>/status` (PPid:).
 *   - On Windows we fall back to `'unknown'` (PowerShell-based detection is
 *     possible but adds latency; users on Windows are a long tail today).
 *
 * Failure modes are intentional non-events: any error returns `'unknown'`.
 * Known process classifiers should stay semantically consistent with the Rust
 * broker detector, but externally supplied harness labels are reporting
 * strings: any sanitized lower-kebab slug is accepted so new harnesses can
 * show up before the detector has a local classifier for them.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Lower-kebab-ish reporting slug for the orchestrator harness. */
export type Harness = string;

type ClassifiedHarness =
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
const HARNESS_PATTERNS: Array<{ harness: ClassifiedHarness; re: RegExp }> = [
  // Claude Code ships as `claude` on PATH plus a desktop "Claude" app on macOS.
  { harness: 'claude-code', re: /^claude(?:-code)?(?:\.exe)?$/i },
  { harness: 'claude-code', re: /^claude(?:\s+helper)?(?:\.exe)?$/i },
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

function classifyBasename(basename: string): ClassifiedHarness | null {
  for (const { harness, re } of HARNESS_PATTERNS) {
    if (re.test(basename)) {
      return harness;
    }
  }
  return null;
}

function sanitizeHarnessSlug(value: string): Harness | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(normalized) ? normalized : null;
}

/** Extract a basename from a process command string. */
function commandBasename(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  let executable = '';
  if (quote === '"' || quote === "'") {
    const endQuote = trimmed.indexOf(quote, 1);
    executable = endQuote >= 0 ? trimmed.slice(1, endQuote) : trimmed.slice(1);
  } else {
    executable = trimmed.split(/\s+/)[0] ?? '';
  }
  // Posix and Windows-style separators.
  const lastSlash = Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\'));
  return lastSlash >= 0 ? executable.slice(lastSlash + 1) : executable;
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
    if (!Number.isFinite(pid) || Math.floor(pid) !== pid || pid <= 0) {
      return null;
    }
    // Single `ps` call returns ppid and full command path.
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
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
 *      Any sanitized slug is accepted because this is a reporting label,
 *      not a runtime enum.
 *   2. Process-tree walk via platform-specific APIs.
 *   3. `'unknown'` on any failure.
 */
export function detectHarness(): Harness {
  if (cachedHarness !== null) {
    return cachedHarness;
  }

  // 1. Env-var hint (set by the CLI before spawning the broker).
  const envHint = process.env[HARNESS_ENV_VAR];
  if (envHint?.trim()) {
    cachedHarness = sanitizeHarnessSlug(envHint) ?? 'unknown';
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

/** Reset the cache. Test-only — production code should never need this. */
export function resetHarnessCacheForTests(): void {
  cachedHarness = null;
}

// Internal exports for testing.
export const __internal = {
  classifyBasename,
  commandBasename,
  sanitizeHarnessSlug,
};
