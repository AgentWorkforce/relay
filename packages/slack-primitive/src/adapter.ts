import { postMessage as postMessageAction } from './actions/post-message.js';
import { resolveChannel as resolveChannelAction } from './actions/resolve-channel.js';
import { resolveUser as resolveUserAction } from './actions/resolve-user.js';
import {
  SlackAction,
  SlackClientInterface,
  type PostMessageOutput,
  type PostMessageParams,
  type RequiredSlackRuntimeConfig,
  type ResolveChannelParams,
  type ResolveUserParams,
  type SlackActionName,
  type SlackActionOutputMap,
  type SlackActionParamsMap,
  type SlackActionResult,
  type SlackChannelSummary,
  type SlackResolvedMention,
  type SlackRuntime,
  type SlackRuntimeAvailability,
  type SlackRuntimeConfig,
  type SlackRuntimeDetectionResult,
  type SlackWebApiLike,
} from './types.js';

const DEFAULT_TIMEOUT = 30_000;

export function normalizeSlackRuntimeConfig(config: SlackRuntimeConfig = {}): RequiredSlackRuntimeConfig {
  const env = config.env ?? process.env;
  const token = nonEmpty(config.token) ?? nonEmpty(env.SLACK_BOT_TOKEN) ?? '';

  return {
    ...config,
    runtime: 'local',
    env,
    token,
    timeout: config.timeout ?? DEFAULT_TIMEOUT,
  };
}

export abstract class BaseSlackAdapter extends SlackClientInterface {
  constructor(
    config: RequiredSlackRuntimeConfig,
    protected readonly slack: SlackWebApiLike
  ) {
    super(config);
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.slack.auth) {
      return Boolean(this.config.token);
    }
    const response = await this.slack.auth.test();
    return response.ok !== false;
  }

  executeAction<Name extends SlackAction>(
    action: Name,
    params: SlackActionParamsMap[Name]
  ): Promise<SlackActionResult<SlackActionOutputMap[Name]>>;
  executeAction<TOutput = unknown>(
    action: SlackAction | SlackActionName,
    params?: unknown
  ): Promise<SlackActionResult<TOutput>>;
  async executeAction<TOutput = unknown>(
    action: SlackAction | SlackActionName,
    params?: unknown
  ): Promise<SlackActionResult<TOutput>> {
    const startedAt = Date.now();

    try {
      const data = (await this.dispatchAction(action, params)) as TOutput;
      return {
        success: true,
        output: stringifyOutput(data),
        data,
        metadata: {
          runtime: this.getRuntime(),
          executionTime: Date.now() - startedAt,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          runtime: this.getRuntime(),
          executionTime: Date.now() - startedAt,
        },
      };
    }
  }

  async postMessage(params: PostMessageParams): Promise<PostMessageOutput> {
    return postMessageAction(this.slack, params);
  }

  async resolveUser(params: ResolveUserParams): Promise<SlackResolvedMention> {
    return resolveUserAction(this.slack, params.mention);
  }

  async resolveChannel(params: ResolveChannelParams): Promise<SlackChannelSummary> {
    return resolveChannelAction(this.slack, params.channel);
  }

  private async dispatchAction(action: SlackAction | SlackActionName, params: unknown): Promise<unknown> {
    switch (action) {
      case SlackAction.PostMessage:
        return this.postMessage(params as PostMessageParams);
      case SlackAction.ResolveUser:
        return this.resolveUser(params as ResolveUserParams);
      case SlackAction.ResolveChannel:
        return this.resolveChannel(params as ResolveChannelParams);
      default:
        throw new Error(`Unsupported Slack action: ${String(action)}`);
    }
  }
}

export class SlackAdapterFactory {
  static async create(config: SlackRuntimeConfig = {}): Promise<SlackClientInterface> {
    const { SlackWebApiClient } = await import('./local-runtime.js');
    return new SlackWebApiClient(config);
  }

  static async detect(config: SlackRuntimeConfig = {}): Promise<SlackRuntimeDetectionResult> {
    const normalized = normalizeSlackRuntimeConfig(config);
    const local = await this.testRuntime('local', normalized);

    return {
      runtime: 'local',
      requestedRuntime: 'local',
      source: normalized.token ? 'config' : 'environment',
      available: local.available,
      reason: local.reason,
      checkedAt: new Date().toISOString(),
      local,
    };
  }

  static detectRuntime(_config: SlackRuntimeConfig = {}): Promise<SlackRuntime> {
    return Promise.resolve('local');
  }

  static testRuntime(
    runtime: SlackRuntime,
    config: SlackRuntimeConfig = {}
  ): Promise<SlackRuntimeAvailability> {
    const normalized = normalizeSlackRuntimeConfig(config);
    return Promise.resolve({
      runtime,
      available: Boolean(normalized.token),
      authenticated: Boolean(normalized.token),
      reason: normalized.token ? 'SLACK_BOT_TOKEN is configured.' : 'SLACK_BOT_TOKEN is not configured.',
    });
  }
}

export const SlackClientFactory = SlackAdapterFactory;

export function detectSlackRuntime(config: SlackRuntimeConfig = {}): Promise<SlackRuntimeDetectionResult> {
  return SlackAdapterFactory.detect(config);
}

export function createSlackAdapter(config: SlackRuntimeConfig = {}): Promise<SlackClientInterface> {
  return SlackAdapterFactory.create(config);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'undefined') return '';
  return JSON.stringify(value);
}
