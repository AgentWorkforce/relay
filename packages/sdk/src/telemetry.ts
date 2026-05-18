/**
 * Minimal SDK-side telemetry client.
 *
 * The SDK is a published library consumed by user code. It must:
 *   - No-op silently when no PostHog key is configured (private installs).
 *   - Respect opt-out env vars (`AGENT_RELAY_TELEMETRY_DISABLED`, `DO_NOT_TRACK`).
 *   - Add zero heavy runtime deps — no `posthog-node`, no fetch wrappers.
 *   - Not block user workflows — fire-and-forget with a short HTTP timeout.
 *
 * Implementation: a tiny in-process queue plus a single `fetch()` per event
 * with `AbortSignal.timeout()`. We don't batch — the SDK fires few enough
 * events that the simplicity is worth more than a couple of saved POSTs.
 *
 * Schema alignment: shares the `CommonProperties` shape with
 * `@agent-relay/telemetry` (see `packages/telemetry/src/events.ts`) so that
 * SDK-originated events sit on the same PostHog dashboards as CLI/broker
 * events. New common props go in both places.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_SURFACE = 'sdk' as const;
const POSTHOG_HOST = 'https://us.i.posthog.com';
const HARNESS_ENV_VAR = 'AGENT_RELAY_HARNESS';
const HTTP_TIMEOUT_MS = 5000;

/** Lower-kebab-case harness slugs — must match the TS/Rust classifier sets. */
type Harness =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'aider'
  | 'cline'
  | 'continue'
  | 'windsurf'
  | 'zed'
  | 'unknown';

const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  'claude-code',
  'cursor',
  'codex',
  'gemini',
  'aider',
  'cline',
  'continue',
  'windsurf',
  'zed',
  'unknown',
]);

interface SdkCommonProps {
  agent_relay_version: string;
  sdk_version: string;
  os: string;
  os_version?: string;
  node_version: string;
  arch: string;
  harness: string;
  surface: typeof SDK_SURFACE;
}

interface SdkTelemetryEvent {
  event: string;
  properties: Record<string, unknown>;
}

let initialised = false;
let enabled = false;
let apiKey: string | null = null;
let distinctId: string | null = null;
let commonProps: SdkCommonProps | null = null;
let inFlight: Promise<void>[] = [];

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

function isDisabledByEnv(): boolean {
  return isTruthyEnv(process.env.AGENT_RELAY_TELEMETRY_DISABLED) || isTruthyEnv(process.env.DO_NOT_TRACK);
}

/**
 * Read the PostHog key. The CLI plumbs this via env in PR #883; the SDK
 * uses the same env-var contract so private builds without a key simply
 * no-op.
 */
function resolveApiKey(): string | null {
  const fromEnv = process.env.AGENT_RELAY_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return null;
}

function getMachineIdPath(): string {
  const dataDir =
    process.env.AGENT_RELAY_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'agent-relay');
  return path.join(dataDir, 'machine-id');
}

/** Load or create the machine id (atomic via O_EXCL). */
function loadMachineId(): string {
  const machineIdPath = getMachineIdPath();
  try {
    return fs.readFileSync(machineIdPath, 'utf-8').trim();
  } catch (readErr: unknown) {
    if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `${os.hostname()}-${Date.now().toString(36)}`;
    }
    try {
      fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
      const machineId = `${os.hostname()}-${randomBytes(8).toString('hex')}`;
      const fd = fs.openSync(
        machineIdPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
      fs.writeSync(fd, machineId);
      fs.closeSync(fd);
      return machineId;
    } catch (writeErr: unknown) {
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          return fs.readFileSync(machineIdPath, 'utf-8').trim();
        } catch {
          // Fall through.
        }
      }
      return `${os.hostname()}-${Date.now().toString(36)}`;
    }
  }
}

function createAnonymousId(): string {
  return createHash('sha256').update(loadMachineId()).digest('hex').slice(0, 16);
}

function resolveSdkVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // Walk up from this file looking for package.json — works in both
    // src/dist layouts.
    let dir = path.dirname(here);
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string };
        return pkg.version ?? 'unknown';
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through.
  }
  return 'unknown';
}

function resolveHarness(): Harness {
  const fromEnv = process.env[HARNESS_ENV_VAR]?.trim().toLowerCase();
  if (fromEnv && KNOWN_HARNESSES.has(fromEnv)) {
    return fromEnv as Harness;
  }
  // SDK avoids the process-tree walk itself — keep startup cost near zero
  // for library consumers. The broker still does the walk on its side.
  return 'unknown';
}

function init(): void {
  if (initialised) return;
  initialised = true;

  if (isDisabledByEnv()) {
    enabled = false;
    return;
  }

  const key = resolveApiKey();
  if (!key) {
    // No-op silently — private builds without a key are valid.
    enabled = false;
    return;
  }

  enabled = true;
  apiKey = key;
  distinctId = createAnonymousId();
  const sdkVersion = resolveSdkVersion();
  commonProps = {
    agent_relay_version: sdkVersion,
    sdk_version: sdkVersion,
    os: process.platform,
    os_version: os.release(),
    node_version: process.version.slice(1),
    arch: process.arch,
    harness: resolveHarness(),
    surface: SDK_SURFACE,
  };
}

async function postEvent(body: SdkTelemetryEvent): Promise<void> {
  if (!enabled || !apiKey || !distinctId || !commonProps) return;

  const payload = {
    api_key: apiKey,
    event: body.event,
    distinct_id: distinctId,
    properties: {
      ...commonProps,
      ...body.properties,
    },
  };

  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    // Telemetry must never throw into user code.
  }
}

/**
 * Track an SDK event. Fire-and-forget — returns immediately, never throws.
 * The returned promise is recorded for `flushSdkTelemetry()` callers that
 * want to wait before exit.
 */
export function trackSdkEvent(event: string, properties: Record<string, unknown> = {}): void {
  init();
  if (!enabled) return;
  const p = postEvent({ event, properties }).catch(() => undefined);
  inFlight.push(p);
  // Cap the queue so a long-lived process doesn't accumulate references.
  if (inFlight.length > 64) {
    inFlight = inFlight.slice(-32);
  }
}

/**
 * Wait for outstanding events to flush. Safe to call multiple times; safe
 * to call when telemetry is disabled.
 */
export async function flushSdkTelemetry(): Promise<void> {
  if (inFlight.length === 0) return;
  const pending = inFlight;
  inFlight = [];
  await Promise.allSettled(pending);
}

/**
 * Wrap a public SDK method with `sdk_method_call` telemetry. The wrapper is
 * a no-op when telemetry is disabled (we still call the original, just skip
 * the timing/event emit).
 */
export function instrumentMethod<TArgs extends unknown[], TResult>(
  methodName: string,
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  return async function instrumented(...args: TArgs): Promise<TResult> {
    init();
    if (!enabled) {
      return fn(...args);
    }
    const startedAt = Date.now();
    try {
      const result = await fn(...args);
      trackSdkEvent('sdk_method_call', {
        method_name: methodName,
        success: true,
        duration_ms: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      trackSdkEvent('sdk_method_call', {
        method_name: methodName,
        success: false,
        duration_ms: Date.now() - startedAt,
        error_class: errorClass(err),
      });
      throw err;
    }
  };
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  if (err && typeof err === 'object') {
    return (err as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
  }
  return typeof err;
}

/** Test-only — reset module-level state between cases. */
export function resetSdkTelemetryForTests(): void {
  initialised = false;
  enabled = false;
  apiKey = null;
  distinctId = null;
  commonProps = null;
  inFlight = [];
}
