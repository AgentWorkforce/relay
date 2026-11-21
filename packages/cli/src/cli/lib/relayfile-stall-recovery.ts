import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  RelayfileControlPlaneClient,
  RelayfileControlPlaneError,
  defaultRelayfileSocketPath,
  type RelayfileClientOptions,
} from '@relayfile/client';

/**
 * Error code for a control-plane daemon that accepted a connection but never
 * answered, even after a restart. Distinct from `DAEMON_UNAVAILABLE` (nothing
 * listening) so callers and users can tell "hung" from "down".
 */
export const RELAYFILE_DAEMON_STALLED = 'DAEMON_STALLED';

/**
 * True when the client gave up waiting on a daemon response (not a refused/missing socket).
 * @param err - The error to check.
 * @returns Whether the error is a control-plane request timeout.
 */
export function isRelayfileControlPlaneTimeout(err: unknown): boolean {
  return (
    err instanceof RelayfileControlPlaneError &&
    err.code === 'DAEMON_UNAVAILABLE' &&
    /timed out after \d+ms/.test(err.message)
  );
}

/** A connection-level failure (reset, refused, missing socket) rather than a timeout or an endpoint error. */
function isConnectionLoss(err: unknown): boolean {
  return (
    err instanceof RelayfileControlPlaneError &&
    err.code === 'DAEMON_UNAVAILABLE' &&
    !isRelayfileControlPlaneTimeout(err)
  );
}

/**
 * Stops the daemon serving the client's socket. `@relayfile/client` already
 * owns the pid discovery + SIGTERM + socket-release wait (used for stale
 * version replacement), but keeps it private; reuse it rather than duplicating
 * the lsof / /proc logic here.
 */
export type StopDaemon = (client: RelayfileControlPlaneClient) => Promise<void>;

/**
 * Default {@link StopDaemon}: delegates to the client's own stale-daemon stop.
 * @param client - Client bound to the hung daemon's socket.
 * @returns Resolves once the daemon has exited and released its socket.
 */
export const stopDaemonViaClient: StopDaemon = async (client) => {
  const stop = (client as unknown as { stopStaleDaemon?: () => Promise<void> }).stopStaleDaemon;
  if (typeof stop !== 'function') {
    throw new Error('the installed @relayfile/client cannot stop a running control-plane daemon');
  }
  await stop.call(client);
};

/**
 * Whether a replacement daemon could be started, checked BEFORE the running
 * one is stopped: a daemon started elsewhere must not be killed when this
 * CLI's RELAYFILE_BIN / `relayfile` cannot spawn a new one.
 */
export type CanStartReplacement = (client: RelayfileControlPlaneClient) => Promise<boolean>;

/**
 * Default {@link CanStartReplacement}: runs the configured binary's `--version`.
 * @param client - Client whose configured binary would start the replacement.
 * @returns Whether the binary ran and reported a version.
 */
export const canStartReplacementViaClient: CanStartReplacement = async (client) => {
  // `installedBinaryVersion` runs `<binary> --version` with a bounded timeout;
  // it is private in @relayfile/client, like `stopStaleDaemon`. Without it we
  // cannot prove a replacement is possible, so refuse to stop the daemon.
  const probe = (client as unknown as { installedBinaryVersion?: () => Promise<string | undefined> })
    .installedBinaryVersion;
  if (typeof probe !== 'function') return false;
  try {
    return Boolean(await probe.call(client));
  } catch {
    return false;
  }
};

/**
 * Cross-process coordination between control-plane writes and daemon
 * restarts, shared by every `agent-relay` process using the same socket.
 *
 * Every participant only ever creates and removes its OWN files, each named
 * `<pid>-<uuid>` so its owner is known from the name alone (no file is ever
 * read half-written). A file is only removed by someone else once its pid is
 * dead or it is past its maximum age, so a live owner's file is never
 * deleted out from under it. The protocol is "create yours, THEN look at the
 * others", so of any two participants at least one sees the other:
 *
 * - a restart creates its claim, THEN lists claims: it holds the restart only
 *   if its claim is the sole live one (otherwise it withdraws and backs off),
 *   THEN checks for write markers, and keeps its claim until the replacement
 *   daemon is ready;
 * - a write creates its marker, THEN looks for live restart claims; if any
 *   exist, it withdraws its marker, waits for them to clear, and tries again.
 * - a restarter that stops the daemon writes a timestamped stop record
 *   BEFORE giving up its claim; a would-be restarter that finds a stop record
 *   newer than its own stalled request knows that daemon is already gone, and
 *   uses the replacement instead of stopping it.
 *
 * So two processes can never both restart the daemon, a restart never stops
 * the replacement another process just started, no restart can stop a
 * daemon while a write is in flight on it, and no write is sent while a
 * restart is in progress — a bind can never be committed with its response
 * lost to a restart.
 */
/** Outcome of {@link WriteGuard.acquireRestart}. */
export type RestartClaim =
  | {
      kind: 'acquired';
      /**
       * Reserve the stop record; call BEFORE stopping the daemon. Throws if
       * it cannot be reserved: an unrecorded stop would let another process
       * mistake the replacement for the hung daemon and stop it too.
       */
      prepareStop: () => void;
      /** Record that the daemon was stopped; call right after the stop, before {@link release}. */
      markStopped: () => void;
      /**
       * Whether this claim is still held. A claim whose owner stopped
       * refreshing it (paused past the claim lifetime) may have been expired
       * by another process, which could since have admitted writes or taken
       * the restart; the owner must check this before every daemon operation
       * and abandon the restart when it returns false.
       */
      stillHeld: () => boolean;
      /** Give up the claim; call when the replacement is ready or the restart was abandoned. */
      release: () => void;
    }
  | { kind: 'held' }
  | { kind: 'restarted' };

const UNCOORDINATED: RestartClaim = {
  kind: 'acquired',
  prepareStop: () => {},
  markStopped: () => {},
  stillHeld: () => true,
  release: () => {},
};

export interface WriteGuard {
  /**
   * Record a write as in flight, first waiting out any restart in progress.
   * @param label - Endpoint name, for diagnostics.
   * @returns A function that clears the record; call it when the write settles.
   */
  begin(label: string): Promise<() => void>;
  /**
   * List writes currently in flight in live processes.
   * @returns One `pid label` description per write.
   */
  activeWrites(): string[];
  /**
   * Claim the exclusive right to restart the daemon. If the directory cannot
   * be used at all, the restart proceeds uncoordinated, like writes do.
   * @param since - When the stalled request was sent. A daemon stop recorded
   *   at or after this time means that request's daemon is already gone.
   * @returns `acquired` (this process restarts), `held` (another process is
   *   restarting now; wait for it), or `restarted` (another process already
   *   replaced the daemon since `since`; use the replacement, stop nothing).
   */
  acquireRestart(since: number): Promise<RestartClaim>;
  /**
   * Wait until no live process holds a restart claim.
   * @param timeoutMs - Maximum time to wait.
   * @returns Whether the claims cleared within the timeout.
   */
  waitForRestart(timeoutMs: number): Promise<boolean>;
}

/** A write marker older than this is treated as abandoned (pid reuse, killed process). */
const WRITE_MARKER_MAX_AGE_MS = 10 * 60_000;
/**
 * A restart claim not refreshed for this long is treated as abandoned, even if
 * its pid is alive (pid reuse, or an owner paused past its lifetime). A live
 * owner refreshes it every {@link RESTART_CLAIM_HEARTBEAT_MS}, so a running
 * restart is never expired however long it takes.
 */
const RESTART_CLAIM_MAX_AGE_MS = 2 * 60_000;
/** How often a held restart claim is refreshed. */
const RESTART_CLAIM_HEARTBEAT_MS = 10_000;

/** Lifetimes for {@link fileWriteGuard}; overridable for tests. */
export interface WriteGuardTimings {
  /** Restart claim lifetime without a refresh; defaults to 2 minutes. */
  claimMaxAgeMs?: number;
  /** Restart claim refresh interval; defaults to 10 seconds. */
  claimHeartbeatMs?: number;
}
/** How long a write or a second recoverer waits for another process's restart. */
export const RESTART_WAIT_MS = 30_000;
const RESTART_POLL_MS = 100;
/** Prefix of restart claim files; the leading dot keeps them out of the write markers. */
const RESTART_CLAIM_PREFIX = '.restart-';
/**
 * Prefix of daemon-stop records, `.stopped-<ms>-<pid>-<uuid>`. Written by a
 * restarter right after its stop and BEFORE it removes its claim, so whoever
 * sees the claim gone also sees the record.
 */
const STOPPED_PREFIX = '.stopped-';
/**
 * Prefix of a reserved, not yet timestamped stop record,
 * `.stopping-<pid>-<uuid>`. Created before the stop (so a stop never happens
 * unless its record can be written) and renamed to a `.stopped-` record after
 * it, so the timestamp is never earlier than a request the old daemon took.
 */
const STOPPING_PREFIX = '.stopping-';
/** Attempts to resolve a simultaneous claim (both claimants saw each other) by random backoff. */
const RESTART_CLAIM_ATTEMPTS = 5;
/** Times a recoverer waits out another process's restart before giving up. */
const RESTART_CLAIM_ROUNDS = 3;

/**
 * The coordination directory for a daemon socket: `<socket>.writes/`, beside
 * the socket so every client of that daemon shares it.
 * @param socketPath - The control-plane socket path.
 * @returns The directory path.
 */
export function writeMarkerDir(socketPath: string): string {
  return `${socketPath}.writes`;
}

/**
 * File-backed {@link WriteGuard} implementing the protocol above. Recording is
 * best-effort: if the directory cannot be written, writes and restarts still
 * proceed (uncoordinated, but never blocked).
 * @param dir - Coordination directory, normally {@link writeMarkerDir}.
 * @param restartWaitMs - How long {@link WriteGuard.begin} waits out a restart.
 * @param timings - Claim lifetime and refresh interval.
 * @returns The guard.
 */
export function fileWriteGuard(
  dir: string,
  restartWaitMs: number = RESTART_WAIT_MS,
  timings: WriteGuardTimings = {}
): WriteGuard {
  const claimMaxAgeMs = timings.claimMaxAgeMs ?? RESTART_CLAIM_MAX_AGE_MS;
  const claimHeartbeatMs = timings.claimHeartbeatMs ?? RESTART_CLAIM_HEARTBEAT_MS;
  /**
   * Live files with `prefix`, as `{ name, pid }`. Files of dead pids, or past
   * `maxAgeMs`, are removed: their owner can no longer be using them.
   */
  const liveFiles = (prefix: string, maxAgeMs: number): Array<{ name: string; pid: number }> => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const live: Array<{ name: string; pid: number }> = [];
    for (const name of names) {
      if (prefix ? !name.startsWith(prefix) : name.startsWith('.')) continue;
      const path = join(dir, name);
      const pid = Number.parseInt(name.slice(prefix.length).split('-')[0] ?? '', 10);
      let fresh: boolean;
      try {
        fresh = Date.now() - statSync(path).mtimeMs < maxAgeMs;
      } catch {
        continue; // removed while scanning
      }
      if (Number.isSafeInteger(pid) && pid > 0 && fresh && isProcessAlive(pid)) {
        live.push({ name, pid });
      } else {
        rmSync(path, { force: true });
      }
    }
    return live;
  };

  const liveClaims = () => liveFiles(RESTART_CLAIM_PREFIX, claimMaxAgeMs);

  /** Whether any process stopped the daemon at or after `since` (expiring old records). */
  const stoppedSince = (since: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    let stopped = false;
    for (const name of names) {
      if (name.startsWith(STOPPING_PREFIX)) {
        // Reservation of a restarter that died mid-restart: expire it.
        const path = join(dir, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > RESTART_CLAIM_MAX_AGE_MS) rmSync(path, { force: true });
        } catch {
          // Removed while scanning.
        }
        continue;
      }
      if (!name.startsWith(STOPPED_PREFIX)) continue;
      const at = Number.parseInt(name.slice(STOPPED_PREFIX.length).split('-')[0] ?? '', 10);
      if (!Number.isSafeInteger(at) || Date.now() - at > RESTART_CLAIM_MAX_AGE_MS) {
        rmSync(join(dir, name), { force: true });
      } else if (at >= since) {
        stopped = true;
      }
    }
    return stopped;
  };

  const waitForRestart = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (liveClaims().length > 0) {
      if (Date.now() >= deadline) return false;
      await sleep(RESTART_POLL_MS);
    }
    return true;
  };

  return {
    async begin(label) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        return () => {};
      }
      for (;;) {
        const marker = join(dir, `${process.pid}-${randomUUID()}`);
        try {
          writeFileSync(marker, label, { flag: 'wx', mode: 0o600 });
        } catch {
          return () => {};
        }
        // Marker first, THEN the claims: a restart that claimed before our
        // marker existed is seen here; one that claims after sees our marker.
        if (liveClaims().length === 0) {
          return () => rmSync(marker, { force: true });
        }
        rmSync(marker, { force: true });
        if (!(await waitForRestart(restartWaitMs))) {
          throw new RelayfileControlPlaneError(
            RELAYFILE_DAEMON_STALLED,
            `relayfile control-plane is being restarted by another relay command and did not come back within ` +
              `${restartWaitMs}ms; ${label} was not sent. Retry shortly.`
          );
        }
      }
    },
    activeWrites() {
      return liveFiles('', WRITE_MARKER_MAX_AGE_MS).map(({ name, pid }) =>
        `pid ${pid} ${readLabel(join(dir, name))}`.trim()
      );
    },
    async acquireRestart(since) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        return UNCOORDINATED;
      }
      for (let attempt = 0; attempt < RESTART_CLAIM_ATTEMPTS; attempt += 1) {
        const name = `${RESTART_CLAIM_PREFIX}${process.pid}-${randomUUID()}`;
        const claim = join(dir, name);
        try {
          writeFileSync(claim, '', { flag: 'wx', mode: 0o600 });
        } catch {
          return UNCOORDINATED;
        }
        // Claim first, THEN look: of two simultaneous claimants, at least one
        // sees the other, so both can never hold the restart.
        const others = liveClaims().filter((c) => c.name !== name);
        if (others.length === 0) {
          // Sole claimant — but if another process already stopped the daemon
          // this request hung on (its stop record is written before its claim
          // is removed), the current daemon is its healthy replacement: do not
          // stop it.
          if (stoppedSince(since)) {
            rmSync(claim, { force: true });
            return { kind: 'restarted' };
          }
          const suffix = `${process.pid}-${randomUUID()}`;
          const reserved = join(dir, `${STOPPING_PREFIX}${suffix}`);
          let isReserved = false;
          // Keep the claim fresh while this process runs, so a long restart is
          // never expired. A missing claim is never re-created: once expired,
          // this owner is fenced (see stillHeld).
          const heartbeat = setInterval(() => {
            try {
              const now = new Date();
              utimesSync(claim, now, now);
            } catch {
              clearInterval(heartbeat);
            }
          }, claimHeartbeatMs);
          heartbeat.unref();
          return {
            kind: 'acquired',
            prepareStop: () => {
              writeFileSync(reserved, '', { flag: 'wx', mode: 0o600 });
              isReserved = true;
            },
            markStopped: () => {
              const record = join(dir, `${STOPPED_PREFIX}${Date.now()}-${suffix}`);
              try {
                // Renaming within the directory needs no new space, so a
                // reserved record can always be published.
                if (isReserved) renameSync(reserved, record);
                else writeFileSync(record, '', { flag: 'wx', mode: 0o600 });
                isReserved = false;
              } catch {
                // Nothing more can be done; the claim still guards until release.
              }
            },
            // Claims are only ever deleted by their owner or on expiry, and
            // names are unique, so "still on disk" means "never expired": no
            // other process could have admitted a write or taken the restart.
            stillHeld: () => existsSync(claim),
            release: () => {
              clearInterval(heartbeat);
              if (isReserved) rmSync(reserved, { force: true });
              rmSync(claim, { force: true });
            },
          };
        }
        rmSync(claim, { force: true });
        // A genuine holder keeps its claim for the whole restart; a
        // simultaneous claimant withdraws at once. Back off with jitter and
        // look again, so a collision resolves while a real restart is waited on.
        await sleep(20 + Math.floor(Math.random() * 80));
        // If the holder finished during the backoff, the next round finds no
        // other claim and its stop record, and reports `restarted`.
        // Someone still claims it: a restart in progress (or the winner of
        // the collision). Let the caller wait for it.
        if (liveClaims().length > 0) return { kind: 'held' };
      }
      return { kind: 'held' };
    },
    waitForRestart,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLabel(marker: string): string {
  try {
    return readFileSync(marker, 'utf8').trim().slice(0, 64);
  } catch {
    return '';
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type RecoveryPhase = 'busy' | 'preflight' | 'stop' | 'start';

/** A recovery step that failed, so the caller can give the matching remedy. */
class RecoveryFailure extends Error {
  constructor(
    readonly phase: RecoveryPhase,
    message: string
  ) {
    super(message);
  }
}

/** Configuration for {@link RecoveringControlPlane}. */
export interface RecoveringControlPlaneOptions {
  /** Options for every client created, including replacements. */
  clientOptions: RelayfileClientOptions;
  /** Client factory; defaults to `new RelayfileControlPlaneClient`. */
  createClient?: (options: RelayfileClientOptions) => RelayfileControlPlaneClient;
  /** Stops a hung daemon; defaults to {@link stopDaemonViaClient}. */
  stopDaemon?: StopDaemon;
  /** Preflight before stopping; defaults to {@link canStartReplacementViaClient}. */
  canStartReplacement?: CanStartReplacement;
  /** In-flight write record; defaults to {@link fileWriteGuard} beside the socket. */
  writeGuard?: WriteGuard;
  /** How long to wait for another process's restart; defaults to {@link RESTART_WAIT_MS}. */
  restartWaitMs?: number;
  /** Diagnostics sink for the recovery notice; defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Wraps a control-plane client so a request that times out against a daemon
 * that is alive but hung is recovered: the daemon is stopped, a fresh client
 * auto-starts a new one, and the request is retried once. Only safe-to-repeat
 * operations go through {@link RecoveringControlPlane.run}; writes go through
 * {@link RecoveringControlPlane.mutate}, which is never retried and holds off
 * recovery while it is in flight.
 *
 * Without this, a daemon that wedges after serving earlier requests turns every
 * subscribe into a generic 30s timeout while `relayfile integration list`
 * (which bypasses the daemon) still reports healthy (#1952).
 */
export class RecoveringControlPlane {
  #client: RelayfileControlPlaneClient;
  readonly #options: RecoveringControlPlaneOptions;
  readonly #autoStart: boolean;
  readonly #writeGuard: WriteGuard;
  readonly #restartWaitMs: number;
  #recovery: Promise<void> | undefined;
  /** The client whose daemon the in-flight recovery is replacing. */
  #recoveringFrom: RelayfileControlPlaneClient | undefined;

  /**
   * @param options - Client options and injectable recovery steps.
   */
  constructor(options: RecoveringControlPlaneOptions) {
    this.#options = options;
    this.#client = this.#create();
    this.#autoStart = options.clientOptions.autoStart ?? process.env.RELAYFILE_REQUIRE_DAEMON !== '1';
    this.#restartWaitMs = options.restartWaitMs ?? RESTART_WAIT_MS;
    this.#writeGuard =
      options.writeGuard ??
      fileWriteGuard(
        writeMarkerDir(options.clientOptions.socketPath ?? defaultRelayfileSocketPath()),
        this.#restartWaitMs
      );
  }

  /** The current client. Replaced after a recovery, so don't cache it. */
  get client(): RelayfileControlPlaneClient {
    return this.#client;
  }

  /**
   * Runs an idempotent request, recovering once from a stalled daemon.
   * @param label - endpoint name used in diagnostics (e.g. `provider-status`)
   * @param op - the request; receives the client to use for this attempt
   * @returns the request's result
   */
  async run<T>(label: string, op: (client: RelayfileControlPlaneClient) => Promise<T>): Promise<T> {
    // Pin the client this attempt used: recovery must only ever replace the
    // daemon *this* client stalled on, never a replacement another caller
    // already started.
    const attempted = this.#client;
    // When the request was sent: a daemon stop recorded after this means
    // the daemon it hung on is already gone.
    const sentAt = Date.now();
    try {
      return await op(attempted);
    } catch (err) {
      if (isRelayfileControlPlaneTimeout(err)) {
        return this.#recoverAndRetry(label, op, attempted, sentAt, err as RelayfileControlPlaneError);
      }
      if (this.#interruptedByRecovery(attempted, err)) {
        // This read was still in flight on the daemon another caller's
        // recovery stopped; its reset is not a real failure.
        return this.#retryAfterSharedRecovery(label, op, err as RelayfileControlPlaneError);
      }
      throw err;
    }
  }

  /**
   * Runs a write. Writes are never retried (a lost response may still have
   * been committed) and are recorded in the {@link WriteGuard} so no
   * recovery — in this or another process — stops the daemon under them.
   * @param label - endpoint name used in diagnostics (e.g. `bind`)
   * @param op - the request; receives the client to use
   * @returns the request's result
   */
  async mutate<T>(label: string, op: (client: RelayfileControlPlaneClient) => Promise<T>): Promise<T> {
    // A write issued while this process is replacing the daemon goes to the
    // replacement, not the daemon being stopped.
    if (this.#recovery) await this.#recovery.catch(() => {});
    // Waits out a restart another relay process is running on this daemon.
    const end = await this.#writeGuard.begin(label);
    try {
      return await op(this.#client);
    } finally {
      end();
    }
  }

  async #recoverAndRetry<T>(
    label: string,
    op: (client: RelayfileControlPlaneClient) => Promise<T>,
    attempted: RelayfileControlPlaneClient,
    sentAt: number,
    first: RelayfileControlPlaneError
  ): Promise<T> {
    if (!this.#autoStart) {
      throw stalledError(
        label,
        first,
        'Automatic restart is disabled (RELAYFILE_REQUIRE_DAEMON=1); restart `relayfile control-plane serve` and retry.'
      );
    }
    try {
      await this.#recover(attempted, label, sentAt);
    } catch (recoveryErr) {
      throw stalledError(label, first, recoveryRemedy(recoveryErr));
    }
    return this.#retry(label, op);
  }

  async #retryAfterSharedRecovery<T>(
    label: string,
    op: (client: RelayfileControlPlaneClient) => Promise<T>,
    interrupted: RelayfileControlPlaneError
  ): Promise<T> {
    if (this.#recovery) {
      try {
        await this.#recovery;
      } catch (recoveryErr) {
        throw stalledError(label, interrupted, recoveryRemedy(recoveryErr));
      }
    }
    return this.#retry(label, op);
  }

  /** The single retry on the current (replacement) client. */
  async #retry<T>(label: string, op: (client: RelayfileControlPlaneClient) => Promise<T>): Promise<T> {
    try {
      return await op(this.#client);
    } catch (retryErr) {
      if (!isRelayfileControlPlaneTimeout(retryErr)) throw retryErr;
      throw stalledError(
        label,
        retryErr as RelayfileControlPlaneError,
        'It also stalled after an automatic restart, so the hang is likely upstream of the daemon (Cloud/provider); retry later.'
      );
    }
  }

  /** A connection loss on a client whose daemon is being, or has been, replaced. */
  #interruptedByRecovery(attempted: RelayfileControlPlaneClient, err: unknown): boolean {
    if (!isConnectionLoss(err)) return false;
    return this.#recoveringFrom === attempted || this.#client !== attempted;
  }

  /**
   * Single-flight daemon replacement. Concurrent reads that stall on the same
   * daemon (e.g. per-workspace subscription listings fanned out with
   * Promise.all) share one stop + restart; a caller whose stalled client was
   * already replaced just retries on the replacement instead of stopping it.
   */
  #recover(stalled: RelayfileControlPlaneClient, label: string, sentAt: number): Promise<void> {
    if (this.#client !== stalled) return Promise.resolve();
    if (!this.#recovery) {
      this.#recoveringFrom = stalled;
      this.#recovery = (async () => {
        // 1. Claim the restart across processes. New writes in any relay
        // process wait while the claim is held, so none can start between the
        // write check below and the replacement being ready.
        let claim = await this.#writeGuard.acquireRestart(sentAt);
        for (let round = 1; claim.kind === 'held' && round < RESTART_CLAIM_ROUNDS; round += 1) {
          // Another process is replacing the daemon now: wait for it, then
          // ask again — its stop record tells us whether it actually replaced
          // the daemon this request hung on, or gave up and left it to us.
          if (!(await this.#writeGuard.waitForRestart(this.#restartWaitMs))) {
            throw new RecoveryFailure('busy', 'another relay command is restarting the daemon');
          }
          claim = await this.#writeGuard.acquireRestart(sentAt);
        }
        if (claim.kind === 'held') {
          throw new RecoveryFailure('busy', 'another relay command is restarting the daemon');
        }
        if (claim.kind === 'restarted') {
          // The daemon this request hung on was already replaced by another
          // process: use the replacement and stop nothing.
          await this.#install(this.#create());
          return;
        }
        try {
          // 2. Never stop a working daemon we cannot replace. Only needed when
          // this process will stop it: reusing another process's replacement
          // (`restarted` above) needs no local binary.
          const canStart = await (this.#options.canStartReplacement ?? canStartReplacementViaClient)(stalled);
          if (!canStart) {
            throw new RecoveryFailure(
              'preflight',
              'the relayfile binary (RELAYFILE_BIN or `relayfile` on PATH) could not be run'
            );
          }
          // 3. Reserve the stop record: a stop nobody can see would let
          // another process take its replacement for the hung daemon.
          try {
            claim.prepareStop();
          } catch (err) {
            throw new RecoveryFailure('busy', `the restart could not be recorded (${describe(err)})`);
          }
          // 4. Fence, then make sure no write is in flight, immediately before
          // the stop. A claim still on disk was never expired, so no other
          // process admitted a write or took the restart meanwhile; a write
          // that began before the claim is seen here, one after it waits.
          this.#assertStillHeld(claim);
          const writes = this.#writeGuard.activeWrites();
          if (writes.length > 0) {
            throw new RecoveryFailure(
              'busy',
              `another relay command has a write in flight on it (${writes.join(', ')})`
            );
          }
          // 5. Stop the hung daemon, and record it before giving up the claim.
          try {
            await (this.#options.stopDaemon ?? stopDaemonViaClient)(stalled);
          } catch (err) {
            throw new RecoveryFailure('stop', describe(err));
          }
          claim.markStopped();
          // 6. Start the replacement and prove it is up, still under the
          // claim — unless the claim expired during the stop, in which case
          // another process now owns the restart and starts the replacement.
          this.#assertStillHeld(claim);
          await this.#install(this.#create());
        } finally {
          claim.release();
        }
        (this.#options.warn ?? defaultWarn)(
          `relayfile control-plane did not answer ${label}; restarted the daemon and retrying.`
        );
      })().finally(() => {
        this.#recovery = undefined;
        this.#recoveringFrom = undefined;
      });
    }
    return this.#recovery;
  }

  /** Abandon the restart if this process's claim expired while it was paused. */
  #assertStillHeld(claim: { stillHeld: () => boolean }): void {
    if (!claim.stillHeld()) {
      throw new RecoveryFailure(
        'busy',
        'this command paused past its restart claim, which may now belong to another relay command'
      );
    }
  }

  /**
   * Switch to `replacement` and wait for its daemon. A fresh client re-runs
   * hello negotiation and auto-starts the daemon. It is installed even if that
   * fails, so the next call auto-starts instead of reusing a client bound to a
   * stopped daemon.
   */
  async #install(replacement: RelayfileControlPlaneClient): Promise<void> {
    this.#client = replacement;
    try {
      await replacement.ensureReady();
    } catch (err) {
      throw new RecoveryFailure('start', describe(err));
    }
  }

  #create(): RelayfileControlPlaneClient {
    const create = this.#options.createClient ?? ((o) => new RelayfileControlPlaneClient(o));
    return create(this.#options.clientOptions);
  }
}

function stalledError(
  label: string,
  cause: RelayfileControlPlaneError,
  remedy: string
): RelayfileControlPlaneError {
  return new RelayfileControlPlaneError(
    RELAYFILE_DAEMON_STALLED,
    `relayfile control-plane stalled on ${label}: ${cause.message}. ${remedy}`,
    cause.status
  );
}

function recoveryRemedy(err: unknown): string {
  const phase = err instanceof RecoveryFailure ? err.phase : 'stop';
  switch (phase) {
    case 'busy':
      return (
        `Left the daemon running because ${describe(err)}; ` +
        'retry once it finishes, or restart `relayfile control-plane serve` manually.'
      );
    case 'preflight':
      return (
        `Left the daemon running because no replacement could be started (${describe(err)}); ` +
        'fix RELAYFILE_BIN or install relayfile, or restart `relayfile control-plane serve` manually, then retry.'
      );
    case 'start':
      return (
        `Stopped the hung daemon, but its replacement did not start (${describe(err)}); ` +
        'run `relayfile control-plane serve` and retry.'
      );
    default:
      return (
        `Could not restart it automatically (${describe(err)}); ` +
        'stop the running `relayfile control-plane serve` process and retry.'
      );
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}
