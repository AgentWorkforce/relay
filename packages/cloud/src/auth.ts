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
  AUTH_FILE_PATH,
  DEFAULT_REFRESH_TIMEOUT_MS,
  LEGACY_AUTH_FILE_PATH,
  REFRESH_TOKEN_WINDOW_MS,
  REFRESH_WINDOW_MS,
  CloudAuthError,
  defaultApiUrl,
  type CloudSession,
  type CloudSessionOptions,
  type StoredAuth,
} from './types.js';

const AUTH_DIR_PATH = path.dirname(AUTH_FILE_PATH);
const AUTH_LOCK_PATH = `${AUTH_FILE_PATH}.lock`;
const AUTH_LOCK_RETRY_DELAY_MS = 50;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_TIMEOUT_MS = 30_000;

const envBackedAuth = new WeakSet<StoredAuth>();

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

  if (refreshTokenExpiresAt && Number.isNaN(Date.parse(refreshTokenExpiresAt))) {
    return null;
  }

  return markEnvBackedAuth({
    apiUrl,
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
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

  const stored = await readCanonicalStoredAuth();
  if (stored) {
    return stored;
  }

  try {
    const legacyFile = await fs.readFile(LEGACY_AUTH_FILE_PATH, 'utf8');
    const parsed = JSON.parse(legacyFile) as unknown;
    if (!isValidStoredAuth(parsed)) {
      return null;
    }

    await writeStoredAuth(parsed);
    return parsed;
  } catch {
    return null;
  }
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

  const nextAuth: StoredAuth = {
    apiUrl: typeof payload.apiUrl === 'string' && payload.apiUrl.trim() ? payload.apiUrl.trim() : auth.apiUrl,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
    ...(payload.refreshTokenExpiresAt ? { refreshTokenExpiresAt: payload.refreshTokenExpiresAt } : {}),
  };

  return nextAuth;
}

async function loginWithBrowser(apiUrl: string): Promise<StoredAuth> {
  const auth = await beginBrowserLogin(apiUrl);
  await writeStoredAuth(auth);
  console.log(`Logged in to ${auth.apiUrl}`);
  return auth;
}

export async function ensureAuthenticated(
  apiUrl: string,
  options?: { force?: boolean; interactive?: boolean; refreshTimeoutMs?: number }
): Promise<StoredAuth> {
  const session = await ensureCloudSession({
    apiUrl,
    force: options?.force,
    interactive: options?.interactive,
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
      throw browserRequired('Cloud login required. Run `agent-relay login`.');
    }
    const auth = await loginWithBrowser(apiUrl);
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

    const auth = await loginWithBrowser(stored.apiUrl);
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
  options: { interactive?: boolean; refreshTimeoutMs?: number } = {}
): Promise<{ response: Response; auth: StoredAuth }> {
  let activeAuth = auth;
  let response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);

  if (response.status !== 401) {
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

    activeAuth = await loginWithBrowser(activeAuth.apiUrl);
  }

  response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);
  return { response, auth: activeAuth };
}
