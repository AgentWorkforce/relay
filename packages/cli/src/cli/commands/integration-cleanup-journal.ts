import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectPaths } from '@agent-relay/config';
import { formatBrokerNotFoundError, getBrokerBinaryPath } from '@agent-relay/harness-driver/broker-path';

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
 * read-modify-write runs under an exclusive lockfile so concurrent CLI
 * processes cannot lose entries. A corrupt or unreadable journal FAILS
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
    isNonEmptyString(candidate.attemptId)
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

/**
 * Take the exclusive journal lock by spawning the already-required Rust
 * broker binary's hidden `journal-lock` helper, which holds a KERNEL
 * advisory lock (flock(2) on Unix, LockFileEx on Windows via std
 * File::try_lock) on a stable lock file: created 0600 once, NEVER unlinked
 * or renamed. The kernel releases the lock when the helper exits or dies;
 * the helper exits when our stdin pipe reaches EOF, so a crash of EITHER
 * process releases the lock. No native addon is imported anywhere — this
 * works identically under Node and the Bun standalone, which already ships
 * and spawns the broker binary for its core commands.
 *
 * The helper owns the marker rules: it stamps/fsyncs the v2 marker, heals a
 * crash-truncated marker (strict prefix), and FAILS CLOSED (exit 3) on an
 * unrecognized pre-release sentinel, preserving the file untouched. Exit 2
 * means a live holder out-waited our timeout.
 */
async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
  const binary = getBrokerBinaryPath();
  if (!binary) {
    throw new CleanupJournalError('io', formatBrokerNotFoundError());
  }
  const child = spawn(binary, ['journal-lock', '--file', lockFile, '--timeout-ms', String(LOCK_TIMEOUT_MS)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const exit = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('locked')) settle(resolve);
    });
    child.on('error', (err) =>
      settle(() =>
        reject(
          new CleanupJournalError('io', `Could not spawn the journal-lock helper (${binary}): ${err.message}`)
        )
      )
    );
    void exit.then((code) => {
      settle(() => {
        if (code === 4) {
          reject(
            new CleanupJournalError(
              'locked',
              `Timed out waiting for the pending-cleanup journal lock at ${lockFile}: another agent-relay process holds it. The kernel releases it automatically when that process exits; retry afterwards.`
            )
          );
        } else if (code === 2) {
          // clap usage error: this broker binary predates the journal-lock
          // helper (version skew), or the invocation is malformed.
          reject(
            new CleanupJournalError(
              'io',
              `The resolved agent-relay-broker binary (${binary}) does not support the journal-lock helper; upgrade the broker (or set AGENT_RELAY_BIN to a current build) and retry.`
            )
          );
        } else if (code === 3) {
          reject(
            new CleanupJournalError(
              'locked',
              `The pending-cleanup journal lock at ${lockFile} contains an unrecognized sentinel from an older format. Nothing was swept or overwritten; inspect and remove the file to continue.`
            )
          );
        } else {
          reject(
            new CleanupJournalError(
              'io',
              `The journal-lock helper exited unexpectedly (code ${code ?? 'unknown'}) before acquiring ${lockFile}.`
            )
          );
        }
      });
    });
  });

  // Release = close the helper's stdin (it exits on EOF) and AWAIT its exit
  // so the kernel lock is provably gone before update() returns.
  return async () => {
    try {
      child.stdin!.end();
    } catch {
      // The helper already died; its kernel lock died with it.
    }
    await exit;
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

  /** Crash-durable replace: write+fsync temp, atomic rename, fsync parent dir
   * so the rename itself survives a host/power crash. */
  const write = (file: string, entries: PendingCleanupEntry[]): void => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(entries)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    let dirFd: number | undefined;
    try {
      dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      // Directory fsync is unsupported on some platforms (e.g. Windows);
      // the data fsync above already ran, so proceed.
    } finally {
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
  };

  return {
    async list() {
      return read(journalFile());
    },
    async update(mutate) {
      const file = journalFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const release = await acquireLock(`${file}.lock`);
      try {
        write(file, await mutate(read(file)));
      } finally {
        await release();
      }
    },
  };
}
