import type { SendMessageInput, SpawnProviderInput } from '@agent-relay/sdk';

export type SurfaceType = 'whatsapp' | 'slack' | 'telegram';

export type MessagePriority = 'critical' | 'high' | 'medium' | 'low';

export type MessageItemType = 'issue' | 'pull_request' | 'ticket' | 'message' | 'comment' | 'check';

export type DeliveryType = 'comment' | 'message' | 'reaction' | 'status';

export type SignatureAlgorithm = 'sha256' | 'sha1' | 'token' | 'slack-v0' | 'none';

export type HeaderValue = string | string[] | undefined;

export type HeaderMap = Readonly<Record<string, HeaderValue>>;

export type GatewayMetadata = Readonly<Record<string, unknown>>;

export interface MessageActor {
  id: string;
  name: string;
  email?: string;
  handle?: string;
}

export interface MessageContext {
  name: string;
  url?: string;
  channel?: string;
  workspaceId?: string;
  conversationId?: string;
  threadId?: string;
}

export interface MessageItem {
  type: MessageItemType;
  id: string | number;
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  state?: string;
}

export interface NormalizedMessage {
  id: string;
  source: SurfaceType;
  type: string;
  timestamp: Date;
  actor: MessageActor;
  context: MessageContext;
  item?: MessageItem;
  mentions: string[];
  labels: string[];
  priority?: MessagePriority;
  metadata: GatewayMetadata;
  rawPayload: unknown;
}

export interface OutboundMessage {
  type: DeliveryType;
  target: string | number;
  body: string;
  metadata?: GatewayMetadata;
  replyToMessageId?: string;
  subject?: string;
}

export interface DeliveryResult {
  success: boolean;
  id?: string;
  url?: string;
  error?: string;
  metadata?: GatewayMetadata;
}

export interface SignatureConfig {
  header: string;
  algorithm: SignatureAlgorithm;
  secretEnvVar: string;
  signaturePrefix?: string;
}

export interface SurfaceAdapter {
  readonly type: SurfaceType;
  readonly signature: SignatureConfig;
  verify(payload: string, headers: HeaderMap): boolean;
  receive(payload: unknown, headers: HeaderMap): NormalizedMessage[];
  deliver(
    event: NormalizedMessage,
    message: OutboundMessage,
    config?: GatewayMetadata
  ): Promise<DeliveryResult>;
}

interface GatewayActionBase {
  config?: GatewayMetadata;
}

export interface SpawnAgentAction extends GatewayActionBase {
  type: 'spawn_agent';
  agent: SpawnProviderInput;
  prompt?: string;
}

export interface MessageAgentAction extends GatewayActionBase {
  type: 'message_agent';
  message: SendMessageInput;
}

export interface PostCommentAction extends GatewayActionBase {
  type: 'post_comment';
  target: string | number;
  body: string;
}

export interface CreateIssueAction extends GatewayActionBase {
  type: 'create_issue';
  title: string;
  body?: string;
  labels?: string[];
}

export interface CustomAction extends GatewayActionBase {
  type: 'custom';
  name: string;
  payload?: GatewayMetadata;
}

export type GatewayAction =
  | SpawnAgentAction
  | MessageAgentAction
  | PostCommentAction
  | CreateIssueAction
  | CustomAction;

export type RuleSource = SurfaceType | '*';

export interface WebhookRule {
  id: string;
  name: string;
  enabled: boolean;
  source: RuleSource;
  eventType: string;
  condition?: string;
  action: GatewayAction;
  priority: number;
}

export interface ProcessResultEntry {
  message: NormalizedMessage;
  matchedRules: WebhookRule[];
  actions: GatewayAction[];
}

export interface ProcessResult {
  source: SurfaceType;
  verified: boolean;
  entries: ProcessResultEntry[];
  error?: string;
}

export interface GatewayOptions {
  adapters?: SurfaceAdapter[];
  rules?: WebhookRule[];
}
