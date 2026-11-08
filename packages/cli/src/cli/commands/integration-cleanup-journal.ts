import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectPaths } from '@agent-relay/config';
import { describeError } from '../lib/describe-error.js';

/**
 * Durable, project-local journal of external cleanup work that failed or may
 * have been orphaned by a crash. It exists because several ids have no other
 * durable home once their run ends:
 *
 * - a superseded relayfile-cloud webhook subscription id is overwritten in the
 *   binding record the moment the replacement bind() lands;
 * - a rollback after a failed subscribe tears down resources that were never
 *   bound anywhere;
 * - a crash between any remote create and persisting its server-assigned id
 *   leaves a live resource findable only by a deterministic recovery key —
 *   recorded here as a `subscribe-attempt` entry written BEFORE the first
 *   create and upgraded with concrete ids as they are assigned.
 *
 * Entries are retried best-effort on later subscribe/unsubscribe runs and are
 * scoped to the connection identity that created them, so a sweep never
 * deletes resources through the wrong workspace/daemon. An entry carrying an
 * `owner` is the LEASE of a live transaction: other processes must neither
 * sweep it nor clear it unless the owner is provably dead on this host.
 *
 * The journal file lives in the CLI's project data dir (`.agentworkforce/relay/`,
 * excluded from git by @agent-relay/config's ensureGitExclude) and is written
 * 0600 via temp-file write + fsync + atomic rename + parent-directory fsync,
 * so a committed update survives host/power crashes, and every
 * read-modify-write runs under an exclusive lock directory
 * (`pending-cleanups.json.lock.d`) so concurrent CLI processes cannot lose
 * entries, plus the legacy `pending-cleanups.json.lock` that CLI releases up
 * to 17.2.1 lock, so older and newer CLIs exclude each other too. Both are
 * taken in-process, so they need no helper binary and work in the standalone
 * install. A corrupt or unreadable journal FAILS
 * CLOSED: reads throw, nothing is swept, and callers abort before creating
 * new external resources.
 *
 * Attempt entries carry the inbound-target `url`, which may be capability
 * bearing — callers must never log entry urls or ids (the 0600 file is their
 * only home).
 */

export type PendingCleanupKind =
  'relayfile-webhook-subscription' | 'relay-webhook' | 'relay-subscription' | 'subscribe-attempt';

export interface PendingCleanupOwner {
  pid: number;
  host: string;
  /** Unique per transaction, so a run only ever clears ITS OWN entries. */
  attemptId: string;
  /**
   * Epoch-ms lease heartbeat, stamped when the owner takes (or re-takes) the
   * lease. Liveness requires BOTH a passing pid probe AND a fresh heartbeat:
   * PID reuse (or an unprobeable foreign host) can therefore wedge later
   * lifecycles for at most the bounded lease window, never permanently.
   */
  heartbeatAt: number;
}

export interface PendingCleanupEntry {
  kind: PendingCleanupKind;
  /** Connection identity that may retry this entry (never a secret). */
  scope: string;
  /**
   * Lifecycle operation a `subscribe-attempt` reservation belongs to. Both
   * operations share one per-(scope, provider, resource) lease so a
   * subscribe and an unsubscribe can never interleave on the same binding;
   * an `unsubscribe` reservation creates nothing, so it carries no recovery
   * keys and a dead one is simply dropped.
   */
  operation?: 'subscribe' | 'unsubscribe';
  /** Concrete resource id — required for the three concrete kinds. */
  id?: string;
  /**
   * relayfile-cloud workspace the resource lives in, when known. Sweeps pin
   * delete/list calls to it, and a cloud 404 only counts as convergence when
   * the entry is pinned — an unpinned 404 might just be the wrong active
   * workspace, so the entry is retained instead.
   */
  relayfileWorkspaceId?: string;
  /**
   * subscribe-attempt recovery keys. `url`+`pathGlobs` deterministically find
   * the relayfile-cloud subscription; the exact `webhookName` finds the relay
   * inbound webhook; `writebackUrl` (+ binding references) finds the relay
   * event subscription. `relayScope` scopes the relay-side recovery.
   */
  provider?: string;
  resource?: string;
  url?: string;
  pathGlobs?: string[];
  /** Exact inbound webhook name (chosen before create, unique per attempt) —
   * recovery matches on it precisely so it can never delete a DIFFERENT
   * attempt's pre-bind webhook for the same resource. */
  webhookName?: string;
  writebackUrl?: string;
  relayScope?: string;
  /** Concrete ids, filled in as each create returns (best-effort). */
  webhookId?: string;
  webhookSubscriptionId?: string;
  subscriptionId?: string;
  /**
   * Present while a live transaction owns this entry (its lease across
   * remote creates → bind). Terminal failure records are written without an
   * owner so any later run may retry them.
   */
  owner?: PendingCleanupOwner;
}

export interface CleanupJournal {
  /** Snapshot of the journal. Throws CleanupJournalError if unreadable/corrupt. */
  list(): Promise<PendingCleanupEntry[]>;
  /**
   * Atomic read-modify-write under the exclusive journal lock. The mutation
   * may be async — remote lifecycle actions that must serialize with
   * reservations (e.g. URL-keyed recovery deletes) run inside it. Throws
   * CleanupJournalError when the journal is corrupt or the lock cannot be
   * acquired — callers must treat that as fail-closed.
   */
  update(
    mutate: (entries: PendingCleanupEntry[]) => PendingCleanupEntry[] | Promise<PendingCleanupEntry[]>
  ): Promise<void>;
}

export class CleanupJournalError extends Error {
  constructor(
    public readonly code: 'corrupt' | 'locked' | 'io',
    message: string
  ) {
    super(message);
    this.name = 'CleanupJournalError';
  }
}

/** Stable identity for dedup/removal. Order-insensitive over pathGlobs; an
 * owned entry is keyed by its attemptId too, so a transaction only ever adds,
 * upgrades, or clears ITS OWN entries and never a concurrent attempt's. The
 * delimiter is an escaped NUL, which cannot occur in any component. */
export function cleanupEntryKey(entry: PendingCleanupEntry): string {
  const globs = [...(entry.pathGlobs ?? [])].sort().join(',');
  return [
    entry.kind,
    entry.scope,
    entry.id ?? '',
    entry.provider ?? '',
    entry.resource ?? '',
    entry.url ?? '',
    globs,
    entry.owner?.attemptId ?? '',
  ].join('\u0000');
}

const LOCK_TIMEOUT_MS = 5_000;

const CONCRETE_KINDS: ReadonlySet<string> = new Set([
  'relayfile-webhook-subscription',
  'relay-webhook',
  'relay-subscription',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isValidOwner(owner: unknown): boolean {
  if (owner === undefined) return true;
  if (!owner || typeof owner !== 'object') return false;
  const candidate = owner as PendingCleanupOwner;
  return (
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    isNonEmptyString(candidate.host) &&
    isNonEmptyString(candidate.attemptId) &&
    typeof candidate.heartbeatAt === 'number' &&
    Number.isFinite(candidate.heartbeatAt) &&
    candidate.heartbeatAt > 0
  );
}

/** Discriminated validation — anything short of a well-formed entry is corrupt,
 * so a mangled journal can never be silently treated as "nothing pending". */
function isValidEntry(value: unknown): value is PendingCleanupEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as PendingCleanupEntry;
  if (!isNonEmptyString(entry.scope)) return false;
  if (!isValidOwner(entry.owner)) return false;
  if (!isOptionalString(entry.relayfileWorkspaceId)) return false;
  if (CONCRETE_KINDS.has(entry.kind)) return isNonEmptyString(entry.id);
  if (entry.kind === 'subscribe-attempt') {
    if (
      entry.operation !== undefined &&
      entry.operation !== 'subscribe' &&
      entry.operation !== 'unsubscribe'
    ) {
      return false;
    }
    if (entry.operation === 'unsubscribe') {
      return isNonEmptyString(entry.provider) && isNonEmptyString(entry.resource);
    }
    return (
      isNonEmptyString(entry.url) &&
      isNonEmptyString(entry.provider) &&
      isNonEmptyString(entry.resource) &&
      isNonEmptyString(entry.webhookName) &&
      isNonEmptyString(entry.writebackUrl) &&
      isNonEmptyString(entry.relayScope) &&
      Array.isArray(entry.pathGlobs) &&
      entry.pathGlobs.length > 0 &&
      entry.pathGlobs.every(isNonEmptyString) &&
      isOptionalString(entry.webhookId) &&
      isOptionalString(entry.webhookSubscriptionId) &&
      isOptionalString(entry.subscriptionId)
    );
  }
  return false;
}

function parseEntries(raw: string, file: string): PendingCleanupEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CleanupJournalError(
      'corrupt',
      `The pending-cleanup journal at ${file} is not valid JSON. Nothing was swept or overwritten; inspect it (it may reference external resources that still need deletion) and remove it to continue.`
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isValidEntry)) {
    throw new CleanupJournalError(
      'corrupt',
      `The pending-cleanup journal at ${file} has an unexpected shape. Nothing was swept or overwritten; inspect it and remove it to continue.`
    );
  }
  return parsed;
}

/** How often a holder refreshes its lease while a transaction is open. */
const LOCK_HEARTBEAT_MS = 5_000;
/**
 * A lock held from ANOTHER host (a shared data directory) whose heartbeat is
 * older than this is abandoned: its pid cannot be probed from here.
 */
const LOCK_LEASE_MS = 60_000;
/**
 * A holder on THIS host is broken as soon as its pid is gone. While its pid
 * still answers it is broken only once its heartbeat is older than this: a live
 * holder refreshes every few seconds, so a heartbeat this old means the pid was
 * reused by an unrelated process after a crash. The window is far longer than
 * any stalled fsync, so a live writer keeps exclusive ownership through its
 * commit.
 */
const LOCK_LOCAL_REUSE_MS = 15 * 60_000;
/** A lock directory with no readable owner (crash between mkdir and write). */
const LOCK_ORPHAN_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_OWNER_FILE = 'owner.json';

interface JournalLockOwner {
  pid: number;
  host: string;
  token: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isLockContention(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'EEXIST') return true;
  // Windows can report a racing directory create/remove as a sharing violation.
  return process.platform === 'win32' && (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM');
}

function readLockOwner(lockDir: string): { owner: JournalLockOwner; heartbeatAt: number } | undefined {
  const ownerFile = path.join(lockDir, LOCK_OWNER_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Partial<JournalLockOwner>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !isNonEmptyString(parsed.host) ||
      !isNonEmptyString(parsed.token)
    ) {
      return undefined;
    }
    return {
      owner: { pid: parsed.pid, host: parsed.host, token: parsed.token },
      heartbeatAt: fs.statSync(ownerFile).mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The token of an abandoned lock (holder on this host exited or its pid was
 * reused, a holder on another host let its lease expire, or an ownerless
 * directory older than the orphan window), or undefined while the lock is
 * live. An ownerless stale lock yields the empty token.
 */
function staleLockToken(lockDir: string, now: number): string | undefined {
  const current = readLockOwner(lockDir);
  if (current) {
    const { owner, heartbeatAt } = current;
    if (owner.host === os.hostname()) {
      if (!processIsAlive(owner.pid)) return owner.token;
      return now - heartbeatAt >= LOCK_LOCAL_REUSE_MS ? owner.token : undefined;
    }
    return now - heartbeatAt >= LOCK_LEASE_MS ? owner.token : undefined;
  }
  try {
    return now - fs.statSync(lockDir).mtimeMs >= LOCK_ORPHAN_MS ? '' : undefined;
  } catch {
    return undefined; // already gone; the next mkdir attempt decides
  }
}

/** Whether this process still owns `lockDir` under `token`. */
function ownsLock(lockDir: string, token: string): boolean {
  return readLockOwner(lockDir)?.owner.token === token;
}

/**
 * Create the lock directory `dir` carrying `owner`. False when another holder
 * has it; throws on any other error. The owner record is created exclusively
 * (`wx`): if a recoverer put a lock back onto our just-created, still empty
 * directory, that lock's owner is already there and is never overwritten.
 */
function createLockDir(dir: string, owner: JournalLockOwner): boolean {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (isLockContention(err)) return false;
    throw err;
  }
  const ownerFile = path.join(dir, LOCK_OWNER_FILE);
  try {
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    // Remove only what is provably ours: our partial owner file, then the
    // directory if it is empty. Never a recursive delete here.
    try {
      fs.rmSync(ownerFile, { force: true });
      fs.rmdirSync(dir);
    } catch {
      // Not empty (not ours) or already gone.
    }
    throw err;
  }
  return true;
}

/** `retry`: try the mkdir again at once. `wait`: back off under the deadline. */
type RecoveryOutcome = 'retry' | 'wait';

/**
 * Move the abandoned lock `dir` (judged stale under `staleToken`) aside and
 * delete it. Callers hold the recovery lock, so no other recoverer can move or
 * replace it concurrently; the moved directory is still judged again, because
 * a holder judged stale may have been a slow live process that released and
 * let a new writer in between the check and the rename. A directory that
 * turns out not to be the stale one is put back, and if that fails it is left
 * as a tombstone: its owner then finds its lock lost and refuses to commit,
 * which is safe, whereas deleting it would not be.
 */
function moveAsideIfStale(dir: string, staleToken: string): RecoveryOutcome {
  const tombstone = `${dir}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(dir, tombstone);
  } catch (err) {
    // Only a lock that actually disappeared earns an immediate retry. A
    // transient Windows sharing violation backs off under the deadline; any
    // other refusal (e.g. a parent directory that does not allow renames) is
    // an I/O error, never a reason to spin.
    if (errorCode(err) === 'ENOENT') return 'retry';
    if (isLockContention(err)) return 'wait';
    throw new CleanupJournalError(
      'io',
      `Could not recover the abandoned pending-cleanup journal lock at ${dir}: ${describeError(err)}`
    );
  }
  const moved = readLockOwner(tombstone);
  if ((moved?.owner.token ?? '') === staleToken && staleLockToken(tombstone, Date.now()) === staleToken) {
    fs.rmSync(tombstone, { recursive: true, force: true });
    return 'retry';
  }
  try {
    fs.renameSync(tombstone, dir);
  } catch {
    // A newer lock already sits at `dir`; keep the tombstone (see above).
  }
  return 'wait';
}

/**
 * Break an abandoned journal lock observed with `staleToken`.
 *
 * Recovery is serialized by a second lock directory, `<lockDir>.recover`, so
 * an observation made before another recoverer broke the lock and a new writer
 * took it can never move that writer's live lock: under the recovery lock the
 * owner is read again and the lock is moved only if it is still the stale one.
 * A recoverer holds the recovery lock for a few synchronous filesystem calls;
 * one it left behind by crashing is judged by the same staleness rules (dead
 * pid on this host, expired lease from another host, ownerless past the
 * orphan window) and moved aside the same way.
 */
function breakStaleLock(lockDir: string, staleToken: string): RecoveryOutcome {
  const recoverDir = `${lockDir}.recover`;
  const recoverer: JournalLockOwner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  let held: boolean;
  try {
    held = createLockDir(recoverDir, recoverer);
  } catch (err) {
    throw new CleanupJournalError(
      'io',
      `Could not take the pending-cleanup journal recovery lock at ${recoverDir}: ${describeError(err)}`
    );
  }
  if (!held) {
    const staleRecoverer = staleLockToken(recoverDir, Date.now());
    if (staleRecoverer !== undefined) moveAsideIfStale(recoverDir, staleRecoverer);
    return 'wait';
  }
  try {
    if (staleLockToken(lockDir, Date.now()) !== staleToken) {
      // Released, broken by another recoverer, or re-taken since we looked.
      return fs.existsSync(lockDir) ? 'wait' : 'retry';
    }
    return moveAsideIfStale(lockDir, staleToken);
  } finally {
    if (ownsLock(recoverDir, recoverer.token)) {
      fs.rmSync(recoverDir, { recursive: true, force: true });
    }
  }
}

class LockLostError extends Error {}

/**
 * Replace `journal` durably: exclusive 0600 temp file, fsync, atomic rename,
 * then fsync the parent directory so the rename itself survives a crash.
 */
function replaceJournalDurably(journal: string, payload: string, stillOwned: () => boolean): void {
  const tmp = `${journal}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Re-checked after the (possibly slow) fsync, immediately before the one
    // step that changes the journal.
    if (!stillOwned()) throw new LockLostError();
    fs.renameSync(tmp, journal);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already failing
      }
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // The journal is in place from here on: a failed directory fsync weakens
  // crash durability of the rename but must not report the committed update as
  // failed (callers treat a failure as "nothing changed" and would redo it).
  // Windows cannot open or fsync a directory handle this way at all.
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(path.dirname(journal), 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // Best-effort, see above.
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        // Best-effort.
      }
    }
  }
}

/*
 * Legacy lock (CLI releases up to 17.2.1).
 *
 * Those releases serialized the journal through the retired broker's hidden
 * `journal-lock` helper: it opens `pending-cleanups.json.lock` (created 0600,
 * a stable inode that is never renamed or unlinked) and takes an exclusive
 * kernel lock on it with Rust's `File::try_lock`, i.e. flock(2) with
 * LOCK_EX|LOCK_NB on Linux and macOS and LockFileEx over the whole file on
 * Windows, retrying every 100 ms for 5 s (then exit 4, "locked"). Holding the
 * lock it reads the file: empty or a strict prefix of the v2 marker is
 * (re)stamped with the marker, anything else makes it exit 3 ("sentinel",
 * reported as "locked") without touching the journal. Only then does it
 * replace the journal, and the kernel drops the lock when it exits.
 *
 * Node and Bun have no flock(2)/LockFileEx API and this module must not load a
 * native addon (the Bun standalone cannot) or spawn a helper (the standalone
 * install ships none), so a newer transaction excludes older writers as
 * strongly as each platform allows, for the whole transaction, after taking
 * the lock directory:
 *
 * - macOS and FreeBSD: open(2) with O_EXLOCK|O_NONBLOCK takes the very same
 *   flock(2) lock, so this is the legacy lock itself: older helpers wait for
 *   it (and time out as "locked"), and the kernel releases it if we die.
 * - Windows: libuv's UV_FS_O_EXLOCK opens the file with share mode 0. An older
 *   helper cannot open it while we hold it (it exits with an error, never
 *   touching the journal), and our open fails while a helper has it open,
 *   which covers the whole time it holds LockFileEx.
 * - Both are verified once per process on a scratch file next to the lock
 *   (never by reopening the lock file): a second open asking for the same
 *   exclusivity must be refused. If the runtime ignores the flag, the marker
 *   exclusion below is used instead.
 * - Linux (and any runtime where the above is unavailable): the file is
 *   stamped with a token-bearing sentinel that is not a prefix of the v2
 *   marker, so any older helper that acquires the flock afterwards reads it
 *   and exits 3 without touching the journal. A helper that took the flock
 *   BEFORE the stamp is still holding it when we look, so after stamping we
 *   read /proc/locks and wait while any FLOCK lock is held on the file's
 *   inode (a lock on an unrelated file with the same inode number elsewhere
 *   only makes us wait longer). Order matters: stamp, then look; a helper
 *   that overwrote the stamp while healing it was holding the lock and is
 *   seen, and the stamp is rewritten on the next round. On release the v2
 *   marker is written back, only while the file still holds OUR sentinel.
 *   Limits: a helper in another pid namespace is hidden from /proc/locks, and
 *   without /proc only newly arriving helpers are excluded. If we crash while
 *   holding, older CLIs keep failing closed ("locked") until the next newer
 *   transaction restores the marker.
 * - A file holding anything else (neither empty, a marker prefix nor a
 *   sentinel) is left exactly as it is: older helpers already refuse to run on
 *   it.
 */
const LEGACY_LOCK_MARKER = 'agent-relay-cleanup-lock v2\n';
const LEGACY_SENTINEL_PREFIX = '{"agent-relay-cleanup-lock":"held by a newer agent-relay CLI","token":"';
/** O_EXLOCK on macOS and FreeBSD (not exported by fs.constants). */
const O_EXLOCK_BSD = 0x20;
/** libuv's UV_FS_O_EXLOCK on Windows: open with share mode 0. */
const UV_FS_O_EXLOCK_WIN = 0x10000000;

interface LegacyLock {
  /** Idempotent and never throws. */
  release(): void;
}

function legacyLockTimeout(lockFile: string): CleanupJournalError {
  return new CleanupJournalError(
    'locked',
    `Timed out waiting for the pending-cleanup journal lock at ${lockFile}: an older agent-relay CLI (17.2.1 or earlier) holds it. It is released when that process finishes; retry afterwards.`
  );
}

function isWindowsLockViolation(error: unknown): boolean {
  const code = errorCode(error);
  return process.platform === 'win32' && (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM');
}

interface ExclusiveOpen {
  /** Flags that make an open of the file exclusive on this platform. */
  readonly flags: number;
  /** Whether an open failed because another descriptor holds the file. */
  contended(err: unknown): boolean;
}

/** macOS/FreeBSD/Windows: how to open a file exclusively on this platform. */
function exclusiveOpen(): ExclusiveOpen {
  const windows = process.platform === 'win32';
  return {
    flags: windows ? UV_FS_O_EXLOCK_WIN : O_EXLOCK_BSD | fs.constants.O_NONBLOCK,
    contended(err) {
      const code = errorCode(err);
      return windows ? isWindowsLockViolation(err) : code === 'EAGAIN' || code === 'EWOULDBLOCK';
    },
  };
}

/** Open `file` once, returning `busy` if another descriptor holds it exclusively. */
function openUnlessContended(file: string, flags: number, exclusive: ExclusiveOpen): number | 'busy' {
  try {
    return fs.openSync(file, flags, 0o600);
  } catch (err) {
    if (exclusive.contended(err)) return 'busy';
    throw err;
  }
}

/** Whether this runtime honours the exclusive-open flag; probed once per process. */
let exclusiveOpenHonoured: boolean | undefined;

/**
 * Probe whether the runtime honours the exclusive-open flag, on a scratch file
 * of our own (random name, created with O_EXCL next to the lock file) rather
 * than the lock file itself, so the lock file is opened exactly once: hold the
 * scratch file exclusively, then a second open asking for the same exclusivity
 * (Windows: any open, as share mode 0 refuses them all) must be refused. The
 * answer is a property of the runtime, so it is kept for the process.
 */
function exclusiveOpenSupported(dir: string, exclusive: ExclusiveOpen): boolean {
  if (exclusiveOpenHonoured !== undefined) return exclusiveOpenHonoured;
  const { O_RDONLY, O_RDWR, O_CREAT, O_EXCL } = fs.constants;
  const scratch = path.join(dir, `.legacy-lock-probe-${process.pid}-${randomUUID()}`);
  const held = openUnlessContended(scratch, O_RDWR | O_CREAT | O_EXCL | exclusive.flags, exclusive);
  if (held === 'busy') {
    // Nobody else can know a fresh random name; treat it as unsupported.
    return false;
  }
  try {
    const probe = openUnlessContended(
      scratch,
      process.platform === 'win32' ? O_RDONLY : O_RDONLY | exclusive.flags,
      exclusive
    );
    if (probe !== 'busy') fs.closeSync(probe);
    exclusiveOpenHonoured = probe === 'busy';
    return exclusiveOpenHonoured;
  } finally {
    try {
      fs.closeSync(held);
    } catch {
      // Best-effort.
    }
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      // Best-effort: a leftover probe file is harmless.
    }
  }
}

/**
 * macOS/FreeBSD/Windows: hold the legacy lock with an exclusive open. Returns
 * the held descriptor, `busy` while an older helper holds it, or `unsupported`
 * if the runtime ignores the flag. The lock file itself is opened only once.
 */
function tryKernelLegacyLock(lockFile: string): number | 'busy' | 'unsupported' {
  const exclusive = exclusiveOpen();
  if (!exclusiveOpenSupported(path.dirname(lockFile), exclusive)) return 'unsupported';
  const { O_RDWR, O_CREAT } = fs.constants;
  return openUnlessContended(lockFile, O_RDWR | O_CREAT | exclusive.flags, exclusive);
}

/** Linux: whether any process holds a flock(2) lock on inode `ino`; undefined
 * when /proc/locks cannot be read. */
function legacyFlockHeld(ino: string): boolean | undefined {
  if (process.platform !== 'linux') return undefined;
  let table: string;
  try {
    table = fs.readFileSync('/proc/locks', 'utf8');
  } catch {
    return undefined;
  }
  for (const line of table.split('\n')) {
    // `<n>: FLOCK ADVISORY WRITE <pid> <major>:<minor>:<inode> <start> <end>`.
    // Blocked waiters read `<n>: -> FLOCK ...` and hold nothing.
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== 'FLOCK') continue;
    const id = fields[5] ?? '';
    if (id.slice(id.lastIndexOf(':') + 1) === ino) return true;
  }
  return false;
}

function readWholeFile(fd: number): string {
  const size = fs.fstatSync(fd).size;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buffer, offset, size - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset).toString('utf8');
}

async function stampLegacyLock(lockFile: string, token: string, deadline: number): Promise<LegacyLock> {
  const sentinel = `${LEGACY_SENTINEL_PREFIX}${token}"}\n`;
  const fd = fs.openSync(lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  let stamped = false;
  let closed = false;
  const release = (): void => {
    if (closed) return;
    closed = true;
    try {
      if (stamped && readWholeFile(fd) === sentinel) {
        // Marker first, then trim: the file is never empty in between.
        fs.writeSync(fd, LEGACY_LOCK_MARKER, 0);
        fs.ftruncateSync(fd, Buffer.byteLength(LEGACY_LOCK_MARKER));
        fs.fsyncSync(fd);
      }
    } catch {
      // Best-effort: older CLIs then fail closed until the next newer run.
    }
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort.
    }
  };
  try {
    const ino = fs.fstatSync(fd, { bigint: true }).ino.toString();
    for (;;) {
      let contended = false;
      try {
        const content = readWholeFile(fd);
        if (LEGACY_LOCK_MARKER.startsWith(content) || content.startsWith(LEGACY_SENTINEL_PREFIX)) {
          // In place, never by rename: older helpers lock this inode.
          fs.writeSync(fd, sentinel, 0);
          fs.ftruncateSync(fd, Buffer.byteLength(sentinel));
          stamped = true;
        }
      } catch (err) {
        // Windows enforces LockFileEx against our read/write: a holder.
        if (!isWindowsLockViolation(err)) throw err;
        contended = true;
      }
      if (!contended) contended = legacyFlockHeld(ino) === true;
      if (!contended) return { release };
      if (Date.now() >= deadline) throw legacyLockTimeout(lockFile);
      await sleep(LOCK_RETRY_MS);
    }
  } catch (err) {
    release();
    throw err;
  }
}

/** Exclude older CLI writers from the journal; see the comment above. */
async function acquireLegacyLock(lockFile: string, token: string): Promise<LegacyLock> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'win32') {
      for (;;) {
        const held = tryKernelLegacyLock(lockFile);
        if (typeof held === 'number') {
          let closed = false;
          return {
            release() {
              if (closed) return;
              closed = true;
              try {
                fs.closeSync(held);
              } catch {
                // Best-effort.
              }
            },
          };
        }
        if (held === 'unsupported') break;
        if (Date.now() >= deadline) throw legacyLockTimeout(lockFile);
        await sleep(LOCK_RETRY_MS);
      }
    }
    return await stampLegacyLock(lockFile, token, deadline);
  } catch (err) {
    if (err instanceof CleanupJournalError) throw err;
    throw new CleanupJournalError(
      'io',
      `Could not take the legacy pending-cleanup journal lock at ${lockFile}: ${describeError(err)}`
    );
  }
}

/**
 * One locked journal transaction, held in-process.
 *
 * Exclusion is a lock DIRECTORY next to the journal (`mkdir` is atomic on
 * every platform and filesystem we support), carrying an owner record
 * (`pid`, `host`, a per-transaction token) whose mtime is refreshed as a lease
 * heartbeat while the transaction is open. A holder that crashes leaves the
 * directory behind; the next contender breaks it as soon as the owner pid is
 * provably gone on this host; a holder on another host sharing the directory
 * is broken once its lease heartbeat is older than `LOCK_LEASE_MS`. Breaking
 * is serialized by a recovery lock (see `breakStaleLock`). Contenders in the
 * same process wait like any other, so concurrent updates serialize.
 *
 * After the lock directory, the transaction also takes the legacy lock on
 * `pending-cleanups.json.lock` that CLI releases up to 17.2.1 use (see the
 * comment above `LEGACY_LOCK_MARKER`), with the same timeout, so older and
 * newer CLIs never edit the journal together. It is released after the
 * journal rename, before the lock directory. The `.lock` file stays in place,
 * as it always has.
 *
 * The commit re-checks ownership after writing and syncing the replacement and
 * immediately before renaming it into place, so a holder whose lock was broken
 * out from under it never overwrites a newer journal.
 * The lock directory is removed on release (only when this transaction still
 * owns it). The journal file, its format and its durable-replacement rules are
 * unchanged.
 */
interface JournalTransaction {
  /** Abort: release the lock with the journal untouched. Idempotent. */
  abort(): Promise<void>;
  /** Commit: durably replace the journal with `payload`, then release. Throws
   * with the journal untouched if the lock was lost or the write fails. */
  commit(payload: string): Promise<void>;
}

async function beginJournalTransaction(
  lockDir: string,
  legacyLockFile: string,
  journalFile: string
): Promise<JournalTransaction> {
  const token = randomUUID();
  const owner: JournalLockOwner = { pid: process.pid, host: os.hostname(), token };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let acquired: boolean;
    try {
      acquired = createLockDir(lockDir, owner);
    } catch (err) {
      throw new CleanupJournalError(
        'io',
        `Could not take the pending-cleanup journal lock at ${lockDir}: ${describeError(err)}`
      );
    }
    if (acquired) break;
    const staleToken = staleLockToken(lockDir, Date.now());
    // Retry at once only after an abandoned lock was actually removed (or
    // vanished). Everything else — a live lock, a lock put back, a busy
    // recovery lock — falls through to the deadline and back-off, so a lock
    // that keeps being judged stale and then live cannot spin past the
    // timeout. Recovery I/O errors propagate.
    if (staleToken !== undefined && breakStaleLock(lockDir, staleToken) === 'retry') {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new CleanupJournalError(
        'locked',
        `Timed out waiting for the pending-cleanup journal lock at ${lockDir}: another agent-relay process holds it. It is released when that process finishes (or broken automatically once that process has exited); retry afterwards. If no agent-relay process is running, remove ${lockDir} and retry.`
      );
    }
    await sleep(LOCK_RETRY_MS);
  }

  const ownerFile = path.join(lockDir, LOCK_OWNER_FILE);
  const heartbeat = setInterval(() => {
    // Never refresh a lock this transaction no longer owns: that would keep a
    // successor's abandoned lock looking alive.
    if (!ownsLock(lockDir, token)) {
      clearInterval(heartbeat);
      return;
    }
    try {
      const now = new Date();
      fs.utimesSync(ownerFile, now, now);
    } catch {
      // A lost lock is detected at commit; the heartbeat itself is best-effort.
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  let legacy: LegacyLock | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    legacy?.release();
    if (ownsLock(lockDir, token)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  };

  try {
    legacy = await acquireLegacyLock(legacyLockFile, token);
  } catch (err) {
    release();
    throw err;
  }

  return {
    async abort() {
      release();
    },
    async commit(payload: string) {
      try {
        if (released || !ownsLock(lockDir, token)) {
          throw new CleanupJournalError(
            'io',
            `The pending-cleanup journal lock at ${lockDir} was lost before ${journalFile} could be committed; the journal was left unmodified.`
          );
        }
        try {
          replaceJournalDurably(journalFile, payload, () => ownsLock(lockDir, token));
        } catch (err) {
          if (err instanceof LockLostError) {
            throw new CleanupJournalError(
              'io',
              `The pending-cleanup journal lock at ${lockDir} was lost before ${journalFile} could be committed; the journal was left unmodified.`
            );
          }
          throw new CleanupJournalError(
            'io',
            `Could not commit the pending-cleanup journal at ${journalFile}: ${describeError(err)}`
          );
        }
      } finally {
        release();
      }
    },
  };
}

/** File-backed CleanupJournal in the project data dir. Paths resolve per call.
 * `dataDirOverride` exists for tests only — production callers use the default. */
export function fileCleanupJournal(dataDirOverride?: string): CleanupJournal {
  const journalFile = () => path.join(dataDirOverride ?? getProjectPaths().dataDir, 'pending-cleanups.json');

  const read = (file: string): PendingCleanupEntry[] => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new CleanupJournalError(
        'io',
        `Could not read the pending-cleanup journal at ${file}: ${describeError(err)}`
      );
    }
    return parseEntries(raw, file);
  };

  return {
    async list() {
      return read(journalFile());
    },
    async update(mutate) {
      const file = journalFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const transaction = await beginJournalTransaction(`${file}.lock.d`, `${file}.lock`, file);
      // EVERYTHING that can throw before the commit — the read, the mutator,
      // and the serialization itself — runs inside the abort-protected block,
      // or a failure would leave the lock held until this process exits.
      let payload: string;
      try {
        const next = await mutate(read(file));
        payload = `${JSON.stringify(next)}\n`;
      } catch (err) {
        await transaction.abort();
        throw err;
      }
      // The durable replacement (temp + fsync + atomic rename + dir fsync)
      // runs while this transaction still holds the lock.
      await transaction.commit(payload);
    },
  };
}
