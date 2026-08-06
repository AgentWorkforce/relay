import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { buildApiUrl } from './api-client.js';
import { CloudAuthError, type StoredAuth } from './types.js';

/**
 * OAuth 2.0 device authorization grant (RFC 8628), client side.
 *
 * Lets a machine with no browser — a fleet node reached only over ssh —
 * obtain its own cloud session. The human approves in a browser on any other
 * device, and this machine ends up with its own session row rather than a
 * copy of someone else's. That matters because refresh tokens rotate: two
 * machines sharing one `cloud-auth.json` share one session row and silently
 * log each other out.
 */

/** RFC 8628 §3.4. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: on `slow_down` the client must increase its interval. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 60;
const DEFAULT_EXPIRES_IN_SECONDS = 600;
/**
 * Node's `fetch` has no default timeout, so a stalled TCP connection never
 * settles and leaves `cloud login --device` hanging with no output and no
 * error. That is the worst failure this feature can have: it exists for a
 * headless host reached over ssh, where nobody is watching a terminal, and a
 * silent hang there is strictly worse than a visible failure.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Node timers are 32-bit; past this a delay silently becomes 1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type DeviceFlowHooks = {
  /** Injected so tests can assert the client actually waits between polls. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Per-request abort budget. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
};

type DeviceTokenErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | (string & {});

function deviceError(message: string): CloudAuthError {
  return new CloudAuthError('AUTH_DEVICE_FLOW_FAILED', message);
}

/**
 * `AbortSignal.timeout` throws a `RangeError` on a fractional delay, and
 * silently collapses anything past the 32-bit timer range to 1ms — an
 * immediate abort. Either turns a timeout budget into an instant failure, and
 * the `RangeError` would surface from inside the fetch call as the misleading
 * "Could not reach <url>". A fractional value is reachable without a bad
 * caller: the poll budget is derived from the deadline, which is derived from
 * the server's `expires_in`.
 */
function clampTimerDelay(ms: number): number {
  if (!Number.isFinite(ms)) {
    return MAX_TIMER_DELAY_MS;
  }
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(ms)));
}

function normalizeTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return clampTimerDelay(ms);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`;
}

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError`, but fetch stacks differ
 * in whether they surface it directly, as an `AbortError`, or wrapped in a
 * `cause` chain. Walk the chain rather than trusting one shape.
 */
function isRequestTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return Math.min(MAX_INTERVAL_SECONDS, Math.ceil(seconds));
}

/**
 * A machine is treated as headless when nothing could plausibly open a
 * browser. Used only to pick a default — `--device` always wins, and the
 * device flow works fine on a desktop too.
 */
export function isHeadlessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform()
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) {
    return true;
  }
  // Deliberately NOT keyed off `CI`. A CI runner has no browser, but it also
  // has no human to approve the code, so the device flow would hang for the
  // full grant lifetime instead of failing fast. Unattended runs should use
  // WORKFORCE_WORKSPACE_TOKEN.
  //
  // macOS and Windows always have a usable `open`/`start`; only X11/Wayland
  // desktops on Unix depend on a display server being present.
  if (platform !== 'darwin' && platform !== 'win32') {
    return !env.DISPLAY && !env.WAYLAND_DISPLAY;
  }
  return false;
}

export async function startDeviceAuthorization(
  apiUrl: string,
  options: { clientName?: string; fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {}
): Promise<DeviceAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clientName = options.clientName ?? os.hostname();
  const timeoutMs = normalizeTimeout(options.requestTimeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(buildApiUrl(apiUrl, '/api/v1/auth/device/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: clientName }),
      // Nothing has been printed yet at this point, so a hang here shows the
      // user a bare cursor forever. Fail loudly instead.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw new CloudAuthError(
        'AUTH_DEVICE_FLOW_FAILED',
        `Timed out after ${formatDuration(timeoutMs)} trying to reach ${apiUrl} to start device login`,
        { cause: error }
      );
    }
    throw new CloudAuthError('AUTH_DEVICE_FLOW_FAILED', `Could not reach ${apiUrl} to start device login`, {
      cause: error,
    });
  }

  const payload = (await response.json().catch(() => null)) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok) {
    // A server without these routes is the likeliest failure early on; say so
    // rather than reporting a bare 404.
    if (response.status === 404) {
      throw deviceError(
        `${apiUrl} does not support device login. Update the cloud deployment, or run \`agent-relay cloud login\` on a machine with a browser.`
      );
    }
    const detail = payload?.error_description || payload?.error || `HTTP ${response.status}`;
    throw deviceError(`Could not start device login: ${detail}`);
  }

  if (!payload?.device_code || !payload.user_code || !payload.verification_uri) {
    throw deviceError('Device login response was missing required fields');
  }

  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    ...(payload.verification_uri_complete
      ? { verificationUriComplete: payload.verification_uri_complete }
      : {}),
    expiresInSeconds: payload.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS,
    intervalSeconds: clampInterval(payload.interval ?? DEFAULT_INTERVAL_SECONDS),
  };
}

/**
 * Poll until the user approves, denies, or the grant expires.
 *
 * Honours the RFC 8628 backoff contract: it waits `interval` between polls and
 * widens that interval on `slow_down`. It must never spin — a client that
 * ignores the interval gets rate limited off the server, so busy-looping is a
 * bug, not just impoliteness.
 */
export async function pollForDeviceToken(
  apiUrl: string,
  authorization: DeviceAuthorization,
  hooks: DeviceFlowHooks = {}
): Promise<StoredAuth> {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  const sleep = hooks.sleep ?? ((ms: number) => delay(ms));
  const now = hooks.now ?? (() => Date.now());
  const log = hooks.log ?? ((message: string) => console.log(message));
  const requestTimeoutMs = normalizeTimeout(hooks.requestTimeoutMs);

  let intervalSeconds = authorization.intervalSeconds;
  const deadline = now() + authorization.expiresInSeconds * 1000;

  for (;;) {
    // Wait first: the user cannot possibly have approved in the microseconds
    // since the grant was minted, and polling immediately only earns a
    // `slow_down`. Never wait past the grant, though — every retry path here
    // widens the interval, and a 60s interval with 5s of grant left would sit
    // on the expiry report for most of a minute before delivering it.
    await sleep(Math.min(intervalSeconds * 1000, Math.max(0, deadline - now())));

    if (now() >= deadline) {
      throw deviceError(
        'Device login expired before it was approved. Run the command again to get a new code.'
      );
    }

    // Bound every poll, and never past the grant deadline: a stalled socket
    // must not outlive the grant it is waiting on, or the loop's own expiry
    // check never gets to run.
    const pollTimeoutMs = clampTimerDelay(Math.min(requestTimeoutMs, deadline - now()));

    let response: Response;
    try {
      response = await fetchImpl(buildApiUrl(apiUrl, '/api/v1/auth/device/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: authorization.deviceCode,
        }),
        signal: AbortSignal.timeout(pollTimeoutMs),
      });
    } catch (error) {
      if (isRequestTimeout(error)) {
        if (now() >= deadline) {
          throw deviceError(
            'Device login expired before it was approved. Run the command again to get a new code.'
          );
        }
        // Same class as a 5xx: the request stalled, but the approval the human
        // may already have given is still claimable. Back off and try again
        // rather than discarding it — the deadline above bounds the loop, and
        // saying so out loud keeps a slow network from looking like a hang.
        log(`No response from ${apiUrl} within ${formatDuration(pollTimeoutMs)}; retrying...`);
        intervalSeconds = clampInterval(intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS);
        continue;
      }
      throw new CloudAuthError(
        'AUTH_DEVICE_FLOW_FAILED',
        `Lost connection to ${apiUrl} while waiting for approval`,
        { cause: error }
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      access_token_expires_at?: string;
      refresh_token_expires_at?: string;
      api_url?: string;
      error?: DeviceTokenErrorCode;
      error_description?: string;
      interval?: number;
    } | null;

    if (response.ok) {
      if (!payload?.access_token || !payload.refresh_token || !payload.access_token_expires_at) {
        throw deviceError('Device login response was missing required fields');
      }
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        accessTokenExpiresAt: payload.access_token_expires_at,
        ...(payload.refresh_token_expires_at
          ? { refreshTokenExpiresAt: payload.refresh_token_expires_at }
          : {}),
        apiUrl: payload.api_url?.trim() || apiUrl,
      };
    }

    // A 429 means the server thinks we are polling too fast even before it
    // gets to the grant. Back off on its terms.
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      intervalSeconds = clampInterval(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS
      );
      continue;
    }

    // A 5xx here is transient by construction. The server claims the grant and
    // mints the session in one transaction, so a failure rolls the claim back
    // and leaves the grant `approved` and claimable — it answers `server_error`
    // rather than burning the approval, specifically so this loop can try
    // again. Treating it as fatal would discard an approval the human already
    // gave and make them redo the whole flow. Bounded by the grant deadline
    // above, so an outage that outlasts the grant still ends the loop.
    if (response.status >= 500) {
      intervalSeconds = clampInterval(intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS);
      continue;
    }

    switch (payload?.error) {
      case 'authorization_pending':
        // Still waiting on the human. The server may also have widened the
        // interval; respect it if so.
        if (payload.interval) {
          intervalSeconds = Math.max(intervalSeconds, clampInterval(payload.interval));
        }
        continue;

      case 'slow_down':
        // RFC 8628 §3.5. Take whichever is larger: the server's stated
        // interval, or our own +5s step.
        intervalSeconds = clampInterval(
          Math.max(intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS, payload.interval ?? 0)
        );
        continue;

      case 'access_denied':
        throw deviceError('Device login was denied. No credentials were issued.');

      case 'expired_token':
        throw deviceError(
          'Device login expired before it was approved. Run the command again to get a new code.'
        );

      case 'invalid_grant':
        throw deviceError('This device code is no longer valid. Run the command again to get a new code.');

      default: {
        const detail = payload?.error_description || payload?.error || `HTTP ${response.status}`;
        throw deviceError(`Device login failed: ${detail}`);
      }
    }
  }
}

export function formatDeviceInstructions(authorization: DeviceAuthorization): string {
  return [
    '',
    'To authorize this machine, visit:',
    `  ${authorization.verificationUri}`,
    '',
    'and enter code:',
    `  ${authorization.userCode}`,
    '',
    ...(authorization.verificationUriComplete
      ? [`Or open this link directly:`, `  ${authorization.verificationUriComplete}`, '']
      : []),
  ].join('\n');
}

/**
 * Run the whole device flow. Returns the session without persisting it — the
 * caller owns writing `cloud-auth.json` through the normal persistence path.
 */
export async function runDeviceAuthorizationFlow(
  apiUrl: string,
  options: { clientName?: string } & DeviceFlowHooks = {}
): Promise<StoredAuth> {
  const log = options.log ?? ((message: string) => console.log(message));

  const authorization = await startDeviceAuthorization(apiUrl, {
    ...(options.clientName ? { clientName: options.clientName } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });

  log(formatDeviceInstructions(authorization));
  log('Waiting for authorization...');

  const auth = await pollForDeviceToken(apiUrl, authorization, options);
  return auth;
}
