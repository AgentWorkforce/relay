import { WebClient } from '@slack/web-api';

import { BaseSlackAdapter, normalizeSlackRuntimeConfig } from './adapter.js';
import { SlackPostBackError, type SlackRuntime, type SlackRuntimeConfig, type SlackWebApiLike } from './types.js';

/**
 * Local Slack Web API adapter backed by SLACK_BOT_TOKEN.
 */
export class SlackWebApiClient extends BaseSlackAdapter {
  constructor(config: SlackRuntimeConfig = {}, slack?: SlackWebApiLike) {
    const normalized = normalizeSlackRuntimeConfig(config);
    if (!normalized.token) {
      throw new SlackPostBackError(
        'auth_token_missing',
        'auth_token_missing: SLACK_BOT_TOKEN is required for Slack local runtime.'
      );
    }

    super(normalized, slack ?? createSlackWebClient(normalized.token, normalized.timeout));
  }

  getRuntime(): SlackRuntime {
    return 'local';
  }
}

/**
 * Create a Slack WebClient instance.
 * @param token - Slack bot token.
 * @param timeout - Request timeout in milliseconds.
 * @returns Slack Web API compatible client.
 */
export function createSlackWebClient(token: string, timeout: number): SlackWebApiLike {
  return new WebClient(token, { timeout }) as SlackWebApiLike;
}
