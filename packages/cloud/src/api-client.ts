import { CloudAuthError, DEFAULT_REFRESH_TIMEOUT_MS, REFRESH_WINDOW_MS } from './types.js';
import { appendAgentRelayTelemetryHeaders } from './telemetry-headers.js';

export type CloudApiClientOptions = {
  apiUrl: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
  refreshTimeoutMs?: number;
  refreshAuth?: (
    snapshot: CloudApiClientSnapshot,
    options: { force: boolean; signal?: AbortSignal }
  ) => Promise<CloudApiClientSnapshot>;
  onRefresh?: (snapshot: CloudApiClientSnapshot) => void | Promise<void>;
};

export type CloudApiClientSnapshot = {
  apiUrl: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
};

type HeaderInput = ConstructorParameters<typeof Headers>[0];

function trimLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

function withTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
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
    await this.refresh(false, init.signal ?? undefined);

    const response = await fetch(buildApiUrl(this.options.apiUrl, p), {
      ...init,
      headers: this.buildHeaders(init.headers),
    });

    if (response.status !== 401) {
      return response;
    }

    await this.refresh(true, init.signal ?? undefined);

    return fetch(buildApiUrl(this.options.apiUrl, p), {
      ...init,
      headers: this.buildHeaders(init.headers),
    });
  }

  async revoke(): Promise<void> {
    const response = await fetch(buildApiUrl(this.options.apiUrl, '/api/v1/auth/token/revoke'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: this.refreshToken }),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to revoke API token: ${response.status} ${response.statusText}`);
    }
  }

  private async refresh(force = false, signal?: AbortSignal): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    if (!force && !this.shouldRefresh()) {
      return;
    }

    this.refreshPromise = this.doRefresh(force, signal).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async doRefresh(force: boolean, signal?: AbortSignal): Promise<void> {
    if (this.options.refreshAuth) {
      this.applySnapshot(await this.options.refreshAuth(this.snapshot(), { force, signal }));
      await this.options.onRefresh?.(this.snapshot());
      return;
    }

    this.applySnapshot(await this.requestRefresh(signal));
    await this.options.onRefresh?.(this.snapshot());
  }

  private async requestRefresh(signal?: AbortSignal): Promise<CloudApiClientSnapshot> {
    const refreshTimeoutMs = this.options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort();
    };

    if (signal) {
      if (signal.aborted) {
        callerAborted = true;
        controller.abort();
      } else {
        signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, refreshTimeoutMs);

    let response: Response;
    try {
      response = await fetch(buildApiUrl(this.options.apiUrl, '/api/v1/auth/token/refresh'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || (!callerAborted && error instanceof Error && error.name === 'AbortError')) {
        throw new CloudAuthError(
          'AUTH_REFRESH_TIMEOUT',
          `Cloud auth refresh timed out after ${refreshTimeoutMs}ms`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', abortFromCaller);
      }
    }

    if (!response.ok) {
      throw new CloudAuthError(
        'AUTH_REFRESH_EXPIRED',
        `Failed to refresh API token: ${response.status} ${response.statusText}`
      );
    }

    const payload = (await response.json()) as {
      accessToken?: string;
      accessTokenExpiresAt?: string;
      refreshToken?: string;
      refreshTokenExpiresAt?: string;
    };

    if (!payload.accessToken || !payload.accessTokenExpiresAt || !payload.refreshToken) {
      throw new CloudAuthError('AUTH_REFRESH_EXPIRED', 'Refresh response missing token fields');
    }

    return {
      apiUrl: this.options.apiUrl,
      accessToken: payload.accessToken,
      accessTokenExpiresAt: payload.accessTokenExpiresAt,
      refreshToken: payload.refreshToken,
      ...(payload.refreshTokenExpiresAt ? { refreshTokenExpiresAt: payload.refreshTokenExpiresAt } : {}),
    };
  }

  private applySnapshot(snapshot: CloudApiClientSnapshot): void {
    this.accessToken = snapshot.accessToken;
    this.accessTokenExpiresAt = snapshot.accessTokenExpiresAt;
    this.refreshToken = snapshot.refreshToken;
    this.refreshTokenExpiresAt = snapshot.refreshTokenExpiresAt;
  }

  private buildHeaders(headers: HeaderInput | undefined): Headers {
    const merged = new Headers(headers);
    merged.set('Authorization', `Bearer ${this.accessToken}`);
    return appendAgentRelayTelemetryHeaders(merged);
  }

  private shouldRefresh(): boolean {
    const expiresAt = Date.parse(this.accessTokenExpiresAt);
    if (Number.isNaN(expiresAt)) {
      return true;
    }

    return expiresAt - Date.now() <= REFRESH_WINDOW_MS;
  }
}
