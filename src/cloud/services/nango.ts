import crypto from 'crypto';
import { Nango } from '@nangohq/node';
import type { AxiosResponse } from 'axios';
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
   * Nango will refresh the token when refreshGithubAppJwtToken=true.
   */
  async getGithubAppToken(connectionId: string): Promise<string> {
    const token = await this.client.getToken(
      NANGO_INTEGRATIONS.GITHUB_APP,
      connectionId,
      false,
      true
    );
    if (typeof token !== 'string') {
      throw new Error('Expected GitHub App token to be a string');
    }
    return token;
  }

  /**
   * List repositories available to a GitHub App installation using the Nango connection.
   */
  async listGithubAppRepos(connectionId: string): Promise<{ repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }> }> {
    const token = await this.getGithubAppToken(connectionId);
    const response = await fetch('https://api.github.com/installation/repositories?per_page=100', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to list installation repositories: ${text}`);
    }
    return response.json() as Promise<{ repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }> }>;
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
   * Verify webhook signature sent by Nango using HMAC SHA256 with the secret key.
   */
  verifyWebhookSignature(rawBody: string, signature?: string | string[] | null): boolean {
    if (!signature || typeof signature !== 'string') return false;
    const expected = crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex');
    return signature === expected;
  }
}

export const nangoService = new NangoService();
