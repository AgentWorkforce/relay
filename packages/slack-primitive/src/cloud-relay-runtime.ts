import { BaseSlackAdapter, normalizeSlackRuntimeConfig } from './adapter.js';
import {
  SlackPostBackError,
  type PostMessageOutput,
  type PostMessageParams,
  type ResolveChannelParams,
  type ResolveUserParams,
  type SlackChannelSummary,
  type SlackResolutionWarning,
  type SlackResolvedMention,
  type SlackRuntime,
  type SlackRuntimeConfig,
  type SlackWebApiLike,
} from './types.js';

const POST_MESSAGE_PATH = '/api/v1/slack/post-message';

interface CloudRelayPostMessageSuccess {
  ok: true;
  ts: string;
  channel: string;
  workspaceId: string;
}

interface CloudRelayPostMessageError {
  ok: false;
  error: string;
  code: string;
  retryAfterMs?: number;
}

type CloudRelayPostMessageResponse = CloudRelayPostMessageSuccess | CloudRelayPostMessageError;

export type CloudRelayFetch = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

/**
 * Slack adapter that proxies postMessage through relay-cloud's
 * /api/v1/slack/post-message endpoint, which uses the workspace's
 * configured Nango Slack connection (the ricky app).
 *
 * Used when the caller has CLOUD_API_TOKEN + CLOUD_API_URL but no local
 * SLACK_BOT_TOKEN. Resolve operations are not supported in this mode —
 * Phase A intentionally exposes only postMessage.
 */
export class SlackCloudRelayClient extends BaseSlackAdapter {
  private readonly fetchImpl: CloudRelayFetch;

  constructor(config: SlackRuntimeConfig = {}, fetchImpl?: CloudRelayFetch) {
    const normalized = normalizeSlackRuntimeConfig(config);
    if (!normalized.cloudApiToken) {
      throw new SlackPostBackError(
        'auth_token_missing',
        'auth_token_missing: CLOUD_API_TOKEN is required for Slack cloud-relay runtime.'
      );
    }
    if (!normalized.cloudApiUrl) {
      throw new SlackPostBackError(
        'auth_token_missing',
        'auth_token_missing: CLOUD_API_URL is required for Slack cloud-relay runtime.'
      );
    }

    super({ ...normalized, runtime: 'cloud-relay' }, createCloudRelaySlackStub());

    const resolved = fetchImpl ?? (globalThis.fetch as CloudRelayFetch | undefined);
    if (!resolved) {
      throw new SlackPostBackError(
        'upstream_error',
        'cloud-relay runtime requires a fetch implementation; pass one explicitly or run on Node 18+.'
      );
    }
    this.fetchImpl = resolved;
  }

  getRuntime(): SlackRuntime {
    return 'cloud-relay';
  }

  async isAuthenticated(): Promise<boolean> {
    return Boolean(this.config.cloudApiToken && this.config.cloudApiUrl);
  }

  async postMessage(params: PostMessageParams): Promise<PostMessageOutput> {
    if (!params.channel) {
      throw new SlackPostBackError('channel_not_found', 'channel is required for postMessage');
    }
    if (!params.text) {
      throw new SlackPostBackError('slack_api_error', 'text is required for postMessage');
    }

    const baseUrl = trimTrailingSlash(this.config.cloudApiUrl);
    const url = `${baseUrl}${POST_MESSAGE_PATH}`;

    const body: Record<string, unknown> = {
      channel: params.channel,
      text: params.text,
    };
    if (params.threadTs) body.threadTs = params.threadTs;
    if (typeof params.unfurl === 'boolean') {
      body.unfurlLinks = params.unfurl;
      body.unfurlMedia = params.unfurl;
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutHandle =
      controller && this.config.timeout > 0
        ? setTimeout(() => controller.abort(), this.config.timeout)
        : null;

    let response: Awaited<ReturnType<CloudRelayFetch>>;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.cloudApiToken}`,
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      throw new SlackPostBackError(
        'upstream_error',
        `cloud-relay request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const payload = (await response.json().catch(() => null)) as CloudRelayPostMessageResponse | null;

    if (!payload) {
      throw new SlackPostBackError(
        'upstream_error',
        `cloud-relay returned non-JSON response (${response.status} ${response.statusText})`
      );
    }

    if (!payload.ok) {
      throw mapCloudRelayError(payload);
    }

    const warnings: SlackResolutionWarning[] = [];
    const unresolvedMentions: string[] = [];
    if (params.mentions && params.mentions.length > 0) {
      for (const mention of params.mentions) {
        unresolvedMentions.push(mention);
        warnings.push({
          type: 'mention_unresolved',
          input: mention,
          message:
            'mention resolution is not supported in cloud-relay runtime; pass user IDs in text directly.',
        });
      }
    }

    return {
      channel: payload.channel,
      ts: payload.ts,
      text: params.text,
      resolvedMentions: [],
      unresolvedMentions,
      warnings,
    };
  }

  async resolveUser(_params: ResolveUserParams): Promise<SlackResolvedMention> {
    throw new SlackPostBackError(
      'unsupported_in_cloud_relay',
      'resolveUser is not supported in cloud-relay runtime (Phase A). Pass a Slack user ID directly.'
    );
  }

  async resolveChannel(_params: ResolveChannelParams): Promise<SlackChannelSummary> {
    throw new SlackPostBackError(
      'unsupported_in_cloud_relay',
      'resolveChannel is not supported in cloud-relay runtime (Phase A). Pass a Slack channel ID or #name directly.'
    );
  }
}

/**
 * Stub Slack web-api shaped object for the BaseSlackAdapter constructor.
 * Cloud-relay overrides every action at the class level, so this stub
 * only fires if a future change forgets to override one — in which case
 * we want a loud error rather than a silent no-op.
 */
function createCloudRelaySlackStub(): SlackWebApiLike {
  const unsupported = (method: string) => async () => {
    throw new SlackPostBackError(
      'unsupported_in_cloud_relay',
      `${method} is not available in cloud-relay runtime`
    );
  };

  return {
    chat: { postMessage: unsupported('chat.postMessage') },
    conversations: { list: unsupported('conversations.list') },
    users: { lookupByEmail: unsupported('users.lookupByEmail') },
    auth: { test: unsupported('auth.test') },
  } as unknown as SlackWebApiLike;
}

function mapCloudRelayError(payload: CloudRelayPostMessageError): SlackPostBackError {
  const code = mapErrorCode(payload.code);
  return new SlackPostBackError(code, `${payload.code}: ${payload.error}`, {
    cause: payload,
  });
}

function mapErrorCode(code: string): SlackPostBackError['code'] {
  switch (code) {
    case 'unauthorized':
      return 'unauthorized';
    case 'not_connected':
      return 'not_connected';
    case 'rate_limited':
      return 'rate_limited';
    case 'slack_error':
      return 'slack_api_error';
    case 'bad_request':
      return 'slack_api_error';
    case 'upstream_error':
    default:
      return 'upstream_error';
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
