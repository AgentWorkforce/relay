/**
 * Reflex in-process cloud capture.
 *
 * When Reflex is enabled (`agent-relay reflex on`), the long-running
 * `agent-relay up` host periodically syncs local agent history into the ai-hist
 * DB and pushes new records to relayhistory-cloud — no launchd/cron, no CLI the
 * user runs by hand, and **no subprocess**. Mirrors the telemetry client: an
 * unref'd timer that never blocks the event loop, plus a best-effort final
 * flush on shutdown.
 *
 * The work runs in-process through the `ai-hist-native` napi addon
 * (`syncAndPush()`), which ships as a per-platform optional-dependency package
 * so a plain `agent-relay` install works with no extra setup. Everything is a
 * silent no-op when the addon is unavailable or the user isn't authenticated.
 */
import { isReflexEnabled } from '@agent-relay/config';

export interface ReflexPushResult {
  sent: number;
  accepted: number;
}

export interface ReflexCaptureDeps {
  /** Whether Reflex is enabled (checked once at start). */
  isEnabled: () => boolean;
  /** Perform one push; resolves `null` when not authed / addon unavailable. */
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

/** The native addon surface we depend on. */
export interface NativeAiHist {
  syncAndPush: () => Promise<{ sent: number; accepted: number; authenticated: boolean }>;
}

/** Lazily load the `ai-hist-native` napi addon; null when it isn't installed. */
async function loadNative(): Promise<NativeAiHist | null> {
  // Non-literal spec keeps the native addon out of the esbuild bundle; it
  // resolves from node_modules (the per-platform optional dep) at runtime.
  const spec = 'ai-hist-native';
  let mod: Partial<NativeAiHist> & { default?: Partial<NativeAiHist> };
  try {
    mod = (await import(spec)) as typeof mod;
  } catch (err) {
    // Not installed for this platform → a clean no-op. Anything else (ABI
    // mismatch, missing system lib, addon init failure) is a real problem —
    // rethrow so the caller logs it instead of silently doing nothing.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
  const fn = mod.syncAndPush ?? mod.default?.syncAndPush;
  return typeof fn === 'function' ? { syncAndPush: fn } : null;
}

export interface ReflexPushOptions {
  /** Injectable native addon (tests); defaults to lazy-loading `ai-hist-native`. */
  native?: NativeAiHist | null;
}

/**
 * Sync local agent history into the ai-hist DB and push new records to
 * relayhistory-cloud, **in-process** via the native addon — no subprocess. This
 * is what makes `reflex on` "just work": no separate ai-hist install, no CLI.
 * Resolves null when the addon is unavailable or the user isn't authenticated.
 */
export async function reflexSyncAndPush(opts: ReflexPushOptions = {}): Promise<ReflexPushResult | null> {
  const native = opts.native !== undefined ? opts.native : await loadNative();
  if (!native) return null;
  const result = await native.syncAndPush();
  if (!result.authenticated) return null; // not logged in yet
  return { sent: result.sent, accepted: result.accepted };
}

function withDefaults(overrides: Partial<ReflexCaptureDeps>): ReflexCaptureDeps {
  return {
    isEnabled: isReflexEnabled,
    push: () => reflexSyncAndPush(),
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
