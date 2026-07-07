/**
 * Reflex in-process cloud capture.
 *
 * When Reflex is enabled (`agent-relay reflex on`), the long-running
 * `agent-relay up` host periodically syncs local agent history into the ai-hist
 * DB and pushes new records to relayhistory-cloud — no launchd/cron, no CLI the
 * user runs by hand. Mirrors the telemetry client: an unref'd timer that never
 * blocks the event loop, plus a best-effort final flush on shutdown.
 *
 * It drives the `ai-hist` Rust binary, which ships as a per-platform
 * optional-dependency package (resolved via `getAiHistBinaryPath`) so a plain
 * `agent-relay` install works with no extra setup. Everything is a silent no-op
 * when the binary is unavailable or the user isn't authenticated.
 */
import { spawn } from 'node:child_process';

import { isReflexEnabled } from '@agent-relay/config';

import { getAiHistBinaryPath } from './ai-hist-path.js';

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

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the ai-hist binary; resolves null when it's unavailable. */
function runAiHist(bin: string, args: string[], spawnFn: typeof spawn): Promise<RunResult | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr?.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Binary missing / not executable / a directory → nothing to do.
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(err.code ?? '')) {
        resolvePromise(null);
        return;
      }
      reject(err);
    });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

export interface ReflexPushOptions {
  binPath?: string;
  spawnFn?: typeof spawn;
}

/**
 * Sync local agent history into the ai-hist DB, then push new records to
 * relayhistory-cloud — both by driving the bundled `ai-hist` binary. This is
 * what makes `reflex on` "just work": no separate ai-hist install, no CLI the
 * user runs by hand. Resolves null when the binary is unavailable or the user
 * isn't authenticated.
 */
export async function reflexSyncAndPush(opts: ReflexPushOptions = {}): Promise<ReflexPushResult | null> {
  const bin = opts.binPath ?? getAiHistBinaryPath();
  const spawnFn = opts.spawnFn ?? spawn;

  // 1. Populate the local DB from the user's agent history. If this can't run
  //    (binary unavailable) there's nothing to push.
  const synced = await runAiHist(bin, ['sync'], spawnFn);
  if (synced === null) return null;

  // 2. Upload new records.
  const pushed = await runAiHist(bin, ['push', '--json'], spawnFn);
  if (pushed === null) return null;
  if (pushed.code !== 0) {
    // Not logged in yet is expected before `reflex on` completes.
    if (/not authenticated|no relayhistory auth|run `?ai-hist login/i.test(pushed.stderr)) {
      return null;
    }
    throw new Error(`ai-hist push failed (exit ${pushed.code}): ${pushed.stderr.trim().slice(0, 300)}`);
  }
  try {
    const parsed = (pushed.stdout.trim() ? JSON.parse(pushed.stdout) : {}) as {
      sent?: number;
      accepted?: number;
    };
    return { sent: parsed.sent ?? 0, accepted: parsed.accepted ?? 0 };
  } catch (err) {
    throw new Error(
      `could not parse ai-hist push output: ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
