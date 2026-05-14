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

export type NoopLogger = (message: string, context: Record<string, unknown>) => void;

const DEFAULT_LOGGER: NoopLogger = (message, context) => {
  // eslint-disable-next-line no-console
  console.warn(`[slack-primitive:noop] ${message}`, context);
};

const NOOP_TS = '0000000000.000000';

/**
 * Slack adapter that no-ops all actions.
 *
 * Used when neither SLACK_BOT_TOKEN nor CLOUD_API_TOKEN is configured.
 * Lets workflows run end-to-end without hard-failing on missing Slack
 * credentials in environments (CI, smoke tests, demos) where Slack
 * delivery isn't required. Each call logs a warning so the operator
 * can see that messages are being dropped.
 */
export class SlackNoopClient extends BaseSlackAdapter {
  private readonly logger: NoopLogger;

  constructor(config: SlackRuntimeConfig = {}, logger?: NoopLogger) {
    const normalized = normalizeSlackRuntimeConfig(config);
    super({ ...normalized, runtime: 'noop' }, createNoopSlackStub());
    this.logger = logger ?? DEFAULT_LOGGER;
  }

  getRuntime(): SlackRuntime {
    return 'noop';
  }

  async isAuthenticated(): Promise<boolean> {
    return false;
  }

  async postMessage(params: PostMessageParams): Promise<PostMessageOutput> {
    const channel = params.channel ?? this.config.env.SLACK_DEFAULT_CHANNEL ?? '#noop';
    this.logger('postMessage dropped: no SLACK_BOT_TOKEN and no CLOUD_API_TOKEN configured.', {
      channel,
      preview: params.text.slice(0, 80),
    });

    const warnings: SlackResolutionWarning[] = [
      {
        type: 'mention_unresolved',
        input: channel,
        message: 'Slack runtime is noop; configure SLACK_BOT_TOKEN or CLOUD_API_TOKEN to deliver messages.',
      },
    ];

    return {
      channel,
      ts: NOOP_TS,
      text: params.text,
      resolvedMentions: [],
      unresolvedMentions: params.mentions ?? [],
      warnings,
    };
  }

  async resolveUser(_params: ResolveUserParams): Promise<SlackResolvedMention> {
    throw new SlackPostBackError(
      'auth_token_missing',
      'resolveUser requires SLACK_BOT_TOKEN; current runtime is noop.'
    );
  }

  async resolveChannel(_params: ResolveChannelParams): Promise<SlackChannelSummary> {
    throw new SlackPostBackError(
      'auth_token_missing',
      'resolveChannel requires SLACK_BOT_TOKEN; current runtime is noop.'
    );
  }
}

function createNoopSlackStub(): SlackWebApiLike {
  const unsupported = (method: string) => async () => {
    throw new SlackPostBackError('auth_token_missing', `${method} is not available in noop runtime`);
  };

  return {
    chat: { postMessage: unsupported('chat.postMessage') },
    conversations: { list: unsupported('conversations.list') },
    users: { lookupByEmail: unsupported('users.lookupByEmail') },
    auth: { test: unsupported('auth.test') },
  } as unknown as SlackWebApiLike;
}
