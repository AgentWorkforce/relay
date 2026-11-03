import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectPaths } from '@agent-relay/config';

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
 * entries. A corrupt or unreadable journal FAILS
 * CLOSED: reads throw, nothing is swept, and callers abort before creating
 * new external resources.
 *
 * Attempt entries carry the inbound-target `url`, which may be capability
 * bearing — callers must never log entry urls or ids (the 0600 file is their
 * only home).
 */

export type PendingCleanupKind =
  | 'relayfile-webhook-subscription'
  | 'relay-webhook'
  | 'relay-subscription'
  | 'subscribe-attempt';

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

function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
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
 * directory older than the orphan window), or undefined while the lock is live. An ownerless stale lock yields the empty token.
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

/**
 * Break an abandoned lock. The directory is first renamed aside (atomic), then
 * judged again where it now lies: if a live contender re-took the lock, or the
 * holder refreshed its heartbeat, between our staleness check and the rename,
 * it is put back instead of being deleted.
 */
function breakStaleLock(lockDir: string, staleToken: string): void {
  const tombstone = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockDir, tombstone);
  } catch {
    return; // someone else broke (or released) it first
  }
  const moved = readLockOwner(tombstone);
  const stillStale = staleLockToken(tombstone, Date.now()) === staleToken;
  if ((moved?.owner.token ?? '') !== staleToken || !stillStale) {
    try {
      fs.renameSync(tombstone, lockDir);
      return;
    } catch {
      // A third contender already holds a fresh lock; the one we moved is
      // superseded either way.
    }
  }
  fs.rmSync(tombstone, { recursive: true, force: true });
}

/** Whether this process still owns `lockDir` under `token`. */
function ownsLock(lockDir: string, token: string): boolean {
  return readLockOwner(lockDir)?.owner.token === token;
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

/**
 * One locked journal transaction, held in-process.
 *
 * Exclusion is a lock DIRECTORY next to the journal (`mkdir` is atomic on
 * every platform and filesystem we support), carrying an owner record
 * (`pid`, `host`, a per-transaction token) whose mtime is refreshed as a lease
 * heartbeat while the transaction is open. A holder that crashes leaves the
 * directory behind; the next contender breaks it as soon as the owner pid is
 * provably gone on this host; a holder on another host sharing the directory
 * is broken once its lease heartbeat is older than `LOCK_LEASE_MS`. Contenders in the
 * same process wait like any other, so concurrent updates serialize.
 *
 * The commit re-checks ownership after writing and syncing the replacement and
 * immediately before renaming it into place, so a holder whose lock was broken
 * out from under it never overwrites a newer journal.
 * The lock directory is removed on release (only when this transaction still
 * owns it).
 */
interface JournalTransaction {
  /** Abort: release the lock with the journal untouched. Idempotent. */
  abort(): Promise<void>;
  /** Commit: durably replace the journal with `payload`, then release. Throws
   * with the journal untouched if the lock was lost or the write fails. */
  commit(payload: string): Promise<void>;
}

async function beginJournalTransaction(lockDir: string, journalFile: string): Promise<JournalTransaction> {
  const token = randomUUID();
  const owner: JournalLockOwner = { pid: process.pid, host: os.hostname(), token };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner), { mode: 0o600 });
      } catch (err) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (!isLockContention(err)) {
        throw new CleanupJournalError(
          'io',
          `Could not take the pending-cleanup journal lock at ${lockDir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const staleToken = staleLockToken(lockDir, Date.now());
    if (staleToken !== undefined) {
      breakStaleLock(lockDir, staleToken);
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

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (ownsLock(lockDir, token)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  };

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
            `Could not commit the pending-cleanup journal at ${journalFile}: ${err instanceof Error ? err.message : String(err)}`
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
        `Could not read the pending-cleanup journal at ${file}: ${err instanceof Error ? err.message : String(err)}`
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
      const transaction = await beginJournalTransaction(`${file}.lock.d`, file);
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
