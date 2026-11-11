import {
  RelayfileControlPlaneClient,
  RelayfileControlPlaneError,
  type RelayfileClientOptions,
} from '@relayfile/client';

/**
 * Error code for a control-plane daemon that accepted a connection but never
 * answered, even after a restart. Distinct from `DAEMON_UNAVAILABLE` (nothing
 * listening) so callers and users can tell "hung" from "down".
 */
export const RELAYFILE_DAEMON_STALLED = 'DAEMON_STALLED';

/** True when the client gave up waiting on a daemon response (not a refused/missing socket). */
export function isRelayfileControlPlaneTimeout(err: unknown): boolean {
  return (
    err instanceof RelayfileControlPlaneError &&
    err.code === 'DAEMON_UNAVAILABLE' &&
    /timed out after \d+ms/.test(err.message)
  );
}

/**
 * Stops the daemon serving the client's socket. `@relayfile/client` already
 * owns the pid discovery + SIGTERM + socket-release wait (used for stale
 * version replacement), but keeps it private; reuse it rather than duplicating
 * the lsof / /proc logic here.
 */
export type StopDaemon = (client: RelayfileControlPlaneClient) => Promise<void>;

export const stopDaemonViaClient: StopDaemon = async (client) => {
  const stop = (client as unknown as { stopStaleDaemon?: () => Promise<void> }).stopStaleDaemon;
  if (typeof stop !== 'function') {
    throw new Error('the installed @relayfile/client cannot stop a running control-plane daemon');
  }
  await stop.call(client);
};

export interface RecoveringControlPlaneOptions {
  clientOptions: RelayfileClientOptions;
  createClient?: (options: RelayfileClientOptions) => RelayfileControlPlaneClient;
  stopDaemon?: StopDaemon;
  /** Diagnostics sink for the recovery notice; defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Wraps a control-plane client so a request that times out against a daemon
 * that is alive but hung is recovered: the daemon is stopped, a fresh client
 * auto-starts a new one, and the request is retried once. Only safe-to-repeat
 * operations should go through {@link RecoveringControlPlane.run}.
 *
 * Without this, a daemon that wedges after serving earlier requests turns every
 * subscribe into a generic 30s timeout while `relayfile integration list`
 * (which bypasses the daemon) still reports healthy (#1952).
 */
export class RecoveringControlPlane {
  #client: RelayfileControlPlaneClient;
  readonly #options: RecoveringControlPlaneOptions;
  readonly #autoStart: boolean;
  #recovery: Promise<void> | undefined;

  constructor(options: RecoveringControlPlaneOptions) {
    this.#options = options;
    this.#client = this.#create();
    this.#autoStart = options.clientOptions.autoStart ?? process.env.RELAYFILE_REQUIRE_DAEMON !== '1';
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
      if (!isRelayfileControlPlaneTimeout(err)) throw err;
      const first = err as RelayfileControlPlaneError;

      if (!this.#autoStart) {
        throw stalledError(
          label,
          first,
          'Automatic restart is disabled (RELAYFILE_REQUIRE_DAEMON=1); restart `relayfile control-plane serve` and retry.'
        );
      }

      try {
        await this.#recover(attempted, label);
      } catch (stopErr) {
        throw stalledError(
          label,
          first,
          `Could not restart it automatically (${describe(stopErr)}); stop the running \`relayfile control-plane serve\` process and retry.`
        );
      }

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
      this.#recovery = (async () => {
        await (this.#options.stopDaemon ?? stopDaemonViaClient)(stalled);
        (this.#options.warn ?? defaultWarn)(
          `relayfile control-plane did not answer ${label}; restarted the daemon and retrying.`
        );
        // A fresh client re-runs hello negotiation and auto-starts the daemon.
        this.#client = this.#create();
      })().finally(() => {
        this.#recovery = undefined;
      });
    }
    return this.#recovery;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}
