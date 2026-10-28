import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Small machine-wide JSON stores (Relaycast origin bindings, saved agent
 * tokens) are read, changed and rewritten by whichever CLI process needs
 * them. An atomic rename alone keeps the file whole but lets two concurrent
 * commands each write from a stale snapshot, silently dropping the other's
 * entry. These helpers serialise the whole read-modify-write across
 * processes.
 */

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const OWNER_FILE = 'owner';

function isContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST') return true;
  // Windows can report a racing directory create/remove as a sharing violation.
  return process.platform === 'win32' && (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM');
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A lock whose owner has exited, or which has no owner long after it was made. */
function lockIsStale(lock: string): boolean {
  let pid: number | undefined;
  try {
    const parsed = Number.parseInt(fs.readFileSync(path.join(lock, OWNER_FILE), 'utf8'), 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    // Owner not written yet, or the lock just went away.
  }
  if (pid !== undefined) return !ownerIsAlive(pid);
  try {
    return Date.now() - fs.statSync(lock).mtimeMs >= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock for `file`.
 *
 * @param file - The store the caller is about to read and rewrite.
 * @param fn - The complete read-modify-write; it must be synchronous.
 * @returns Whatever `fn` returns.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Read the clock only under contention, so an uncontended update has no
  // timing side effects.
  let startedAt: number | undefined;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, OWNER_FILE), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if (!isContention(error)) throw error;
    }
    if (lockIsStale(lock)) {
      fs.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    startedAt ??= Date.now();
    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for ${lock}. If no other agent-relay command is running, remove it and retry.`
      );
    }
    Atomics.wait(LOCK_WAIT, 0, 0, LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Replace `file` with `contents` in one step, readable only by this user.
 *
 * @param file - Destination path; its directory is created if missing.
 * @param contents - The complete new file contents.
 */
export function writeFileAtomically(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
