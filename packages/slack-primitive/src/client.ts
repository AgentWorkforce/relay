import { SlackAdapterFactory } from './adapter.js';
import type {
  PostMessageOutput,
  PostMessageParams,
  ResolveChannelParams,
  ResolveUserParams,
  SlackAction,
  SlackActionName,
  SlackActionOutputMap,
  SlackActionParamsMap,
  SlackActionResult,
  SlackChannelSummary,
  SlackClientInterface,
  SlackResolvedMention,
  SlackRuntime,
  SlackRuntimeConfig,
  SlackRuntimeDetectionResult,
} from './types.js';

/**
 * High-level Slack primitive client.
 */
export class SlackClient {
  private readonly adapterPromise: Promise<SlackClientInterface>;

  constructor(config: SlackRuntimeConfig = {}) {
    this.adapterPromise = SlackAdapterFactory.create(config);
  }

  /**
   * Create a Slack client and eagerly resolve the local runtime.
   * @param config - Slack runtime configuration.
   * @returns Configured Slack client.
   */
  static async create(config: SlackRuntimeConfig = {}): Promise<SlackClient> {
    const client = new SlackClient(config);
    await client.getAdapter();
    return client;
  }

  /**
   * Inspect local runtime availability without creating a client.
   * @param config - Slack runtime configuration.
   * @returns Runtime detection details.
   */
  static detect(config: SlackRuntimeConfig = {}): Promise<SlackRuntimeDetectionResult> {
    return SlackAdapterFactory.detect(config);
  }

  /**
   * Detect the runtime that will be selected. Phase A always returns local.
   * @param config - Slack runtime configuration.
   * @returns Selected Slack runtime.
   */
  static detectRuntime(config: SlackRuntimeConfig = {}): Promise<SlackRuntime> {
    return SlackAdapterFactory.detectRuntime(config);
  }

  /**
   * Return the selected low-level adapter.
   * @returns Slack adapter.
   */
  getAdapter(): Promise<SlackClientInterface> {
    return this.adapterPromise;
  }

  /**
   * Return the selected runtime.
   * @returns Slack runtime.
   */
  async getRuntime(): Promise<SlackRuntime> {
    return (await this.getAdapter()).getRuntime();
  }

  /**
   * Check whether the selected runtime is authenticated.
   * @returns True when Slack auth succeeds.
   */
  async isAuthenticated(): Promise<boolean> {
    return (await this.getAdapter()).isAuthenticated();
  }

  executeAction<Name extends SlackAction>(
    action: Name,
    params: SlackActionParamsMap[Name]
  ): Promise<SlackActionResult<SlackActionOutputMap[Name]>>;
  executeAction<TOutput = unknown>(
    action: SlackAction | SlackActionName,
    params?: unknown
  ): Promise<SlackActionResult<TOutput>>;
  /**
   * Execute any registered Slack primitive action by action name.
   * @param action - Slack action name.
   * @param params - Action parameters.
   * @returns Action result.
   */
  async executeAction<TOutput = unknown>(
    action: SlackAction | SlackActionName,
    params?: unknown
  ): Promise<SlackActionResult<TOutput>> {
    return (await this.getAdapter()).executeAction(action, params);
  }

  /**
   * Post a Slack message.
   * @param params - Message parameters.
   * @returns Posted message output.
   */
  async postMessage(params: PostMessageParams): Promise<PostMessageOutput> {
    return (await this.getAdapter()).postMessage(params);
  }

  /**
   * Resolve a Slack user mention.
   * @param params - User resolution parameters.
   * @returns Resolved mention.
   */
  async resolveUser(params: ResolveUserParams): Promise<SlackResolvedMention> {
    return (await this.getAdapter()).resolveUser(params);
  }

  /**
   * Resolve a Slack channel reference.
   * @param params - Channel resolution parameters.
   * @returns Resolved channel.
   */
  async resolveChannel(params: ResolveChannelParams): Promise<SlackChannelSummary> {
    return (await this.getAdapter()).resolveChannel(params);
  }
}
