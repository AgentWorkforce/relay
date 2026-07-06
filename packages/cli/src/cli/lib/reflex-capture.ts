/**
 * Reflex in-process cloud capture.
 *
 * When Reflex is enabled (`agent-relay reflex on`), the long-running
 * `agent-relay up` host periodically pushes new local session history to
 * relayhistory-cloud via the `ai-hist` SDK — no CLI shell-out, no launchd/cron.
 * Mirrors the telemetry client: an unref'd timer that never blocks the event
 * loop, plus a best-effort final flush on shutdown.
 *
 * `ai-hist/cloud` is imported lazily (dynamic, non-analyzable spec) so the
 * bundled CLI does not statically depend on it — it resolves from node_modules
 * at runtime and is a silent no-op if unavailable or unauthenticated. It is an
 * optional runtime dependency (a peer of the `ai-hist` SDK); once
 * `ai-hist@>=0.4.0` — which ships `pushToCloud` — is published it can be
 * declared as a dependency so real installs pick it up.
 */
import { isReflexEnabled } from '@agent-relay/config';

export interface ReflexPushResult {
  sent: number;
  accepted: number;
}

export interface ReflexCaptureDeps {
  /** Whether Reflex is enabled (checked once at start). */
  isEnabled: () => boolean;
  /** Perform one push; resolves `null` when not authed / SDK unavailable. */
  push: () => Promise<ReflexPushResult | null>;
  /** Diagnostic logger. */
  log: (message: string) => void;
  /** Milliseconds between pushes. */
  intervalMs: number;
  /** Delay before the first push so startup isn't blocked. */
  initialDelayMs: number;
}

export interface RunningReflexCapture {
  /** Stop the timer and flush a final batch (best-effort). */
  stop: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;

/** Load the ai-hist cloud SDK lazily; returns a push result or null. */
async function defaultPush(): Promise<ReflexPushResult | null> {
  // Non-literal spec keeps this out of the esbuild bundle; resolves at runtime.
  const spec = 'ai-hist/cloud';
  let mod: {
    loadStoredRelayhistoryAuth?: () => Promise<unknown | null>;
    pushToCloud?: (opts: { auth: unknown }) => Promise<{ sent?: number; accepted?: number }>;
  };
  try {
    mod = (await import(spec)) as typeof mod;
  } catch {
    return null; // ai-hist not installed
  }
  if (typeof mod.loadStoredRelayhistoryAuth !== 'function' || typeof mod.pushToCloud !== 'function') {
    return null;
  }
  const auth = await mod.loadStoredRelayhistoryAuth();
  if (!auth) return null; // not authenticated yet
  const report = await mod.pushToCloud({ auth });
  return { sent: report.sent ?? 0, accepted: report.accepted ?? 0 };
}

function withDefaults(overrides: Partial<ReflexCaptureDeps>): ReflexCaptureDeps {
  return {
    isEnabled: isReflexEnabled,
    push: defaultPush,
    log: (message: string) => console.error(message),
    intervalMs: DEFAULT_INTERVAL_MS,
    initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
    ...overrides,
  };
}

export function startReflexCapture(overrides: Partial<ReflexCaptureDeps> = {}): RunningReflexCapture {
  const deps = withDefaults(overrides);

  let stopped = false;
  // Dedup concurrent ticks: a slow push must not overlap the next interval.
  let inFlight: Promise<void> | null = null;
  // The recurring interval starts only after the first (delayed) push.
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): Promise<void> => {
    if (inFlight) return inFlight;
    // Re-check enablement every tick so `agent-relay reflex off` (or `on`)
    // takes effect immediately in an already-running `agent-relay up`, without
    // restarting the host.
    if (!deps.isEnabled()) return Promise.resolve();
    inFlight = (async () => {
      try {
        const result = await deps.push();
        if (result && result.sent > 0) {
          deps.log(`[reflex] synced ${result.sent} record(s) to relayhistory-cloud`);
        }
      } catch (err) {
        deps.log(`[reflex] cloud sync failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const kickoff = setTimeout(() => {
    if (stopped) return;
    void tick();
    // Start the interval only now, so the first push can never fire before
    // initialDelayMs regardless of how small intervalMs is.
    timer = setInterval(() => {
      if (!stopped) void tick();
    }, deps.intervalMs);
    // Don't keep the process alive just for the capture timer.
    timer.unref?.();
  }, deps.initialDelayMs);
  kickoff.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(kickoff);
      if (timer) clearInterval(timer);
      // Let an in-flight push finish, then flush one final batch (a no-op if
      // Reflex was disabled in the meantime — tick() re-checks).
      if (inFlight) {
        await inFlight;
      } else {
        await tick();
      }
    },
  };
}
