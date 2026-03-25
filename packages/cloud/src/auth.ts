import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildApiUrl } from "./api-client.js";
import { AUTH_FILE_PATH, REFRESH_WINDOW_MS, type StoredAuth } from "./types.js";

function isValidStoredAuth(value: unknown): value is StoredAuth {
  if (!value || typeof value !== "object") {
    return false;
  }

  const auth = value as Partial<StoredAuth>;
  return (
    typeof auth.accessToken === "string" &&
    typeof auth.refreshToken === "string" &&
    typeof auth.accessTokenExpiresAt === "string" &&
    typeof auth.apiUrl === "string"
  );
}

export async function readStoredAuth(): Promise<StoredAuth | null> {
  try {
    const file = await fs.readFile(AUTH_FILE_PATH, "utf8");
    const parsed = JSON.parse(file) as unknown;
    return isValidStoredAuth(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  await fs.mkdir(path.dirname(AUTH_FILE_PATH), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(AUTH_FILE_PATH, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearStoredAuth(): Promise<void> {
  await fs.rm(AUTH_FILE_PATH, { force: true });
}

function shouldRefresh(accessTokenExpiresAt: string): boolean {
  const expiresAt = Date.parse(accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) {
    return true;
  }

  return expiresAt - Date.now() <= REFRESH_WINDOW_MS;
}

function openBrowser(url: string) {
  const platform = os.platform();

  if (platform === "darwin") {
    return spawn("open", [url], { stdio: "ignore", detached: true });
  }

  if (platform === "win32") {
    return spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
  }

  return spawn("xdg-open", [url], { stdio: "ignore", detached: true });
}

function redirectToHostedCliAuthPage(
  response: http.ServerResponse<http.IncomingMessage>,
  apiUrl: string,
  options: {
    status: "success" | "error";
    detail?: string;
  },
): void {
  const resultUrl = buildApiUrl(apiUrl, "/cli/auth-result");
  resultUrl.searchParams.set("status", options.status);
  if (options.detail) {
    resultUrl.searchParams.set("detail", options.detail);
  }

  response.statusCode = 302;
  response.setHeader("location", resultUrl.toString());
  response.end();
}

async function beginBrowserLogin(apiUrl: string): Promise<StoredAuth> {
  const state = crypto.randomUUID();

  return new Promise<StoredAuth>((resolve, reject) => {
    let settled = false;

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

      if (requestUrl.pathname !== "/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const accessToken = requestUrl.searchParams.get("access_token");
      const refreshToken = requestUrl.searchParams.get("refresh_token");
      const accessTokenExpiresAt = requestUrl.searchParams.get("access_token_expires_at");
      const returnedApiUrl = requestUrl.searchParams.get("api_url");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        redirectToHostedCliAuthPage(response, apiUrl, {
          status: "error",
          detail: error,
        });
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error(error));
        }
        return;
      }

      if (
        returnedState !== state ||
        !accessToken ||
        !refreshToken ||
        !accessTokenExpiresAt ||
        !returnedApiUrl
      ) {
        redirectToHostedCliAuthPage(response, apiUrl, {
          status: "error",
          detail: "Expected access token, refresh token, API URL, and expiration timestamp.",
        });
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error("CLI login callback was missing required fields"));
        }
        return;
      }

      redirectToHostedCliAuthPage(response, returnedApiUrl, {
        status: "success",
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

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error("Failed to start local callback server"));
        }
        return;
      }

      const callbackUrl = new URL("/callback", `http://127.0.0.1:${address.port}`);
      const loginUrl = buildApiUrl(apiUrl, "/api/v1/cli/login");
      loginUrl.searchParams.set("redirect_uri", callbackUrl.toString());
      loginUrl.searchParams.set("state", state);

      console.log(`Opening browser for cloud login: ${loginUrl.toString()}`);
      console.log("If the browser does not open, paste this URL into your browser.");

      try {
        const child = openBrowser(loginUrl.toString());
        child.unref();
      } catch {
        // Browser open failure is non-fatal; user still has the URL.
      }
    });

    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("Timed out waiting for browser login"));
      }
    }, 5 * 60_000).unref();
  });
}

export async function refreshStoredAuth(auth: StoredAuth): Promise<StoredAuth> {
  const response = await fetch(buildApiUrl(auth.apiUrl, "/api/v1/auth/token/refresh"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ refreshToken: auth.refreshToken }),
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        accessToken?: string;
        refreshToken?: string;
        accessTokenExpiresAt?: string;
      }
    | null;

  if (!response.ok || !payload?.accessToken || !payload?.refreshToken || !payload?.accessTokenExpiresAt) {
    throw new Error("Stored cloud login has expired");
  }

  const nextAuth: StoredAuth = {
    apiUrl: auth.apiUrl,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
  };
  await writeStoredAuth(nextAuth);
  return nextAuth;
}

async function loginWithBrowser(apiUrl: string): Promise<StoredAuth> {
  const auth = await beginBrowserLogin(apiUrl);
  await writeStoredAuth(auth);
  console.log(`Logged in to ${auth.apiUrl}`);
  return auth;
}

export async function ensureAuthenticated(apiUrl: string, options?: { force?: boolean }): Promise<StoredAuth> {
  const force = options?.force === true;
  const stored = !force ? await readStoredAuth() : null;

  if (!stored || stored.apiUrl !== apiUrl) {
    return loginWithBrowser(apiUrl);
  }

  if (!shouldRefresh(stored.accessTokenExpiresAt)) {
    return stored;
  }

  try {
    return await refreshStoredAuth(stored);
  } catch {
    return loginWithBrowser(apiUrl);
  }
}

function apiFetch(
  apiUrl: string,
  accessToken: string,
  requestPath: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(buildApiUrl(apiUrl, requestPath), {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  });
}

export async function authorizedApiFetch(
  auth: StoredAuth,
  requestPath: string,
  init: RequestInit,
): Promise<{ response: Response; auth: StoredAuth }> {
  let activeAuth = auth;
  let response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);

  if (response.status !== 401) {
    return { response, auth: activeAuth };
  }

  try {
    activeAuth = await refreshStoredAuth(activeAuth);
  } catch {
    activeAuth = await loginWithBrowser(activeAuth.apiUrl);
  }

  response = await apiFetch(activeAuth.apiUrl, activeAuth.accessToken, requestPath, init);
  return { response, auth: activeAuth };
}
