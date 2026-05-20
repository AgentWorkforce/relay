import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { buildApiUrl } from './api-client.js';
import {
  AUTH_FILE_PATH,
  LEGACY_AUTH_FILE_PATH,
  REFRESH_WINDOW_MS,
  type CloudAuthFile,
  type CliLoginPollResponse,
  type CloudLoginWorkspace,
  type StoredAuth,
} from './types.js';

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
  });
}

function toEnvAuthRefreshError(error: unknown): Error {
  const message = error instanceof Error && error.message ? `${error.message}. ` : '';

  return new Error(
    `${message}Env-backed cloud auth could not be refreshed interactively; re-provision CLOUD_API_URL, CLOUD_API_ACCESS_TOKEN, CLOUD_API_REFRESH_TOKEN, and CLOUD_API_ACCESS_TOKEN_EXPIRES_AT.`,
    error instanceof Error ? { cause: error } : undefined
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
    typeof auth.apiUrl === 'string'
  );
}

function isValidCloudAuthFile(value: unknown): value is CloudAuthFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const auth = value as Partial<CloudAuthFile>;
  return (
    typeof auth.cloudToken === 'string' &&
    typeof auth.expiresAt === 'string' &&
    typeof auth.apiUrl === 'string'
  );
}

/**
 * Validates that `apiUrl` parses as a well-formed http/https URL. The auth
 * file is user-writable (`~/.config/agent-relay/cloud.json`) and its
 * `apiUrl` feeds directly into `fetch()` via `buildApiUrl`, so we must
 * reject untrusted shapes — `file://`, `javascript:`, malformed strings —
 * before letting them flow into an outbound network request. CodeQL flags
 * this as "file data in outbound network request"; this validator is the
 * mitigation. Env-backed auth already runs the same check in `readEnvAuth`.
 */
function isAcceptableApiUrl(apiUrl: unknown): apiUrl is string {
  if (typeof apiUrl !== 'string' || apiUrl.trim() === '') return false;
  try {
    const parsed = new URL(apiUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function storedAuthFromDisk(value: unknown): StoredAuth | null {
  if (isValidCloudAuthFile(value)) {
    if (!isAcceptableApiUrl(value.apiUrl)) return null;
    return {
      apiUrl: value.apiUrl,
      accessToken: value.cloudToken,
      // Round-trip the refresh token when present. Older auth files written
      // before the round-trip fix have no refreshToken field; default to ''
      // so the existing "no refresh token → interactive login" guard fires
      // instead of throwing on a missing property.
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : '',
      accessTokenExpiresAt: value.expiresAt,
      userId: value.userId,
      workspaces: readWorkspaces(value.workspaces),
    };
  }

  if (isValidStoredAuth(value) && isAcceptableApiUrl(value.apiUrl)) return value;
  return null;
}

function cloudAuthFileFromStoredAuth(auth: StoredAuth): CloudAuthFile {
  return {
    apiUrl: auth.apiUrl,
    cloudToken: auth.accessToken,
    // Persist the refresh token so the next process start can refresh the
    // access token non-interactively. Omit the field entirely when no
    // refresh token is available (env-backed auth, or pre-refresh-token
    // poll responses) to keep the on-disk shape clean.
    ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
    userId: auth.userId,
    workspaces: auth.workspaces,
    expiresAt: auth.accessTokenExpiresAt,
  };
}

export async function readStoredAuth(env: NodeJS.ProcessEnv = process.env): Promise<StoredAuth | null> {
  const envAuth = readEnvAuth(env);
  if (envAuth) {
    return envAuth;
  }

  for (const authPath of [AUTH_FILE_PATH, LEGACY_AUTH_FILE_PATH]) {
    try {
      const file = await fs.readFile(authPath, 'utf8');
      const parsed = JSON.parse(file) as unknown;
      const auth = storedAuthFromDisk(parsed);
      if (auth) {
        return auth;
      }
    } catch (error) {
      // Only fall back to the legacy path when the primary file is simply
      // absent. A malformed JSON file, an EACCES permission failure, or any
      // other read error must surface (return null here) instead of silently
      // resurrecting stale credentials from LEGACY_AUTH_FILE_PATH — that
      // would mask the real problem from the user.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return null;
      }
      // ENOENT → try the next path. The legacy path keeps older installs
      // readable.
    }
  }

  return null;
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  await fs.mkdir(path.dirname(AUTH_FILE_PATH), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(AUTH_FILE_PATH, `${JSON.stringify(cloudAuthFileFromStoredAuth(auth), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // `fs.writeFile`'s `mode` option only applies when the file is being
  // created — it is a no-op when the file already exists. An explicit chmod
  // after the write guarantees existing token files are tightened to 0o600
  // even when the prior file was world-readable (e.g. left over from a
  // user-driven `chmod 644`, or written by an older agent-relay version
  // that did not pass the mode option at all).
  await fs.chmod(AUTH_FILE_PATH, 0o600);
}

export async function clearStoredAuth(): Promise<void> {
  await fs.rm(AUTH_FILE_PATH, { force: true });
  await fs.rm(LEGACY_AUTH_FILE_PATH, { force: true });
}

function shouldRefresh(accessTokenExpiresAt: string): boolean {
  const expiresAt = Date.parse(accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) {
    return true;
  }

  return expiresAt - Date.now() <= REFRESH_WINDOW_MS;
}

function openBrowser(url: string) {
  if (process.env.AGENT_RELAY_NO_BROWSER === '1') {
    return null;
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    return spawn('open', [url], { stdio: 'ignore', detached: true });
  }

  if (platform === 'win32') {
    return spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  }

  return spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
}

function generateCliLoginCode(): string {
  return `c_${randomBytes(24).toString('base64url')}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readWorkspaces(value: unknown): CloudLoginWorkspace[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is CloudLoginWorkspace => {
    return entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string';
  });
}

function isPendingCliLoginResponse(response: Response, payload: CliLoginPollResponse | null): boolean {
  return response.status === 202 || payload?.status === 'pending' || payload?.status === 'unclaimed';
}

function resolvePollError(response: Response, payload: CliLoginPollResponse | null): string {
  return (
    readString(payload?.error) ??
    readString(payload?.message) ??
    `Cloud login poll failed with HTTP ${response.status}`
  );
}

function storedAuthFromPollPayload(apiUrl: string, payload: CliLoginPollResponse): StoredAuth | null {
  const tokenFromObject =
    payload.token && typeof payload.token === 'object' ? readString(payload.token.value) : undefined;
  const cloudToken =
    readString(payload.cloudToken) ?? readString(payload.accessToken) ?? readString(payload.token) ?? tokenFromObject;

  if (!cloudToken) {
    return null;
  }

  const tokenExpiresAt =
    readString(payload.accessTokenExpiresAt) ??
    readString(payload.expiresAt) ??
    (payload.token && typeof payload.token === 'object' ? readString(payload.token.expiresAt) : undefined) ??
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  // Preserve the refresh token when the poll response surfaces one, so the
  // file round-trip (storedAuthFromDisk → writeStoredAuth → ...) can later
  // refresh the access token non-interactively. Older cloud API builds did
  // not return a refresh token, in which case we keep refreshToken: '' and
  // the existing "no refresh token → interactive login" guard fires.
  const refreshToken =
    readString(payload.refreshToken) ??
    (payload.token && typeof payload.token === 'object' ? readString(payload.token.refreshToken) : undefined) ??
    '';

  return {
    apiUrl,
    accessToken: cloudToken,
    refreshToken,
    accessTokenExpiresAt: tokenExpiresAt,
    userId: readString(payload.userId),
    workspaces: readWorkspaces(payload.workspaces),
  };
}

async function pollCliLoginCode(
  apiUrl: string,
  code: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    perRequestTimeoutMs?: number;
  } = {}
): Promise<StoredAuth> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  // Each poll request gets its own timeout so a single stuck fetch can't
  // block past the overall login deadline. Default 10s per request, capped
  // by the remaining deadline so the last poll never outlives `timeoutMs`.
  const perRequestTimeoutMs = options.perRequestTimeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pollUrl = buildApiUrl(apiUrl, '/api/v1/auth/cli-login/poll');
    pollUrl.searchParams.set('code', code);

    const remaining = deadline - Date.now();
    const requestBudget = Math.max(0, Math.min(perRequestTimeoutMs, remaining));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestBudget);
    let response: Response;
    try {
      response = await fetch(pollUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      // AbortError → this single poll exceeded its budget. Continue the
      // outer loop so the deadline check decides whether to keep going.
      if (error instanceof Error && error.name === 'AbortError') {
        if (Date.now() >= deadline) break;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs));
        continue;
      }
      throw error;
    }
    clearTimeout(timer);
    const payload = (await response.json().catch(() => null)) as CliLoginPollResponse | null;

    if (isPendingCliLoginResponse(response, payload)) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    if (!response.ok) {
      throw new Error(resolvePollError(response, payload));
    }

    const auth = payload ? storedAuthFromPollPayload(apiUrl, payload) : null;
    if (!auth) {
      throw new Error('Cloud login poll response was missing cloudToken');
    }

    return auth;
  }

  throw new Error('Timed out waiting for browser login');
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
  const code = generateCliLoginCode();
  const loginUrl = buildApiUrl(apiUrl, '/cli-login');
  loginUrl.searchParams.set('code', code);

  console.log(`Opening browser for cloud login: ${loginUrl.toString()}`);
  console.log('If the browser does not open, paste this URL into your browser.');

  try {
    const child = openBrowser(loginUrl.toString());
    child?.unref();
  } catch {
    // Browser open failure is non-fatal; user still has the URL.
  }

  return pollCliLoginCode(apiUrl, code);
}

async function beginCallbackBrowserLogin(apiUrl: string): Promise<StoredAuth> {
  const state = crypto.randomUUID();

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
        redirectToHostedCliAuthPage(response, apiUrl, {
          status: 'error',
          detail: 'Invalid state parameter',
        });
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error('Invalid state parameter in CLI login callback'));
        }
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
        child?.unref();
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

export async function refreshStoredAuth(auth: StoredAuth): Promise<StoredAuth> {
  if (!auth.refreshToken) {
    throw new Error('Stored cloud login has expired');
  }

  const response = await fetch(buildApiUrl(auth.apiUrl, '/api/v1/auth/token/refresh'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ refreshToken: auth.refreshToken }),
  });

  const payload = (await response.json().catch(() => null)) as {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
  } | null;

  if (!response.ok || !payload?.accessToken || !payload?.refreshToken || !payload?.accessTokenExpiresAt) {
    throw new Error('Stored cloud login has expired');
  }

  const nextAuth: StoredAuth = {
    apiUrl: auth.apiUrl,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
  };

  if (isEnvBackedAuth(auth)) {
    return markEnvBackedAuth(nextAuth);
  }

  await writeStoredAuth(nextAuth);
  return nextAuth;
}

async function loginWithBrowser(apiUrl: string): Promise<StoredAuth> {
  const auth =
    process.env.AGENT_RELAY_CLI_LOGIN_FLOW === 'callback'
      ? await beginCallbackBrowserLogin(apiUrl)
      : await beginBrowserLogin(apiUrl);
  await writeStoredAuth(auth);
  console.log(`Logged in to ${auth.apiUrl}`);
  return auth;
}

export async function ensureAuthenticated(
  apiUrl: string,
  options?: { force?: boolean }
): Promise<StoredAuth> {
  const force = options?.force === true;
  const stored = !force ? await readStoredAuth() : null;

  // Stored auth is authoritative on its own host. A host mismatch between
  // `apiUrl` (typically defaultApiUrl()) and `stored.apiUrl` is NOT a reason
  // to force a fresh browser login — the user already linked, and the default
  // may have drifted (e.g. CLOUD_API_URL env set/unset between sessions).
  // Only `--force` re-links to a different host.
  if (!stored) {
    return loginWithBrowser(apiUrl);
  }

  if (!shouldRefresh(stored.accessTokenExpiresAt)) {
    return stored;
  }

  try {
    return await refreshStoredAuth(stored);
  } catch (error) {
    if (isEnvBackedAuth(stored)) {
      throw toEnvAuthRefreshError(error);
    }

    return loginWithBrowser(stored.apiUrl);
  }
}

function apiFetch(
  apiUrl: string,
  accessToken: string,
  requestPath: string,
  init: RequestInit
): Promise<Response> {
  return fetch(buildApiUrl(apiUrl, requestPath), {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  });
}

export async function authorizedApiFetch(
  auth: StoredAuth,
  requestPath: string,
  init: RequestInit
): Promise<{ response: Response; auth: StoredAuth }> {
  let activeAuth = auth;
  let response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);

  if (response.status !== 401) {
    return { response, auth: activeAuth };
  }

  try {
    activeAuth = await refreshStoredAuth(activeAuth);
  } catch (error) {
    if (isEnvBackedAuth(activeAuth)) {
      throw toEnvAuthRefreshError(error);
    }

    activeAuth = await loginWithBrowser(activeAuth.apiUrl);
  }

  response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);
  return { response, auth: activeAuth };
}
