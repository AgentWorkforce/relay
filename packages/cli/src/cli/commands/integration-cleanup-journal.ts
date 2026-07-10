import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * One locked journal transaction, delegated to the already-required Rust
 * broker binary's hidden `journal-lock` helper. The helper holds a KERNEL
 * advisory lock (flock(2) on Unix, LockFileEx on Windows via std
 * File::try_lock) on a stable lock file — created 0600 once, NEVER unlinked
 * or renamed — and ALSO performs the journal's durable replacement while the
 * lock is held: the parent never writes the journal itself, so lock
 * ownership provably spans read → mutate → atomic commit. The kernel
 * releases the lock when the helper exits or dies; the helper commits (or,
 * on an empty payload, releases untouched) when our stdin pipe reaches EOF.
 * No native addon is imported anywhere — this works identically under Node
 * and the Bun standalone, which already ships and spawns the broker binary
 * for its core commands.
 *
 * The helper owns the lock-marker rules (fsync'd v2 marker, strict-prefix
 * heal, unrecognized pre-release sentinel fails closed) and the commit
 * (temp + fsync + atomic rename + directory fsync). Exit 4 = a live holder
 * out-waited our timeout; exit 3 = sentinel; exit 2 = clap usage, i.e. an
 * older broker without the subcommand (version skew).
 */
interface JournalTransaction {
  /** Abort: release the lock with the journal untouched. Idempotent. */
  abort(): Promise<void>;
  /** Commit: hand the complete serialized journal to the helper and await
   * its durable replacement + exit. Throws with the journal untouched if the
   * helper died first or the commit fails. */
  commit(payload: string): Promise<void>;
}

async function beginJournalTransaction(lockFile: string, journalFile: string): Promise<JournalTransaction> {
  const binary = getBrokerBinaryPath();
  if (!binary) {
    throw new CleanupJournalError('io', formatBrokerNotFoundError());
  }
  const child = spawn(
    binary,
    [
      'journal-lock',
      '--file',
      lockFile,
      '--journal-file',
      journalFile,
      '--timeout-ms',
      String(LOCK_TIMEOUT_MS),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const exit = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  let exited = false;
  void exit.then(() => {
    exited = true;
  });

  // Exact framed handshake: buffer stdout until the first newline and demand
  // the line be precisely `locked` — no substring matching, and a hard
  // startup deadline that kills a wedged helper.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const deadline = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(
          new CleanupJournalError(
            'io',
            `The journal-lock helper did not complete its handshake for ${lockFile} in time and was killed.`
          )
        );
      });
    }, LOCK_TIMEOUT_MS + 2_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      if (line === 'locked') {
        settle(resolve);
      } else {
        settle(() => {
          child.kill('SIGKILL');
          reject(
            new CleanupJournalError(
              'io',
              `The journal-lock helper sent an unexpected handshake for ${lockFile}.`
            )
          );
        });
      }
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
        } else if (code === 3) {
          reject(
            new CleanupJournalError(
              'locked',
              `The pending-cleanup journal lock at ${lockFile} contains an unrecognized sentinel from an older format. Nothing was swept or overwritten; inspect and remove the file to continue.`
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

  const finish = async (payload: Buffer | undefined, failure: string): Promise<void> => {
    const committing = payload !== undefined;
    if (exited) {
      if (committing) {
        // The lock (and with it transactional isolation) is already gone; the
        // journal is untouched — surface instead of committing blind.
        throw new CleanupJournalError('io', failure);
      }
      return; // abort: nothing left to release
    }
    // The helper can die between the `exited` check and (or during) the
    // stdin write: swallow the stream error (EPIPE would otherwise be an
    // unhandled 'error' event) and never hang on an end-callback that will
    // no longer fire — the authoritative verdict is the exit code below.
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const stdin = child.stdin!;
      stdin.once('error', settle);
      void exit.then(settle);
      try {
        if (committing) {
          stdin.end(payload, settle);
        } else {
          stdin.end(settle);
        }
      } catch {
        settle();
      }
    });
    const code = await exit;
    if (committing && code !== 0) {
      throw new CleanupJournalError('io', failure);
    }
  };

  return {
    async abort() {
      if (exited) return;
      await finish(undefined, '');
    },
    async commit(payload: string) {
      // Framed envelope: magic/version + declared byte length + SHA-256 of
      // the payload. The helper commits ONLY after both validate exactly, so
      // a parent dying mid-write (partial bytes + clean EOF) can never
      // replace good journal contents with a truncated payload.
      const body = Buffer.from(payload, 'utf8');
      const digest = createHash('sha256').update(body).digest('hex');
      const framed = Buffer.concat([Buffer.from(`ARJL1\n${body.byteLength}\n${digest}\n`, 'utf8'), body]);
      await finish(
        framed,
        `The journal-lock helper was lost before the pending-cleanup journal at ${journalFile} could be committed; the journal was left unmodified.`
      );
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
      const transaction = await beginJournalTransaction(`${file}.lock`, file);
      let next: PendingCleanupEntry[];
      try {
        next = await mutate(read(file));
      } catch (err) {
        await transaction.abort();
        throw err;
      }
      // The helper performs the durable replacement (temp + fsync + atomic
      // rename + dir fsync) while it still holds the kernel lock.
      await transaction.commit(`${JSON.stringify(next)}\n`);
    },
  };
}
