import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { buildApiUrl } from './api-client.js';
import { CloudApiClient, type CloudApiClientOptions, type CloudApiClientSnapshot } from './api-client.js';
import { appendAgentRelayTelemetryHeaders } from './telemetry-headers.js';
import {
  clearStoredIdentity,
  readStoredIdentity,
  writeStoredIdentity,
  type CloudIdentity,
} from './identity.js';
import { isHeadlessEnvironment, runDeviceAuthorizationFlow, type DeviceFlowHooks } from './device-auth.js';
import {
  AUTH_FILE_PATH,
  DEFAULT_REFRESH_TIMEOUT_MS,
  REFRESH_TOKEN_WINDOW_MS,
  REFRESH_WINDOW_MS,
  CloudAuthError,
  defaultApiUrl,
  type CloudSession,
  type CloudSessionOptions,
  type StoredAuth,
  type WhoAmIResponse,
} from './types.js';

const AUTH_DIR_PATH = path.dirname(AUTH_FILE_PATH);
const AUTH_LOCK_PATH = `${AUTH_FILE_PATH}.lock`;
const AUTH_LOCK_RETRY_DELAY_MS = 50;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_TIMEOUT_MS = 30_000;

const envBackedAuth = new WeakSet<StoredAuth>();
const API_KEY_NON_REFRESHING_EXPIRY = '9999-12-31T23:59:59.999Z';

function isApiKeyAuth(auth: StoredAuth): boolean {
  return auth.authMode === 'api-key';
}

function readApiKeyAuth(apiUrl: string, env: NodeJS.ProcessEnv = process.env): StoredAuth | null {
  const apiKey = env.CLOUD_API_KEY?.trim();
  if (!apiKey) return null;

  const configuredApiUrl = env.CLOUD_API_URL?.trim() || apiUrl;
  try {
    new URL(configuredApiUrl);
  } catch (error) {
    throw new CloudAuthError('AUTH_ENV_REPROVISION_REQUIRED', 'CLOUD_API_URL is invalid for CLOUD_API_KEY', {
      cause: error,
    });
  }

  return {
    authMode: 'api-key',
    apiUrl: configuredApiUrl,
    accessToken: apiKey,
    // StoredAuth predates service credentials and models a refreshable login.
    // These placeholders keep that internal shape stable; authMode guarantees
    // neither value is consulted or sent over the network.
    refreshToken: '',
    accessTokenExpiresAt: API_KEY_NON_REFRESHING_EXPIRY,
  };
}

function markEnvBackedAuth(auth: StoredAuth): StoredAuth {
  envBackedAuth.add(auth);
  return auth;
}

function isEnvBackedAuth(auth: StoredAuth): boolean {
  return envBackedAuth.has(auth);
}

function readEnvAuth(env: NodeJS.ProcessEnv = process.env): StoredAuth | null {
  const apiUrl = env.CLOUD_API_URL?.trim();
  const accessToken = env.CLOUD_API_ACCESS_TOKEN?.trim();
  const refreshToken = env.CLOUD_API_REFRESH_TOKEN?.trim();
  const accessTokenExpiresAt = env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT?.trim();
  const refreshTokenExpiresAt = env.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT?.trim();

  if (!apiUrl || !accessToken || !refreshToken || !accessTokenExpiresAt) {
    return null;
  }

  try {
    new URL(apiUrl);
  } catch {
    return null;
  }

  if (Number.isNaN(Date.parse(accessTokenExpiresAt))) {
    return null;
  }

  return markEnvBackedAuth({
    apiUrl,
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    ...(refreshTokenExpiresAt && !Number.isNaN(Date.parse(refreshTokenExpiresAt))
      ? { refreshTokenExpiresAt }
      : {}),
  });
}

function toEnvAuthRefreshError(error: unknown): Error {
  if (error instanceof CloudAuthError && error.code === 'AUTH_REFRESH_TIMEOUT') {
    return error;
  }

  const message = error instanceof Error && error.message ? `${error.message}. ` : '';

  return new CloudAuthError(
    'AUTH_ENV_REPROVISION_REQUIRED',
    `${message}Env-backed cloud auth could not be refreshed interactively; re-provision CLOUD_API_URL, CLOUD_API_ACCESS_TOKEN, CLOUD_API_REFRESH_TOKEN, CLOUD_API_ACCESS_TOKEN_EXPIRES_AT, and optionally CLOUD_API_REFRESH_TOKEN_EXPIRES_AT.`,
    { cause: error }
  );
}

function isValidStoredAuth(value: unknown): value is StoredAuth {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const auth = value as Partial<StoredAuth>;
  return (
    auth.authMode === undefined &&
    typeof auth.accessToken === 'string' &&
    typeof auth.refreshToken === 'string' &&
    typeof auth.accessTokenExpiresAt === 'string' &&
    typeof auth.apiUrl === 'string' &&
    (auth.refreshTokenExpiresAt === undefined || typeof auth.refreshTokenExpiresAt === 'string') &&
    !Number.isNaN(Date.parse(auth.accessTokenExpiresAt)) &&
    (auth.refreshTokenExpiresAt === undefined || !Number.isNaN(Date.parse(auth.refreshTokenExpiresAt)))
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

async function readCanonicalStoredAuth(): Promise<StoredAuth | null> {
  try {
    const file = await fs.readFile(AUTH_FILE_PATH, 'utf8');
    const parsed = JSON.parse(file) as unknown;
    return isValidStoredAuth(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readStoredAuth(env: NodeJS.ProcessEnv = process.env): Promise<StoredAuth | null> {
  const envAuth = readEnvAuth(env);
  if (envAuth) {
    return envAuth;
  }

  return readCanonicalStoredAuth();
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  await fs.mkdir(AUTH_DIR_PATH, {
    recursive: true,
    mode: 0o700,
  });

  const temporaryPath = path.join(
    AUTH_DIR_PATH,
    `.${path.basename(AUTH_FILE_PATH)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );

  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, AUTH_FILE_PATH);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function clearStoredAuth(): Promise<void> {
  await fs.rm(AUTH_FILE_PATH, { force: true });
  await clearStoredIdentity();
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Resolve who the stored credentials belong to and persist it alongside them.
 *
 * Called on login and by `agent-relay cloud whoami`; also called lazily by
 * {@link ensureCloudSession} when no identity has been recorded yet for the
 * session's host. Best-effort by construction — a failure here leaves telemetry
 * anonymous but must never break the command that triggered it.
 */
export async function refreshStoredCloudIdentity(
  auth: StoredAuth,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<CloudIdentity | null> {
  const env = options.env ?? process.env;

  try {
    const { response } = await authorizedApiFetch(
      auth,
      '/api/v1/auth/whoami',
      { method: 'GET' },
      { interactive: false }
    );
    if (!response.ok) return null;

    const payload = (await response.json().catch(() => null)) as WhoAmIResponse | null;
    if (!payload?.authenticated || !payload.user?.id) return null;

    const identity = toCloudIdentity(payload, auth.apiUrl);
    if (!identity) return null;

    await writeStoredIdentity(identity, env);
    return identity;
  } catch {
    return null;
  }
}

export function toCloudIdentity(payload: WhoAmIResponse, apiUrl: string): CloudIdentity | null {
  if (!payload.user?.id) return null;

  return {
    userId: payload.user.id,
    ...(payload.user.email ? { email: payload.user.email } : {}),
    ...(payload.user.name ? { name: payload.user.name } : {}),
    ...(payload.currentOrganization
      ? {
          organizationId: payload.currentOrganization.id,
          organizationSlug: payload.currentOrganization.slug,
          organizationName: payload.currentOrganization.name,
          organizationRole: payload.currentOrganization.role,
        }
      : {}),
    ...(payload.currentWorkspace ? { workspaceId: payload.currentWorkspace.id } : {}),
    apiUrl,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Whether the cached identity still matches the credentials in play.
 *
 * Deliberately *not* used to trigger a lazy whoami inside
 * {@link ensureCloudSession}: identity is analytics, and analytics must not add
 * an HTTP round trip to the auth path every command runs. Identity is captured
 * at login and refreshed by `agent-relay cloud whoami`; callers who want it
 * fresh call {@link refreshStoredCloudIdentity} explicitly.
 */
export async function hasCurrentStoredCloudIdentity(
  auth: StoredAuth,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const existing = await readStoredIdentity(env);
  return Boolean(existing && existing.apiUrl === auth.apiUrl);
}

async function removeStaleStoredAuthLock(): Promise<boolean> {
  try {
    const lockStats = await fs.stat(AUTH_LOCK_PATH);
    if (Date.now() - lockStats.mtimeMs < AUTH_LOCK_STALE_MS) {
      return false;
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return true;
    }
    throw error;
  }

  await fs.rm(AUTH_LOCK_PATH, { recursive: true, force: true });
  return true;
}

async function acquireStoredAuthLock(signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Cloud auth lock acquisition aborted');
    }

    try {
      await fs.mkdir(AUTH_LOCK_PATH, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'EEXIST')) {
        throw error;
      }
    }

    if (await removeStaleStoredAuthLock()) {
      continue;
    }

    if (Date.now() - startedAt >= AUTH_LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for cloud auth lock at ${AUTH_LOCK_PATH}`);
    }

    await delay(AUTH_LOCK_RETRY_DELAY_MS, undefined, { signal });
  }
}

async function withStoredAuthLock<T>(
  callback: () => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  await fs.mkdir(AUTH_DIR_PATH, {
    recursive: true,
    mode: 0o700,
  });
  await acquireStoredAuthLock(options.signal);

  try {
    return await callback();
  } finally {
    await fs.rm(AUTH_LOCK_PATH, { recursive: true, force: true });
  }
}

function shouldRefresh(accessTokenExpiresAt: string): boolean {
  const expiresAt = Date.parse(accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) {
    return true;
  }

  return expiresAt - Date.now() <= REFRESH_WINDOW_MS;
}

function shouldRefreshStoredAuth(auth: StoredAuth): boolean {
  if (shouldRefresh(auth.accessTokenExpiresAt)) {
    return true;
  }

  if (!auth.refreshTokenExpiresAt) {
    return false;
  }

  const refreshExpiresAt = Date.parse(auth.refreshTokenExpiresAt);
  if (Number.isNaN(refreshExpiresAt)) {
    return true;
  }

  return refreshExpiresAt - Date.now() <= REFRESH_TOKEN_WINDOW_MS;
}

function openBrowser(url: string) {
  const platform = os.platform();

  if (platform === 'darwin') {
    return spawn('open', [url], { stdio: 'ignore', detached: true });
  }

  if (platform === 'win32') {
    return spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  }

  return spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
}

function browserRequired(message: string): CloudAuthError {
  return new CloudAuthError('AUTH_BROWSER_REQUIRED', message);
}

function refreshExpired(message = 'Stored cloud login has expired'): CloudAuthError {
  return new CloudAuthError('AUTH_REFRESH_EXPIRED', message);
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || /aborted/i.test(error.message))
  );
}

function addAbortListener(signal: AbortSignal, listener: () => void): () => void {
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

async function fetchWithRefreshTimeout(
  url: URL,
  init: RequestInit,
  options: { refreshTimeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Response> {
  const refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  let timedOut = false;
  let callerAborted = false;

  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort();
  };

  for (const signal of [options.signal, init.signal]) {
    if (!signal) {
      continue;
    }

    if (signal.aborted) {
      callerAborted = true;
      controller.abort();
      break;
    }

    removers.push(addAbortListener(signal, abortFromCaller));
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, refreshTimeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut || (!callerAborted && isAbortLikeError(error))) {
      throw new CloudAuthError(
        'AUTH_REFRESH_TIMEOUT',
        `Cloud auth refresh timed out after ${refreshTimeoutMs}ms`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    for (const remove of removers) {
      remove();
    }
  }
}

function redirectToHostedCliAuthPage(
  response: http.ServerResponse<http.IncomingMessage>,
  apiUrl: string,
  options: {
    status: 'success' | 'error';
    detail?: string;
  }
): void {
  const resultUrl = buildApiUrl(apiUrl, '/cli/auth-result');
  resultUrl.searchParams.set('status', options.status);
  if (options.detail) {
    resultUrl.searchParams.set('detail', options.detail);
  }

  response.statusCode = 302;
  response.setHeader('location', resultUrl.toString());
  response.end();
}

async function beginBrowserLogin(apiUrl: string): Promise<StoredAuth> {
  const state = randomUUID();

  return new Promise<StoredAuth>((resolve, reject) => {
    let settled = false;

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

      if (requestUrl.pathname !== '/callback') {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }

      const returnedState = requestUrl.searchParams.get('state');

      // Validate state parameter first (CSRF protection) — this check
      // must run unconditionally, before any user-controlled values.
      if (returnedState !== state) {
        response.statusCode = 400;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end('Ignored invalid CLI login callback. Return to your terminal to continue login.');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      if (error) {
        redirectToHostedCliAuthPage(response, apiUrl, {
          status: 'error',
          detail: error,
        });
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error(error));
        }
        return;
      }

      const accessToken = requestUrl.searchParams.get('access_token');
      const refreshToken = requestUrl.searchParams.get('refresh_token');
      const accessTokenExpiresAt = requestUrl.searchParams.get('access_token_expires_at');
      const refreshTokenExpiresAt = requestUrl.searchParams.get('refresh_token_expires_at');
      const returnedApiUrl = requestUrl.searchParams.get('api_url');

      if (!accessToken || !refreshToken || !accessTokenExpiresAt || !returnedApiUrl) {
        redirectToHostedCliAuthPage(response, apiUrl, {
          status: 'error',
          detail: 'Expected access token, refresh token, API URL, and expiration timestamp.',
        });
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error('CLI login callback was missing required fields'));
        }
        return;
      }

      redirectToHostedCliAuthPage(response, returnedApiUrl, {
        status: 'success',
        detail: `API endpoint: ${returnedApiUrl}`,
      });

      if (!settled) {
        settled = true;
        server.close();
        resolve({
          accessToken,
          refreshToken,
          accessTokenExpiresAt,
          ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
          apiUrl: returnedApiUrl,
        });
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error('Failed to start local callback server'));
        }
        return;
      }

      const callbackUrl = new URL('/callback', `http://127.0.0.1:${address.port}`);
      const loginUrl = buildApiUrl(apiUrl, '/api/v1/cli/login');
      loginUrl.searchParams.set('redirect_uri', callbackUrl.toString());
      loginUrl.searchParams.set('state', state);

      console.log(`Opening browser for cloud login: ${loginUrl.toString()}`);
      console.log('If the browser does not open, paste this URL into your browser.');

      try {
        const child = openBrowser(loginUrl.toString());
        child.unref();
      } catch {
        // Browser open failure is non-fatal; user still has the URL.
      }
    });

    server.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error('Timed out waiting for browser login'));
      }
    }, 5 * 60_000).unref();
  });
}

export async function refreshStoredAuth(
  auth: StoredAuth,
  options: { force?: boolean; refreshTimeoutMs?: number; signal?: AbortSignal } = {}
): Promise<StoredAuth> {
  if (isEnvBackedAuth(auth)) {
    return markEnvBackedAuth(await requestStoredAuthRefresh(auth, options));
  }

  return withStoredAuthLock(async () => {
    const latestAuth = await readCanonicalStoredAuth();
    const refreshSource = latestAuth?.apiUrl === auth.apiUrl ? latestAuth : auth;

    if (!options.force && latestAuth?.apiUrl === auth.apiUrl && !shouldRefreshStoredAuth(latestAuth)) {
      return latestAuth;
    }

    const nextAuth = await requestStoredAuthRefresh(refreshSource, options);
    await writeStoredAuth(nextAuth);
    return nextAuth;
  }, options);
}

async function requestStoredAuthRefresh(
  auth: StoredAuth,
  options: { refreshTimeoutMs?: number; signal?: AbortSignal } = {}
): Promise<StoredAuth> {
  const response = await fetchWithRefreshTimeout(
    buildApiUrl(auth.apiUrl, '/api/v1/auth/token/refresh'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    },
    options
  );

  const payload = (await response.json().catch(() => null)) as {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    apiUrl?: string;
  } | null;

  if (!response.ok || !payload?.accessToken || !payload?.refreshToken || !payload?.accessTokenExpiresAt) {
    throw refreshExpired();
  }

  const nextRefreshTokenExpiresAt =
    typeof payload.refreshTokenExpiresAt === 'string' && payload.refreshTokenExpiresAt.trim()
      ? payload.refreshTokenExpiresAt.trim()
      : auth.refreshTokenExpiresAt;

  const nextAuth: StoredAuth = {
    apiUrl: typeof payload.apiUrl === 'string' && payload.apiUrl.trim() ? payload.apiUrl.trim() : auth.apiUrl,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
    ...(nextRefreshTokenExpiresAt ? { refreshTokenExpiresAt: nextRefreshTokenExpiresAt } : {}),
  };

  return nextAuth;
}

/**
 * Persist a freshly obtained session and announce who it belongs to. Shared by
 * the browser and device flows so both write `cloud-auth.json` through the same
 * path — that is what keeps `cloud session --json --reveal-token` working
 * regardless of how the machine logged in.
 */
async function completeLogin(auth: StoredAuth): Promise<StoredAuth> {
  await writeStoredAuth(auth);
  // Record who just logged in so subsequent CLI/broker runs can attribute
  // telemetry to this user and org. Never blocks the login from succeeding.
  const identity = await refreshStoredCloudIdentity(auth);
  console.log(`Logged in to ${auth.apiUrl}`);
  if (identity?.email) {
    const org = identity.organizationName ?? identity.organizationSlug;
    console.log(`Signed in as ${identity.email}${org ? ` (${org})` : ''}`);
  }
  return auth;
}

async function loginWithBrowser(apiUrl: string): Promise<StoredAuth> {
  return completeLogin(await beginBrowserLogin(apiUrl));
}

/**
 * Device-code login for machines with no browser. Each run mints its own
 * session row on the server, so this machine's refresh-token rotation is
 * independent of every other machine's — which is the reason copying
 * `cloud-auth.json` between hosts is not a valid substitute.
 */
export async function loginWithDevice(
  apiUrl: string,
  options: { clientName?: string } & DeviceFlowHooks = {}
): Promise<StoredAuth> {
  return completeLogin(await runDeviceAuthorizationFlow(apiUrl, options));
}

/**
 * Pick a login style. `--device` is explicit; otherwise fall back to the device
 * flow when nothing here could open a browser, since the browser flow's
 * loopback callback is unreachable from another machine and would only hang
 * until it timed out.
 */
async function loginInteractive(
  apiUrl: string,
  options: { device?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<StoredAuth> {
  const env = options.env ?? process.env;
  if (options.device === true || isHeadlessEnvironment(env)) {
    return loginWithDevice(apiUrl);
  }
  return loginWithBrowser(apiUrl);
}

export async function ensureAuthenticated(
  apiUrl: string,
  options?: {
    force?: boolean;
    interactive?: boolean;
    device?: boolean;
    refreshTimeoutMs?: number;
  }
): Promise<StoredAuth> {
  if (options?.force !== true) {
    const apiKeyAuth = readApiKeyAuth(apiUrl);
    if (apiKeyAuth) return apiKeyAuth;
  }

  const session = await ensureCloudSession({
    apiUrl,
    force: options?.force,
    interactive: options?.interactive,
    device: options?.device,
    refreshTimeoutMs: options?.refreshTimeoutMs,
  });
  return session.auth;
}

export async function ensureCloudSession(options: CloudSessionOptions = {}): Promise<CloudSession> {
  const env = options.env ?? process.env;
  const apiUrl = options.apiUrl || env.CLOUD_API_URL?.trim() || defaultApiUrl();
  const force = options.force === true;
  const interactive = options.interactive !== false;
  const refreshTimeoutMs = options.refreshTimeoutMs;
  const stored = !force ? await readStoredAuth(env) : null;

  // Stored auth is authoritative on its own host. A host mismatch between
  // `apiUrl` (typically defaultApiUrl()) and `stored.apiUrl` is NOT a reason
  // to force a fresh browser login — the user already linked, and the default
  // may have drifted (e.g. CLOUD_API_URL env set/unset between sessions).
  // Only `--force` re-links to a different host.
  if (!stored) {
    if (!interactive) {
      // Point a headless host at the flow that can actually work there,
      // rather than at a browser it has no way to open.
      throw browserRequired(
        isHeadlessEnvironment(env)
          ? 'Cloud login required. Run `agent-relay cloud login --device`.'
          : 'Cloud login required. Run `agent-relay login`.'
      );
    }
    const auth = await loginInteractive(apiUrl, { device: options.device, env });
    return createCloudSession(auth, { refreshTimeoutMs });
  }

  if (!shouldRefreshStoredAuth(stored)) {
    return createCloudSession(stored, { refreshTimeoutMs });
  }

  try {
    const auth = await refreshStoredAuth(stored, { refreshTimeoutMs });
    return createCloudSession(auth, { refreshTimeoutMs });
  } catch (error) {
    if (isEnvBackedAuth(stored)) {
      throw toEnvAuthRefreshError(error);
    }

    if (!interactive) {
      throw error;
    }

    const auth = await loginInteractive(stored.apiUrl, { device: options.device, env });
    return createCloudSession(auth, { refreshTimeoutMs });
  }
}

function createCloudSession(auth: StoredAuth, options: { refreshTimeoutMs?: number } = {}): CloudSession {
  const clientOptions: CloudApiClientOptions = {
    ...auth,
    refreshTimeoutMs: options.refreshTimeoutMs,
  };

  if (!isEnvBackedAuth(auth)) {
    clientOptions.refreshAuth = async (snapshot, refreshOptions) =>
      toCloudApiClientSnapshot(
        await refreshStoredAuth(toStoredAuth(snapshot), {
          force: refreshOptions.force,
          refreshTimeoutMs: options.refreshTimeoutMs,
          signal: refreshOptions.signal,
        })
      );
  }

  const client = new CloudApiClient(clientOptions);

  return { auth, client };
}

function toStoredAuth(snapshot: CloudApiClientSnapshot): StoredAuth {
  return {
    apiUrl: snapshot.apiUrl,
    accessToken: snapshot.accessToken,
    refreshToken: snapshot.refreshToken,
    accessTokenExpiresAt: snapshot.accessTokenExpiresAt,
    ...(snapshot.refreshTokenExpiresAt ? { refreshTokenExpiresAt: snapshot.refreshTokenExpiresAt } : {}),
  };
}

function toCloudApiClientSnapshot(auth: StoredAuth): CloudApiClientSnapshot {
  return auth;
}

function apiFetch(
  apiUrl: string,
  accessToken: string,
  requestPath: string,
  init: RequestInit
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('authorization', `Bearer ${accessToken}`);
  appendAgentRelayTelemetryHeaders(headers);

  return fetch(buildApiUrl(apiUrl, requestPath), {
    ...init,
    headers,
  });
}

export async function authorizedApiFetch(
  auth: StoredAuth,
  requestPath: string,
  init: RequestInit,
  options: {
    interactive?: boolean;
    refreshTimeoutMs?: number;
    /**
     * Force the device flow for the re-login below. Callers here are mid-request
     * rather than mid-`login`, so nobody passes an explicit `--device`; left
     * unset, a headless host still picks the device flow automatically.
     */
    device?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ response: Response; auth: StoredAuth }> {
  let activeAuth = auth;
  let response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);

  if (response.status !== 401) {
    return { response, auth: activeAuth };
  }

  // API keys are deliberately non-refreshing. Return the Cloud 401 to the
  // caller so unattended automation fails closed instead of attempting token
  // rotation or opening an interactive login flow.
  if (isApiKeyAuth(activeAuth)) {
    return { response, auth: activeAuth };
  }

  try {
    activeAuth = await refreshStoredAuth(activeAuth, {
      force: true,
      refreshTimeoutMs: options.refreshTimeoutMs,
      signal: init.signal ?? undefined,
    });
  } catch (error) {
    if (isEnvBackedAuth(activeAuth)) {
      throw toEnvAuthRefreshError(error);
    }

    if (options.interactive === false) {
      throw error;
    }

    // A caller that already aborted gets its cancellation back, not a login.
    // The device flow blocks for the grant lifetime — minutes — so starting one
    // here would leave a cancelled CLI or workflow waiting on authorization it
    // never asked for. The browser flow masked this by resolving sooner.
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new Error('Cloud request aborted before re-authentication');
    }

    // Must go through the same selector `ensureCloudSession` uses. Calling the
    // browser flow directly here stranded exactly the machine this feature
    // exists for: a headless host completes the device flow once, then its
    // first re-auth sits on a loopback callback it can never reach.
    activeAuth = await loginInteractive(activeAuth.apiUrl, {
      device: options.device,
      env: options.env,
    });
  }

  response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);
  return { response, auth: activeAuth };
}
