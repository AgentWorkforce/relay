import { Nango } from '@nangohq/node';
import type { AxiosResponse } from 'axios';
import crypto from 'node:crypto';
import { getConfig } from '../config.js';

export const NANGO_INTEGRATIONS = {
  GITHUB_USER: 'github',
  GITHUB_APP: 'github-app-oauth',
} as const;

export interface GithubUserProfile {
  id: number;
  login: string;
  email?: string;
  avatar_url?: string;
}

class NangoService {
  private client: Nango;
  private secret: string;

  constructor() {
    const config = getConfig();
    this.secret = config.nango.secretKey;
    this.client = new Nango({
      secretKey: config.nango.secretKey,
      ...(config.nango.host ? { host: config.nango.host } : {}),
    });
  }

  /**
   * Create a Nango connect session restricted to specific integrations.
   */
  async createConnectSession(allowedIntegrations: string[], endUser: { id: string; email?: string }) {
    const { data } = await this.client.createConnectSession({
      allowed_integrations: allowedIntegrations,
      end_user: {
        id: endUser.id,
        email: endUser.email,
      },
    });
    return data;
  }

  /**
   * Fetch GitHub user profile via Nango proxy.
   */
  async getGithubUser(connectionId: string): Promise<GithubUserProfile> {
    const response = await this.client.get<GithubUserProfile>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATIONS.GITHUB_USER,
      endpoint: '/user',
    }) as AxiosResponse<GithubUserProfile>;
    return response.data;
  }

  /**
   * Retrieve an installation access token from a GitHub App connection.
   * Use this ONLY when you need the raw token (e.g., for git clone URLs).
   * For API calls, use the proxy methods instead.
   */
  async getGithubAppToken(connectionId: string): Promise<string> {
    try {
      const token = await this.client.getToken(
        NANGO_INTEGRATIONS.GITHUB_APP,
        connectionId,
        false,
        true
      );

      // Handle different return formats from Nango
      if (typeof token === 'string') {
        return token;
      }

      // Nango may return an object with access_token
      if (token && typeof token === 'object') {
        const tokenObj = token as { access_token?: string; token?: string };
        if (tokenObj.access_token) {
          return tokenObj.access_token;
        }
        if (tokenObj.token) {
          return tokenObj.token;
        }
      }

      console.error('[nango] Unexpected token format:', typeof token, token);
      throw new Error('Expected GitHub App token to be a string');
    } catch (err: unknown) {
      // Handle 404 (connection not found) gracefully
      const error = err as { response?: { status?: number }; status?: number };
      const status = error.response?.status || error.status;
      if (status === 404) {
        throw new Error(`GitHub App connection not found: ${connectionId} (may have been disconnected)`);
      }
      // Re-throw with cleaner message
      throw new Error(`Failed to get GitHub App token: ${(err as Error).message || 'Unknown error'}`);
    }
  }

  /**
   * Retrieve the user's OAuth access token from a GitHub App OAuth connection.
   * This is the user-level token (not the installation token).
   * Use this for operations that require user context (e.g., gh CLI).
   *
   * The user token is stored in connection_config.userCredentials.access_token
   * by Nango's GitHub App OAuth flow. This is a gho_* or ghu_* token that
   * works for both git operations and gh CLI commands.
   */
  async getGithubUserOAuthToken(connectionId: string): Promise<string> {
    try {
      const connection = await this.client.getConnection(NANGO_INTEGRATIONS.GITHUB_APP, connectionId);
      const connConfig = (connection as { connection_config?: Record<string, unknown> }).connection_config;

      // Check for userCredentials.access_token (the user's personal OAuth token)
      const userCredentials = connConfig?.userCredentials as { access_token?: string } | undefined;
      if (userCredentials?.access_token && typeof userCredentials.access_token === 'string') {
        return userCredentials.access_token;
      }

      throw new Error('No userCredentials.access_token in connection_config');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.log('[nango] getGithubUserOAuthToken failed:', message);
      throw new Error('Could not retrieve GitHub user OAuth token');
    }
  }

  /**
   * Retrieve the user's OAuth token from a 'github' user connection.
   * This is for the separate GitHub OAuth login (not the App connection).
   */
  async getGithubUserToken(connectionId: string): Promise<string> {
    const token = await this.client.getToken(
      NANGO_INTEGRATIONS.GITHUB_USER,
      connectionId
    );

    if (typeof token === 'string') {
      return token;
    }

    if (token && typeof token === 'object') {
      const tokenObj = token as { access_token?: string; token?: string };
      if (tokenObj.access_token) {
        return tokenObj.access_token;
      }
      if (tokenObj.token) {
        return tokenObj.token;
      }
    }

    throw new Error('Could not retrieve GitHub user token');
  }

  /**
   * List repositories available to a GitHub App installation using the Nango Proxy.
   * The proxy automatically handles token injection and refresh.
   * @see https://nango.dev/docs/implementation-guides/requests-proxy/implement-requests-proxy
   */
  async listGithubAppRepos(connectionId: string): Promise<{ repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }> }> {
    const response = await this.client.get<{ repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }> }>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATIONS.GITHUB_APP,
      endpoint: '/installation/repositories',
      params: { per_page: '100' },
    }) as AxiosResponse<{ repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }> }>;
    return response.data;
  }

  /**
   * Get the GitHub App installation ID from a connection.
   * The installation ID is stored in connection_config.installation_id
   */
  async getGithubAppInstallationId(connectionId: string): Promise<number | null> {
    try {
      const connection = await this.client.getConnection(NANGO_INTEGRATIONS.GITHUB_APP, connectionId);
      // Extract installation_id from connection_config (where Nango stores it for GitHub App OAuth)
      const connectionConfig = (connection as { connection_config?: Record<string, unknown> }).connection_config;
      if (connectionConfig?.installation_id) {
        return Number(connectionConfig.installation_id);
      }
      console.warn('[nango] No installation_id in connection_config');
      return null;
    } catch (err) {
      console.error('[nango] Failed to get installation ID:', err);
      return null;
    }
  }

  /**
   * Create an issue via Nango Proxy.
   */
  async createGithubIssue(
    connectionId: string,
    owner: string,
    repo: string,
    data: { title: string; body?: string; labels?: string[] }
  ): Promise<{ number: number; html_url: string }> {
    const response = await this.client.post<{ number: number; html_url: string }>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATIONS.GITHUB_APP,
      endpoint: `/repos/${owner}/${repo}/issues`,
      data,
    }) as AxiosResponse<{ number: number; html_url: string }>;
    return response.data;
  }

  /**
   * Create a pull request via Nango Proxy.
   */
  async createGithubPullRequest(
    connectionId: string,
    owner: string,
    repo: string,
    data: { title: string; body?: string; head: string; base: string }
  ): Promise<{ number: number; html_url: string }> {
    const response = await this.client.post<{ number: number; html_url: string }>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATIONS.GITHUB_APP,
      endpoint: `/repos/${owner}/${repo}/pulls`,
      data,
    }) as AxiosResponse<{ number: number; html_url: string }>;
    return response.data;
  }

  /**
   * Add a comment to an issue via Nango Proxy.
   */
  async addGithubIssueComment(
    connectionId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    const response = await this.client.post<{ id: number; html_url: string }>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATIONS.GITHUB_APP,
      endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      data: { body },
    }) as AxiosResponse<{ id: number; html_url: string }>;
    return response.data;
  }

  /**
   * Update connection end user metadata (e.g., after creating a user record).
   */
  async updateEndUser(connectionId: string, providerConfigKey: string, endUser: { id: string; email?: string }) {
    await this.client.patchConnection(
      { connectionId, provider_config_key: providerConfigKey },
      { end_user: endUser }
    );
  }

  /**
   * Delete a connection from Nango.
   *
   * Used to remove temporary session connections for returning users
   * to prevent duplicate connections in Nango. In the two-connection pattern,
   * new users get a permanent connection but returning users authenticate
   * with a temporary one that gets deleted.
   *
   * @param connectionId - Nango connection ID to delete
   * @param providerConfigKey - The integration key (e.g., 'github')
   */
  async deleteConnection(connectionId: string, providerConfigKey: string): Promise<void> {
    await this.client.deleteConnection(providerConfigKey, connectionId);
  }

  /**
   * Get connection metadata including end_user info.
   * Useful when webhook doesn't include end_user data.
   */
  async getConnection(connectionId: string, providerConfigKey: string): Promise<{
    id: number;
    connection_id: string;
    provider_config_key: string;
    end_user?: { id?: string; email?: string };
    metadata?: Record<string, unknown>;
  }> {
    const connection = await this.client.getConnection(providerConfigKey, connectionId);
    return connection as unknown as {
      id: number;
      connection_id: string;
      provider_config_key: string;
      end_user?: { id?: string; email?: string };
      metadata?: Record<string, unknown>;
    };
  }

  /**
   * Check if user has access to a specific GitHub repository.
   * Uses the user's OAuth connection to query GitHub API.
   * @param connectionId - User's Nango connection ID (github user OAuth)
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Access details or null if no access
   */
  async checkUserRepoAccess(connectionId: string, owner: string, repo: string): Promise<{
    hasAccess: boolean;
    permission?: 'admin' | 'write' | 'read' | 'none';
    repository?: {
      id: number;
      fullName: string;
      isPrivate: boolean;
      defaultBranch: string;
    };
  }> {
    try {
      const response = await this.client.get<{
        id: number;
        full_name: string;
        private: boolean;
        default_branch: string;
        permissions?: {
          admin: boolean;
          push: boolean;
          pull: boolean;
        };
      }>({
        connectionId,
        providerConfigKey: NANGO_INTEGRATIONS.GITHUB_USER,
        endpoint: `/repos/${owner}/${repo}`,
      }) as AxiosResponse<{
        id: number;
        full_name: string;
        private: boolean;
        default_branch: string;
        permissions?: {
          admin: boolean;
          push: boolean;
          pull: boolean;
        };
      }>;

      const data = response.data;
      let permission: 'admin' | 'write' | 'read' | 'none' = 'none';

      if (data.permissions) {
        if (data.permissions.admin) {
          permission = 'admin';
        } else if (data.permissions.push) {
          permission = 'write';
        } else if (data.permissions.pull) {
          permission = 'read';
        }
      }

      return {
        hasAccess: true,
        permission,
        repository: {
          id: data.id,
          fullName: data.full_name,
          isPrivate: data.private,
          defaultBranch: data.default_branch,
        },
      };
    } catch (err: unknown) {
      // 404 = no access or repo doesn't exist
      const error = err as { response?: { status?: number } };
      if (error.response?.status === 404 || error.response?.status === 403) {
        return { hasAccess: false };
      }
      console.error('[nango] checkUserRepoAccess error:', err);
      throw err;
    }
  }

  /**
   * List all repositories the user has access to via their OAuth connection.
   * Uses the user's personal OAuth token (not the GitHub App).
   * @param connectionId - User's Nango connection ID (github user OAuth)
   * @param options - Pagination and filter options
   * @returns List of accessible repositories
   */
  async listUserAccessibleRepos(connectionId: string, options?: {
    page?: number;
    perPage?: number;
    type?: 'all' | 'owner' | 'public' | 'private' | 'member';
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  }): Promise<{
    repositories: Array<{
      id: number;
      fullName: string;
      isPrivate: boolean;
      defaultBranch: string;
      permissions: {
        admin: boolean;
        push: boolean;
        pull: boolean;
      };
    }>;
    hasMore: boolean;
  }> {
    const page = options?.page ?? 1;
    const perPage = options?.perPage ?? 100;
    const type = options?.type ?? 'all';
    const sort = options?.sort ?? 'updated';

    const response = await this.client.get<Array<{
      id: number;
      full_name: string;
      private: boolean;
      default_branch: string;
      permissions?: {
        admin: boolean;
        push: boolean;
        pull: boolean;
      };
    }>>({
      connectionId,
      providerConfigKey: NANGO_INTEGRATIONS.GITHUB_USER,
      endpoint: '/user/repos',
      params: {
        page: String(page),
        per_page: String(perPage),
        type,
        sort,
        direction: 'desc',
      },
    }) as AxiosResponse<Array<{
      id: number;
      full_name: string;
      private: boolean;
      default_branch: string;
      permissions?: {
        admin: boolean;
        push: boolean;
        pull: boolean;
      };
    }>>;

    const repos = response.data || [];

    return {
      repositories: repos.map(r => ({
        id: r.id,
        fullName: r.full_name,
        isPrivate: r.private,
        defaultBranch: r.default_branch,
        permissions: r.permissions || { admin: false, push: false, pull: false },
      })),
      hasMore: repos.length === perPage,
    };
  }

  /**
   * List collaborators for a repository via Nango Proxy.
   * Uses the GitHub App connection to access repository collaborators.
   * @param connectionId - GitHub App connection ID
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns List of collaborators with their permissions
   */
  async listRepoCollaborators(connectionId: string, owner: string, repo: string): Promise<Array<{
    id: number;
    login: string;
    avatarUrl: string;
    permission: 'admin' | 'write' | 'read' | 'none';
  }>> {
    try {
      const response = await this.client.get<Array<{
        id: number;
        login: string;
        avatar_url: string;
        permissions?: {
          admin: boolean;
          maintain?: boolean;
          push: boolean;
          triage?: boolean;
          pull: boolean;
        };
        role_name?: string;
      }>>({
        connectionId,
        providerConfigKey: NANGO_INTEGRATIONS.GITHUB_APP,
        endpoint: `/repos/${owner}/${repo}/collaborators`,
        params: { per_page: '100' },
      }) as AxiosResponse<Array<{
        id: number;
        login: string;
        avatar_url: string;
        permissions?: {
          admin: boolean;
          maintain?: boolean;
          push: boolean;
          triage?: boolean;
          pull: boolean;
        };
        role_name?: string;
      }>>;

      return (response.data || []).map(collab => {
        let permission: 'admin' | 'write' | 'read' | 'none' = 'none';
        if (collab.permissions) {
          if (collab.permissions.admin) {
            permission = 'admin';
          } else if (collab.permissions.push) {
            permission = 'write';
          } else if (collab.permissions.pull) {
            permission = 'read';
          }
        }
        return {
          id: collab.id,
          login: collab.login,
          avatarUrl: collab.avatar_url,
          permission,
        };
      });
    } catch (err: unknown) {
      const error = err as { response?: { status?: number } };
      // 403 = no permission to view collaborators, 404 = repo not found
      if (error.response?.status === 403 || error.response?.status === 404) {
        console.warn(`[nango] Cannot list collaborators for ${owner}/${repo}: status ${error.response.status}`);
        return [];
      }
      console.error('[nango] listRepoCollaborators error:', err);
      throw err;
    }
  }

  /**
   * Verify webhook signature sent by Nango.
   * Uses the new verifyIncomingWebhookRequest method.
   * @see https://nango.dev/docs/reference/sdks/node#verify-webhook-signature
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    try {
      // Use the new method: verifyIncomingWebhookRequest(body, headers)
      return this.client.verifyIncomingWebhookRequest(rawBody, headers as Record<string, unknown>);
    } catch (err) {
      console.error('[nango] verifyIncomingWebhookRequest error:', err);
      // Fall back to manual HMAC verification using the secret key
      const signature = headers['x-nango-signature'] as string | undefined;
      const hmacSha256 = headers['x-nango-hmac-sha256'] as string | undefined;
      if (!signature && !hmacSha256) return false;

      const expectedSignature = crypto
        .createHmac('sha256', this.secret)
        .update(rawBody)
        .digest('hex');
      return signature === expectedSignature || hmacSha256 === expectedSignature;
    }
  }
}

export const nangoService = new NangoService();
