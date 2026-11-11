import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * Protocol (each side writes its own file BEFORE reading the other's, so at
 * least one always observes the other):
 * - a restart takes the exclusive restart lock, THEN checks for write
 *   markers, and backs off if any exist; it holds the lock until the
 *   replacement daemon is ready;
 * - a write creates its marker, THEN checks the restart lock; if a restart
 *   holds it, the write withdraws its marker, waits for the restart to
 *   finish, and tries again.
 *
 * So no restart can stop a daemon while a write is in flight on it, and no
 * write is sent while a restart is in progress — a bind can never be
 * committed with its response lost to a restart.
 */
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
   * Take the exclusive restart lock. If the directory cannot be used at all,
   * the restart proceeds uncoordinated (a no-op release), like writes do.
   * @returns A release function, or `undefined` when another live process holds it.
   */
  acquireRestart(): (() => void) | undefined;
  /**
   * Wait until no live process holds the restart lock.
   * @param timeoutMs - Maximum time to wait.
   * @returns Whether the lock was released within the timeout.
   */
  waitForRestart(timeoutMs: number): Promise<boolean>;
}

/** A write marker older than this is treated as abandoned (pid reuse, killed process). */
const WRITE_MARKER_MAX_AGE_MS = 10 * 60_000;
/**
 * A restart lock older than this is treated as abandoned. A restart is
 * bounded by the client's stop (<= 10s) and start (default 5s) budgets.
 */
const RESTART_LOCK_MAX_AGE_MS = 2 * 60_000;
/** How long a write or a second recoverer waits for another process's restart. */
export const RESTART_WAIT_MS = 30_000;
const RESTART_POLL_MS = 100;
const RESTART_LOCK_NAME = '.restart.lock';

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
 * File-backed {@link WriteGuard}: one marker file per in-flight write, named
 * with the writer's pid, plus an exclusive-create restart lock. Markers and
 * locks from dead processes, or past their maximum age, are ignored and
 * removed. Recording is best-effort: if the directory cannot be written, the
 * write still proceeds (it cannot be coordinated, but is never blocked).
 * @param dir - Coordination directory, normally {@link writeMarkerDir}.
 * @param restartWaitMs - How long {@link WriteGuard.begin} waits out a restart.
 * @returns The guard.
 */
export function fileWriteGuard(dir: string, restartWaitMs: number = RESTART_WAIT_MS): WriteGuard {
  const lockPath = join(dir, RESTART_LOCK_NAME);

  /** The live process holding the restart lock, clearing an abandoned lock. */
  const restartHolder = (): number | undefined => {
    let pid: number;
    let fresh: boolean;
    try {
      pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
      fresh = Date.now() - statSync(lockPath).mtimeMs < RESTART_LOCK_MAX_AGE_MS;
    } catch {
      return undefined; // no lock
    }
    if (Number.isSafeInteger(pid) && pid > 0 && fresh && isProcessAlive(pid)) return pid;
    rmSync(lockPath, { force: true });
    return undefined;
  };

  const waitForRestart = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (restartHolder() !== undefined) {
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
          writeFileSync(marker, label, { mode: 0o600 });
        } catch {
          return () => {};
        }
        // Marker first, THEN the lock: a restart that took the lock before
        // our marker existed is seen here; one that takes it after sees us.
        if (restartHolder() === undefined) {
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
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const active: string[] = [];
      for (const name of names) {
        if (name.startsWith('.')) continue; // the restart lock
        const marker = join(dir, name);
        const pid = Number.parseInt(name.split('-')[0] ?? '', 10);
        let fresh: boolean;
        try {
          fresh = Date.now() - statSync(marker).mtimeMs < WRITE_MARKER_MAX_AGE_MS;
        } catch {
          continue; // removed while scanning
        }
        if (Number.isSafeInteger(pid) && pid > 0 && fresh && isProcessAlive(pid)) {
          active.push(`pid ${pid} ${readLabel(marker)}`.trim());
        } else {
          rmSync(marker, { force: true });
        }
      }
      return active;
    },
    acquireRestart() {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        return () => {};
      }
      // Two tries: the second follows clearing an abandoned lock.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
          return () => rmSync(lockPath, { force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => {};
          if (restartHolder() !== undefined) return undefined;
        }
      }
      return undefined;
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
    try {
      return await op(attempted);
    } catch (err) {
      if (isRelayfileControlPlaneTimeout(err)) {
        return this.#recoverAndRetry(label, op, attempted, err as RelayfileControlPlaneError);
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
      await this.#recover(attempted, label);
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
  #recover(stalled: RelayfileControlPlaneClient, label: string): Promise<void> {
    if (this.#client !== stalled) return Promise.resolve();
    if (!this.#recovery) {
      this.#recoveringFrom = stalled;
      this.#recovery = (async () => {
        // 1. Never stop a working daemon we cannot replace.
        const canStart = await (this.#options.canStartReplacement ?? canStartReplacementViaClient)(stalled);
        if (!canStart) {
          throw new RecoveryFailure(
            'preflight',
            'the relayfile binary (RELAYFILE_BIN or `relayfile` on PATH) could not be run'
          );
        }
        // 2. Take the cross-process restart lock. New writes in any relay
        // process wait while it is held, so none can start between the
        // write check below and the replacement being ready.
        const release = this.#writeGuard.acquireRestart();
        if (!release) {
          // Another process is already replacing this daemon: wait for it and
          // use its replacement rather than stopping that one too.
          if (!(await this.#writeGuard.waitForRestart(this.#restartWaitMs))) {
            throw new RecoveryFailure('busy', 'another relay command is restarting the daemon');
          }
          await this.#install(this.#create());
          return;
        }
        try {
          // 3. Never stop a daemon while any relay process has a write in
          // flight on it. Checked after taking the lock: a write that began
          // first is seen here; one that begins later sees the lock and waits.
          const writes = this.#writeGuard.activeWrites();
          if (writes.length > 0) {
            throw new RecoveryFailure(
              'busy',
              `another relay command has a write in flight on it (${writes.join(', ')})`
            );
          }
          // 4. Stop the hung daemon.
          try {
            await (this.#options.stopDaemon ?? stopDaemonViaClient)(stalled);
          } catch (err) {
            throw new RecoveryFailure('stop', describe(err));
          }
          // 5. Start the replacement and prove it is up, still under the lock.
          await this.#install(this.#create());
        } finally {
          release();
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
