export type SlackRuntime = 'local';

export type SlackRuntimePreference = SlackRuntime;

export enum SlackAction {
  PostMessage = 'postMessage',
  ResolveUser = 'resolveUser',
  ResolveChannel = 'resolveChannel',
}

export type SlackActionName = `${SlackAction}`;

export const SLACK_ACTIONS = Object.values(SlackAction);

export interface SlackRuntimeConfig {
  /** Runtime mode. Phase A supports only the local Web API runtime. */
  runtime?: SlackRuntimePreference;
  /** Slack bot token. Defaults to SLACK_BOT_TOKEN. */
  token?: string;
  /** Environment used for token lookup. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Request timeout in milliseconds passed to the Slack WebClient. */
  timeout?: number;
}

export interface RequiredSlackRuntimeConfig extends SlackRuntimeConfig {
  runtime: SlackRuntime;
  env: Record<string, string | undefined>;
  token: string;
  timeout: number;
}

export interface SlackRuntimeAvailability {
  runtime: SlackRuntime;
  available: boolean;
  authenticated?: boolean;
  reason: string;
  error?: string;
}

export interface SlackRuntimeDetectionResult {
  runtime: SlackRuntime;
  requestedRuntime: SlackRuntimePreference;
  source: 'config' | 'environment';
  available: boolean;
  reason: string;
  checkedAt: string;
  local: SlackRuntimeAvailability;
}

export type SlackPostBackErrorCode = 'auth_token_missing' | 'channel_not_found' | 'slack_api_error';

export class SlackPostBackError extends Error {
  readonly code: SlackPostBackErrorCode;
  readonly cause?: unknown;

  constructor(code: SlackPostBackErrorCode, message?: string, options: { cause?: unknown } = {}) {
    super(message ?? code);
    this.name = 'SlackPostBackError';
    this.code = code;
    this.cause = options.cause;
  }
}

export interface SlackUserSummary {
  id: string;
  name?: string;
  realName?: string;
  profile?: {
    email?: string;
    displayName?: string;
    realName?: string;
  };
}

export interface SlackChannelSummary {
  id: string;
  name?: string;
  isChannel?: boolean;
  isGroup?: boolean;
  isIm?: boolean;
  isPrivate?: boolean;
}

export interface SlackResolutionWarning {
  type: 'mention_unresolved';
  input: string;
  message: string;
}

export interface SlackResolvedMention {
  input: string;
  userId: string;
}

export interface PostMessageParams {
  channel: string;
  text: string;
  threadTs?: string;
  mentions?: string[];
  unfurl?: boolean;
}

export interface ResolveUserParams {
  mention: string;
}

export interface ResolveChannelParams {
  channel: string;
}

export interface PostMessageOutput {
  channel: string;
  ts: string;
  text: string;
  resolvedMentions: SlackResolvedMention[];
  unresolvedMentions: string[];
  warnings: SlackResolutionWarning[];
}

export interface SlackActionParamsMap {
  [SlackAction.PostMessage]: PostMessageParams;
  [SlackAction.ResolveUser]: ResolveUserParams;
  [SlackAction.ResolveChannel]: ResolveChannelParams;
}

export interface SlackActionOutputMap {
  [SlackAction.PostMessage]: PostMessageOutput;
  [SlackAction.ResolveUser]: SlackResolvedMention;
  [SlackAction.ResolveChannel]: SlackChannelSummary;
}

export interface SlackActionResult<TOutput = unknown> {
  success: boolean;
  output: string;
  data?: TOutput;
  error?: string;
  metadata?: {
    runtime?: SlackRuntime;
    executionTime?: number;
  };
}

export interface SlackChatPostMessageParams {
  channel: string;
  text: string;
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface SlackPostMessageResponse {
  ok?: boolean;
  channel?: string;
  ts?: string;
  message?: {
    text?: string;
  };
  error?: string;
}

export interface SlackLookupByEmailResponse {
  ok?: boolean;
  user?: SlackUserSummary;
  error?: string;
}

export interface SlackUsersListResponse {
  ok?: boolean;
  members?: SlackUserSummary[];
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

export interface SlackConversationsListResponse {
  ok?: boolean;
  channels?: SlackChannelSummary[];
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

export interface SlackWebApiLike {
  chat: {
    postMessage(params: SlackChatPostMessageParams): Promise<SlackPostMessageResponse>;
  };
  users: {
    lookupByEmail(params: { email: string }): Promise<SlackLookupByEmailResponse>;
    list(params?: { cursor?: string; limit?: number }): Promise<SlackUsersListResponse>;
  };
  conversations: {
    list(params?: { cursor?: string; limit?: number; types?: string }): Promise<SlackConversationsListResponse>;
  };
  auth?: {
    test(): Promise<{ ok?: boolean; error?: string }>;
  };
}

export abstract class SlackClientInterface {
  protected readonly config: RequiredSlackRuntimeConfig;

  constructor(config: RequiredSlackRuntimeConfig) {
    this.config = config;
  }

  getRuntimeConfig(): RequiredSlackRuntimeConfig {
    return this.config;
  }

  abstract getRuntime(): SlackRuntime;
  abstract isAuthenticated(): Promise<boolean>;
  abstract executeAction<Name extends SlackAction>(
    action: Name,
    params: SlackActionParamsMap[Name]
  ): Promise<SlackActionResult<SlackActionOutputMap[Name]>>;
  abstract executeAction<TOutput = unknown>(
    action: SlackAction | SlackActionName,
    params?: unknown
  ): Promise<SlackActionResult<TOutput>>;
  abstract postMessage(params: PostMessageParams): Promise<PostMessageOutput>;
  abstract resolveUser(params: ResolveUserParams): Promise<SlackResolvedMention>;
  abstract resolveChannel(params: ResolveChannelParams): Promise<SlackChannelSummary>;
}
