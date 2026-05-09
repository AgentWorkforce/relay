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
  type SlackRuntimePreference,
  type SlackWebApiLike,
} from './types.js';

const DEFAULT_TIMEOUT = 30_000;

export function normalizeSlackRuntimeConfig(config: SlackRuntimeConfig = {}): RequiredSlackRuntimeConfig {
  const env = config.env ?? process.env;
  const token = nonEmpty(config.token) ?? nonEmpty(env.SLACK_BOT_TOKEN) ?? '';
  const cloudApiToken = nonEmpty(config.cloudApiToken) ?? nonEmpty(env.CLOUD_API_TOKEN) ?? '';
  const cloudApiUrl = nonEmpty(config.cloudApiUrl) ?? nonEmpty(env.CLOUD_API_URL) ?? '';

  return {
    ...config,
    runtime:
      config.runtime && config.runtime !== 'auto'
        ? config.runtime
        : selectRuntime({ token, cloudApiToken, cloudApiUrl }),
    env,
    token,
    cloudApiToken,
    cloudApiUrl,
    timeout: config.timeout ?? DEFAULT_TIMEOUT,
  };
}

function selectRuntime(input: { token: string; cloudApiToken: string; cloudApiUrl: string }): SlackRuntime {
  if (input.cloudApiToken && input.cloudApiUrl) return 'cloud-relay';
  if (input.token) return 'local';
  return 'noop';
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
    try {
      const response = await this.slack.auth.test();
      return response.ok !== false;
    } catch {
      return false;
    }
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
    return postMessageAction(this.slack, {
      ...params,
      channel: params.channel ?? this.config.env.SLACK_DEFAULT_CHANNEL,
    });
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
    const normalized = normalizeSlackRuntimeConfig(config);
    switch (normalized.runtime) {
      case 'cloud-relay': {
        const { SlackCloudRelayClient } = await import('./cloud-relay-runtime.js');
        return new SlackCloudRelayClient(normalized);
      }
      case 'noop': {
        const { SlackNoopClient } = await import('./noop-runtime.js');
        return new SlackNoopClient(normalized);
      }
      case 'local':
      default: {
        const { SlackWebApiClient } = await import('./local-runtime.js');
        return new SlackWebApiClient(normalized);
      }
    }
  }

  static async detect(config: SlackRuntimeConfig = {}): Promise<SlackRuntimeDetectionResult> {
    const normalized = normalizeSlackRuntimeConfig(config);
    const local = await this.testRuntime('local', normalized);
    const cloudRelay = await this.testRuntime('cloud-relay', normalized);
    const noop = await this.testRuntime('noop', normalized);

    const requested: SlackRuntimePreference = config.runtime ?? 'auto';
    const selected = normalized.runtime;
    const summary = selected === 'cloud-relay' ? cloudRelay : selected === 'noop' ? noop : local;

    return {
      runtime: selected,
      requestedRuntime: requested,
      source:
        normalized.token || normalized.cloudApiToken || normalized.cloudApiUrl ? 'config' : 'environment',
      available: summary.available,
      reason: summary.reason,
      checkedAt: new Date().toISOString(),
      local,
      cloudRelay,
      noop,
    };
  }

  static async detectRuntime(config: SlackRuntimeConfig = {}): Promise<SlackRuntime> {
    return normalizeSlackRuntimeConfig(config).runtime;
  }

  static testRuntime(
    runtime: SlackRuntime,
    config: SlackRuntimeConfig = {}
  ): Promise<SlackRuntimeAvailability> {
    const normalized = normalizeSlackRuntimeConfig(config);
    switch (runtime) {
      case 'cloud-relay': {
        const ready = Boolean(normalized.cloudApiToken && normalized.cloudApiUrl);
        return Promise.resolve({
          runtime,
          available: ready,
          authenticated: ready,
          reason: ready
            ? 'CLOUD_API_TOKEN and CLOUD_API_URL are configured.'
            : 'CLOUD_API_TOKEN or CLOUD_API_URL is not configured.',
        });
      }
      case 'noop': {
        return Promise.resolve({
          runtime,
          available: true,
          authenticated: false,
          reason: 'noop runtime is always available.',
        });
      }
      case 'local':
      default: {
        const ready = Boolean(normalized.token);
        return Promise.resolve({
          runtime,
          available: ready,
          authenticated: ready,
          reason: ready ? 'SLACK_BOT_TOKEN is configured.' : 'SLACK_BOT_TOKEN is not configured.',
        });
      }
    }
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
