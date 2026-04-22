import { BaseGitHubAdapter } from './adapter.js';
import { appendQuery, trimTrailingSlash } from './actions/utils.js';
import { DEFAULT_NANGO_BASE_URL, DEFAULT_RELAY_CLOUD_GITHUB_PROXY_ENDPOINT } from './constants.js';
import {
  GitHubApiError,
  type GitHubApiRequestMethod,
  type GitHubApiRequestOptions,
  type GitHubRuntime,
  type GitHubRuntimeConfig,
  type GitHubUserSummary,
} from './types.js';

export interface NangoProxyRequestPayload {
  method: GitHubApiRequestMethod;
  path: string;
  query?: GitHubApiRequestOptions['query'];
  body?: unknown;
  headers?: Record<string, string>;
  nango?: {
    connectionId?: string;
    providerConfigKey?: string;
  };
}

export class NangoClient extends BaseGitHubAdapter {
  private lastNangoFallbackError: unknown;

  constructor(config: GitHubRuntimeConfig = {}) {
    super({
      ...config,
      runtime: 'cloud',
    });
  }

  getRuntime(): GitHubRuntime {
    return 'cloud';
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.getCurrentUser();
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentUser(): Promise<GitHubUserSummary> {
    const user = await this.request<{
      id?: number;
      login?: string;
      name?: string | null;
      type?: string;
    }>('GET', '/user');

    if (!user.login) {
      throw new GitHubApiError('GitHub user response did not include a login.');
    }

    return {
      login: user.login,
      name: user.name ?? undefined,
      id: user.id,
      type: user.type,
    };
  }

  async request<TResponse = unknown>(
    method: GitHubApiRequestMethod,
    path: string,
    options: GitHubApiRequestOptions = {}
  ): Promise<TResponse> {
    return this.executeWithRetries(async () => {
      if (this.hasNangoCredentials()) {
        try {
          return await this.requestViaNango<TResponse>(method, path, options);
        } catch (error) {
          if (!this.hasRelayCloudCredentials()) {
            throw error;
          }
          this.lastNangoFallbackError = error;
          try {
            return await this.requestViaRelayCloud<TResponse>(method, path, options);
          } catch (relayError) {
            throw new GitHubApiError(
              `Nango GitHub proxy failed, then relay-cloud fallback failed: ${errorMessage(relayError)}`,
              {
                cause: {
                  nango: error,
                  relayCloud: relayError,
                },
              }
            );
          }
        }
      }

      if (this.hasRelayCloudCredentials()) {
        return this.requestViaRelayCloud<TResponse>(method, path, options);
      }

      throw new GitHubApiError(
        'Cloud GitHub runtime requires Nango credentials or relay-cloud proxy configuration.'
      );
    });
  }

  /**
   * Returns the most recent Nango failure that triggered a relay-cloud fallback.
   */
  getLastNangoFallbackError(): unknown {
    return this.lastNangoFallbackError;
  }

  private async requestViaNango<TResponse>(
    method: GitHubApiRequestMethod,
    path: string,
    options: GitHubApiRequestOptions
  ): Promise<TResponse> {
    const secretKey = this.config.nango.secretKey;
    const connectionId = this.config.nango.connectionId;
    const providerConfigKey = this.config.nango.providerConfigKey;

    if (!secretKey || !connectionId || !providerConfigKey) {
      throw new GitHubApiError('Nango GitHub proxy requires secretKey, connectionId, and providerConfigKey.');
    }

    const url = buildNangoProxyUrl(this.config.nango.baseUrl, path, options.query);
    const response = await this.fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Connection-Id': connectionId,
        'Provider-Config-Key': providerConfigKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': this.config.userAgent,
        ...options.headers,
      },
      body: typeof options.body === 'undefined' ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      timeout: options.timeout,
    });

    return parseJsonResponse<TResponse>(response);
  }

  private async requestViaRelayCloud<TResponse>(
    method: GitHubApiRequestMethod,
    path: string,
    options: GitHubApiRequestOptions
  ): Promise<TResponse> {
    const apiUrl = this.config.relayCloud.apiUrl;
    const accessToken = this.config.relayCloud.accessToken;
    const endpoint = this.config.relayCloud.endpoint ?? DEFAULT_RELAY_CLOUD_GITHUB_PROXY_ENDPOINT;

    if (!apiUrl || !accessToken) {
      throw new GitHubApiError('Relay cloud GitHub proxy requires apiUrl and accessToken configuration.');
    }

    const payload: NangoProxyRequestPayload = {
      method,
      path,
      query: options.query,
      body: options.body,
      headers: options.headers,
      nango: {
        connectionId: this.config.nango.connectionId,
        providerConfigKey: this.config.nango.providerConfigKey,
      },
    };

    const response = await this.fetchWithTimeout(joinUrl(apiUrl, endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': this.config.userAgent,
        ...(this.config.relayCloud.workspaceId
          ? { 'X-Relay-Workspace-Id': this.config.relayCloud.workspaceId }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: options.signal,
      timeout: options.timeout,
    });

    const result = await parseJsonResponse<unknown>(response);
    if (
      typeof result === 'object' &&
      result !== null &&
      'data' in result &&
      Object.keys(result).some((key) => key === 'data')
    ) {
      return (result as { data: TResponse }).data;
    }

    return result as TResponse;
  }

  private async fetchWithTimeout(input: string, init: RequestInit & { timeout?: number }): Promise<Response> {
    const fetchImpl = this.config.fetch ?? fetch;
    const timeout = init.timeout ?? this.config.timeout;
    const signal = init.signal ?? AbortSignal.timeout(timeout);
    const { timeout: _timeout, ...requestInit } = init;

    return fetchImpl(input, {
      ...requestInit,
      signal,
    });
  }

  private hasNangoCredentials(): boolean {
    return Boolean(
      this.config.nango.secretKey && this.config.nango.connectionId && this.config.nango.providerConfigKey
    );
  }

  private hasRelayCloudCredentials(): boolean {
    return Boolean(this.config.relayCloud.apiUrl && this.config.relayCloud.accessToken);
  }
}

async function parseJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  const text = await response.text();

  if (!response.ok) {
    throw new GitHubApiError(
      text || `GitHub API request failed with ${response.status} ${response.statusText}`,
      {
        status: response.status,
        responseBody: text,
        responseHeaders: headersToRecord(response.headers),
      }
    );
  }

  if (!text.trim()) {
    return undefined as TResponse;
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (error) {
    throw new GitHubApiError(
      `Failed to parse GitHub API JSON response: ${error instanceof Error ? error.message : String(error)}`,
      {
        status: response.status,
        responseBody: text,
        responseHeaders: headersToRecord(response.headers),
        cause: error,
      }
    );
  }
}

function buildNangoProxyUrl(
  baseUrl: string | undefined,
  path: string,
  query: GitHubApiRequestOptions['query']
): string {
  const base = trimTrailingSlash(baseUrl) ?? DEFAULT_NANGO_BASE_URL;
  const endpoint = stripLeadingSlash(path);
  return appendQuery(`${base}/proxy/${endpoint}`, query);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl) ?? baseUrl}/${stripLeadingSlash(path)}`;
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
