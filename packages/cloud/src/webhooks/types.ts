/**
 * Generic Webhook System - Type Definitions
 *
 * Defines the core types for a configurable webhook system
 * that can handle events from any source (GitHub, GitLab, Linear, Slack, etc.)
 */

/**
 * Normalized event format that all parsers produce
 */
export interface NormalizedEvent {
  /** Unique event ID */
  id: string;
  /** Source system (github, gitlab, linear, slack, etc.) */
  source: string;
  /** Event type (e.g., 'ci_failure', 'mention', 'issue_created') */
  type: string;
  /** Timestamp of the event */
  timestamp: Date;
  /** Actor who triggered the event */
  actor: {
    id: string;
    name: string;
    email?: string;
  };
  /** Repository or project context */
  context: {
    /** Full name (e.g., 'owner/repo' or project ID) */
    name: string;
    /** URL to the repository/project */
    url?: string;
  };
  /** The item this event relates to (issue, PR, ticket, message) */
  item?: {
    type: 'issue' | 'pull_request' | 'ticket' | 'message' | 'comment' | 'check';
    id: string | number;
    number?: number;
    title?: string;
    body?: string;
    url?: string;
    state?: string;
  };
  /** Mentioned agents or users */
  mentions: string[];
  /** Labels, tags, or categories */
  labels: string[];
  /** Priority level if applicable */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Additional source-specific data */
  metadata: Record<string, unknown>;
  /** Raw payload for debugging */
  rawPayload: unknown;
}

/**
 * Action to take in response to an event
 */
export interface WebhookAction {
  type: 'spawn_agent' | 'message_agent' | 'post_comment' | 'create_issue' | 'custom';
  /** Agent type or name to spawn/message */
  agentType?: string;
  /** Prompt template name or inline prompt */
  prompt?: string;
  /** Additional action-specific config */
  config?: Record<string, unknown>;
}

/**
 * Signature verification configuration
 */
export interface SignatureConfig {
  /** Header containing the signature */
  header: string;
  /** Algorithm to use for verification */
  algorithm: 'sha256' | 'sha1' | 'token' | 'slack-v0' | 'none';
  /** Environment variable containing the secret */
  secretEnvVar: string;
  /** Optional prefix to strip from signature (e.g., 'sha256=') */
  signaturePrefix?: string;
}

/**
 * Webhook source configuration
 */
export interface WebhookSourceConfig {
  /** Source identifier */
  id: string;
  /** Display name */
  name: string;
  /** Whether this source is enabled */
  enabled: boolean;
  /** Signature verification config */
  signature: SignatureConfig;
  /** Parser to use for this source */
  parser: string;
  /** Responder to use for sending responses */
  responder: string;
  /** Parser-specific configuration */
  parserConfig?: Record<string, unknown>;
  /** Responder-specific configuration */
  responderConfig?: Record<string, unknown>;
}

/**
 * Event routing rule
 */
export interface WebhookRule {
  /** Rule identifier */
  id: string;
  /** Display name */
  name: string;
  /** Whether this rule is enabled */
  enabled: boolean;
  /** Source to match (* for any) */
  source: string;
  /** Event type to match (* for any) */
  eventType: string;
  /** JSONPath condition (optional) */
  condition?: string;
  /** Action to take when matched */
  action: WebhookAction;
  /** Priority (lower = higher priority) */
  priority: number;
}

/**
 * Complete webhook configuration
 */
export interface WebhookConfig {
  sources: Record<string, WebhookSourceConfig>;
  rules: WebhookRule[];
}

/**
 * Parser interface - transforms source-specific payloads to normalized events
 */
export interface WebhookParser {
  /** Parser identifier */
  id: string;
  /** Parse raw payload into normalized event(s) */
  parse(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
    config?: Record<string, unknown>
  ): NormalizedEvent[];
}

/**
 * Response to send back to the source system
 */
export interface WebhookResponse {
  /** Type of response */
  type: 'comment' | 'message' | 'reaction' | 'status';
  /** Target (issue number, channel ID, etc.) */
  target: string | number;
  /** Response body/content */
  body: string;
  /** Additional response metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Responder interface - sends responses back to source systems
 */
export interface WebhookResponder {
  /** Responder identifier */
  id: string;
  /** Send a response to the source system */
  respond(
    event: NormalizedEvent,
    response: WebhookResponse,
    config?: Record<string, unknown>
  ): Promise<{ success: boolean; id?: string; url?: string; error?: string }>;
}

/**
 * Result of processing a webhook
 */
export interface WebhookResult {
  success: boolean;
  eventId: string;
  source: string;
  eventType: string;
  matchedRules: string[];
  actions: Array<{
    ruleId: string;
    action: WebhookAction;
    success: boolean;
    error?: string;
  }>;
  responses: Array<{
    type: string;
    success: boolean;
    id?: string;
    url?: string;
    error?: string;
  }>;
}
