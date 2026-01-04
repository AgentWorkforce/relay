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
