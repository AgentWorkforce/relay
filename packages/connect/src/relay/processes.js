import { execFile } from 'node:child_process';
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';

// The kernel's view of this computer's processes, ported from relay-desktop
// probe/src/relay/process.rs: parent, owner and start time, executable,
// arguments and open files. Linux reads /proc; macOS asks `ps` and `lsof`,
// since Node has no libproc. Every read is best effort: a process that is
// gone or unreadable is `null` / empty, never an exception.

/** How far up a process tree a caller is followed (process.rs MAX_ANCESTRY). */
export const MAX_ANCESTRY = 64;

const LINUX = process.platform === 'linux';
const COMMAND_TIMEOUT_MS = 10_000;

/** Runs a read-only system command; `null` when it fails or exits non-zero. */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        // `lstart` must be UTC and in English to compare with Claude's
        // recorded `procStart`.
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * The fields of `/proc/<pid>/stat` after the command name, which may itself
 * contain spaces and parentheses: index 1 is the parent, 19 the start time.
 */
export function statFields(stat) {
  const end = stat.lastIndexOf(')');
  return end < 0 ? [] : stat.slice(end + 1).trim().split(/\s+/);
}

async function linuxInfo(pid) {
  try {
    const [text, info] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      stat(`/proc/${pid}`),
    ]);
    const fields = statFields(text);
    const parent = Number.parseInt(fields[1] ?? '', 10);
    const start = fields[19];
    if (!Number.isInteger(parent) || !start || !/^\d+$/.test(start)) return null;
    return { pid, parent, uid: info.uid, start };
  } catch {
    return null;
  }
}

async function macInfo(pid) {
  const output = await run('ps', ['-o', 'ppid=,uid=,lstart=', '-p', String(pid)]);
  const match = output?.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return {
    pid,
    parent: Number.parseInt(match[1], 10),
    uid: Number.parseInt(match[2], 10),
    start: match[3].trim().replace(/\s+/g, ' '),
  };
}

/**
 * One process as the kernel reports it: `{pid, parent, uid, start}`, or
 * `null` when it is gone. `start` is clock ticks since boot on Linux
 * (`/proc/<pid>/stat` field 22) and the UTC `ctime`-style start
 * (`Mon Oct 12 15:22:47 2026`, whole seconds) on macOS: the two forms
 * Claude Code records as `procStart`. Two reads with equal values are the
 * same process.
 */
export async function processInfo(pid) {
  if (!validPid(pid)) return null;
  return LINUX ? linuxInfo(pid) : macInfo(pid);
}

/** The parent pid, or `null`. */
export async function parentOf(pid) {
  return (await processInfo(pid))?.parent ?? null;
}

/** The start time as Claude Code records it (see `processInfo`), or `null`. */
export async function processStart(pid) {
  return (await processInfo(pid))?.start ?? null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Claude Code's macOS `procStart`, `Wed Sep 30 10:00:00 2026` in UTC, as
 * whole seconds since the epoch (process.rs `claude_start_seconds`).
 */
export function claudeStartSeconds(text) {
  const parts = String(text).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, monthName, dayText, time, yearText] = parts;
  const month = MONTHS.indexOf(monthName);
  if (month < 0 || !/^\d+$/.test(dayText) || !/^-?\d+$/.test(yearText)) return null;
  const clock = time.split(':');
  if (clock.length !== 3 || clock.some((part) => !/^\d+$/.test(part))) return null;
  const [hour, minute, second] = clock.map((part) => Number.parseInt(part, 10));
  const day = Number.parseInt(dayText, 10);
  const year = Number.parseInt(yearText, 10);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const at = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(at);
  // Reject what chrono would: 31 Feb does not roll into March.
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month || at < 0) return null;
  return at / 1000;
}

/**
 * Whether Claude Code's recorded `procStart` names the process whose
 * `processStart` is `start`, so a recycled pid is never mistaken for the
 * session (process.rs `claude_start_matches`): equal ticks on Linux, the
 * same whole second on macOS.
 */
export function claudeStartMatches(recorded, start, platform = process.platform) {
  if (recorded == null || start == null) return false;
  if (platform === 'linux') return String(recorded).trim() === String(start).trim();
  const seconds = claudeStartSeconds(recorded);
  return seconds !== null && seconds === claudeStartSeconds(start);
}

/**
 * `pid` itself, then its parent, grandparent and so on, nearest first:
 * at most `max` entries, stopping before pid 1 or at a process that is
 * gone. Each entry is `processInfo`'s record.
 */
export async function ancestors(pid, max = MAX_ANCESTRY) {
  const chain = [];
  let current = pid;
  for (let index = 0; index < max; index += 1) {
    if (!validPid(current) || current <= 1) break;
    const info = await processInfo(current);
    if (!info) break;
    chain.push(info);
    current = info.parent;
  }
  return chain;
}

/** The absolute paths of the files `pid` has open. */
export async function openFiles(pid) {
  if (!validPid(pid)) return [];
  if (LINUX) {
    const directory = `/proc/${pid}/fd`;
    const entries = await readdir(directory).catch(() => []);
    const targets = await Promise.all(
      entries.map((entry) => readlink(`${directory}/${entry}`).catch(() => null)),
    );
    return targets.filter((target) => typeof target === 'string' && target.startsWith('/'));
  }
  const output = await run('lsof', ['-w', '-p', String(pid), '-Fn']);
  if (!output) return [];
  return output
    .split('\n')
    .filter((line) => line.startsWith('n/'))
    .map((line) => line.slice(1));
}

/** Whether `pid` has `path` open. */
export async function holdsFile(pid, path) {
  const files = await openFiles(pid);
  if (files.includes(path)) return true;
  // macOS reports `/private/var/...` for `/var/...` and the like.
  const real = await realpath(path).catch(() => null);
  return real !== null && files.includes(real);
}

/**
 * The process's arguments. Exact on Linux (`/proc/<pid>/cmdline`); on
 * macOS `ps -o args=` joins them with spaces, so they are split on
 * whitespace and an argument containing a space is split too.
 */
export async function argvOf(pid) {
  if (!validPid(pid)) return [];
  if (LINUX) {
    const bytes = await readFile(`/proc/${pid}/cmdline`).catch(() => null);
    if (!bytes) return [];
    return bytes
      .toString('utf8')
      .split('\0')
      .filter((part) => part.length > 0);
  }
  const output = await run('ps', ['-o', 'args=', '-p', String(pid)]);
  return output ? output.trim().split(/\s+/).filter(Boolean) : [];
}

/** Whether a process with this pid exists (it may belong to another user). */
export function isAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Every process as `{pid, uid, executable}`: the kernel's executable path
 * on Linux (`/proc/<pid>/exe`), the full command path `ps -o comm=`
 * reports on macOS.
 */
export async function listProcesses() {
  if (LINUX) {
    const entries = await readdir('/proc').catch(() => []);
    const found = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          const pid = Number.parseInt(entry, 10);
          try {
            const [executable, info] = await Promise.all([
              readlink(`/proc/${pid}/exe`),
              stat(`/proc/${pid}`),
            ]);
            return { pid, uid: info.uid, executable: executable.replace(/ \(deleted\)$/, '') };
          } catch {
            return null;
          }
        }),
    );
    return found.filter(Boolean);
  }
  const output = await run('ps', ['-axo', 'pid=,uid=,comm=']);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      uid: Number.parseInt(match[2], 10),
      executable: match[3],
    }));
}

/**
 * Whether `executable` is a Codex this user may run as theirs: named
 * `codex`, and on Linux owned by root or this user and writable by no one
 * else (process.rs `is_trusted_codex`). The macOS OpenAI code-signature
 * check is deliberately not ported (docs/connect-node-local-relay.md,
 * "Not ported").
 */
export async function isTrustedCodex(executable) {
  if (basename(executable) !== 'codex') return false;
  if (!LINUX) return true;
  const info = await stat(executable).catch(() => null);
  if (!info?.isFile()) return false;
  const uid = process.getuid?.();
  return (info.uid === 0 || info.uid === uid) && (info.mode & 0o022) === 0;
}
