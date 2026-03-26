import { REFRESH_WINDOW_MS } from "./types.js";

export type CloudApiClientOptions = {
  apiUrl: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
};

export type CloudApiClientSnapshot = {
  apiUrl: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
};

function trimLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

function withTrailingSlash(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

export function buildApiUrl(apiUrl: string, p: string): URL {
  return new URL(trimLeadingSlash(p), withTrailingSlash(apiUrl));
}

export class CloudApiClient {
  private accessToken: string;
  private refreshToken: string;
  private accessTokenExpiresAt: string;
  private refreshTokenExpiresAt?: string;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly options: CloudApiClientOptions) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.accessTokenExpiresAt = options.accessTokenExpiresAt;
    this.refreshTokenExpiresAt = options.refreshTokenExpiresAt;
  }

  static fromEnv(env: NodeJS.ProcessEnv): CloudApiClient | null {
    const apiUrl = env.CLOUD_API_URL?.trim();
    const accessToken = env.CLOUD_API_ACCESS_TOKEN?.trim();
    const refreshToken = env.CLOUD_API_REFRESH_TOKEN?.trim();
    const accessTokenExpiresAt = env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT?.trim();
    const refreshTokenExpiresAt = env.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT?.trim();

    if (!apiUrl || !accessToken || !refreshToken || !accessTokenExpiresAt) {
      return null;
    }

    return new CloudApiClient({
      apiUrl,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    });
  }

  snapshot(): CloudApiClientSnapshot {
    return {
      apiUrl: this.options.apiUrl,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
      ...(this.refreshTokenExpiresAt ? { refreshTokenExpiresAt: this.refreshTokenExpiresAt } : {}),
    };
  }

  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    await this.refresh();

    const response = await fetch(buildApiUrl(this.options.apiUrl, p), {
      ...init,
      headers: this.buildHeaders(init.headers),
    });

    if (response.status !== 401) {
      return response;
    }

    await this.refresh(true);

    return fetch(buildApiUrl(this.options.apiUrl, p), {
      ...init,
      headers: this.buildHeaders(init.headers),
    });
  }

  async revoke(): Promise<void> {
    const response = await fetch(buildApiUrl(this.options.apiUrl, "/api/v1/auth/token/revoke"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: this.refreshToken }),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to revoke API token: ${response.status} ${response.statusText}`);
    }
  }

  private async refresh(force = false): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    if (!force && !this.shouldRefresh()) {
      return;
    }

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    const response = await fetch(buildApiUrl(this.options.apiUrl, "/api/v1/auth/token/refresh"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh API token: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      accessToken?: string;
      accessTokenExpiresAt?: string;
      refreshToken?: string;
      refreshTokenExpiresAt?: string;
    };

    if (!payload.accessToken || !payload.accessTokenExpiresAt || !payload.refreshToken) {
      throw new Error("Refresh response missing token fields");
    }

    this.accessToken = payload.accessToken;
    this.accessTokenExpiresAt = payload.accessTokenExpiresAt;
    this.refreshToken = payload.refreshToken;
    this.refreshTokenExpiresAt = payload.refreshTokenExpiresAt;
  }

  private buildHeaders(headers: HeadersInit | undefined): Headers {
    const merged = new Headers(headers);
    merged.set("Authorization", `Bearer ${this.accessToken}`);
    return merged;
  }

  private shouldRefresh(): boolean {
    const expiresAt = Date.parse(this.accessTokenExpiresAt);
    if (Number.isNaN(expiresAt)) {
      return true;
    }

    return expiresAt - Date.now() <= REFRESH_WINDOW_MS;
  }
}
