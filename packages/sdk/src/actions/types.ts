import type { RelayMessaging } from '../messaging/index.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchemaLiteType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';

export type JsonSchemaLite = boolean | JsonSchemaLiteObject;

export interface JsonSchemaLiteObject {
  [key: string]: unknown;
  type?: JsonSchemaLiteType | JsonSchemaLiteType[];
  title?: string;
  description?: string;
  default?: unknown;
  const?: JsonValue;
  enum?: JsonValue[];
  properties?: Record<string, JsonSchemaLite>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaLite;
  items?: JsonSchemaLite;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchemaLite[];
  oneOf?: JsonSchemaLite[];
  allOf?: JsonSchemaLite[];
}

export type JsonSchema = JsonSchemaLite;

export interface ZodLikeIssue {
  path?: Array<string | number>;
  message: string;
  code?: string;
  expected?: string;
  received?: string;
}

export interface ZodLikeError {
  issues?: ZodLikeIssue[];
  message?: string;
}

export type ZodLikeParseResult<TOutput = unknown> =
  | { success: true; data: TOutput }
  | { success: false; error: ZodLikeError };

export interface ZodLikeSchema<TOutput = unknown> {
  safeParse(input: unknown): ZodLikeParseResult<TOutput>;
  description?: string;
}

export type ActionSchema<TOutput = unknown> = JsonSchema | ZodLikeSchema<TOutput>;

export interface ActionValidationIssue {
  path: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface ActionValidationResult {
  valid: boolean;
  issues: ActionValidationIssue[];
}

export interface AgentRelayActionDescriptor {
  name: string;
  description: string;
  inputSchema?: ActionSchema;
  outputSchema?: ActionSchema;
  visibility: 'agent' | 'human' | 'internal';
}

export interface ActionContext {
  caller: {
    name: string;
    id?: string;
    type?: 'agent' | 'human' | 'system';
  };
  workspaceId?: string;
  messaging?: RelayMessaging;
  emit?(event: ActionAuditEvent): Promise<void> | void;
}

export interface ActionPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export type ActionPolicy = (
  input: unknown,
  context: ActionContext
) => Promise<ActionPolicyDecision> | ActionPolicyDecision;

export interface ActionDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  input?: ActionSchema<TInput>;
  inputSchema?: ActionSchema<TInput>;
  output?: ActionSchema<TOutput>;
  outputSchema?: ActionSchema<TOutput>;
  visibility?: 'agent' | 'human' | 'internal';
  policy?: ActionPolicy;
  handler(input: TInput, context: ActionContext): Promise<TOutput> | TOutput;
}

export interface InvokeActionInput {
  name: string;
  input: unknown;
  context?: ActionContext;
  caller?: ActionContext['caller'];
  workspaceId?: string;
  messaging?: RelayMessaging;
  emit?(event: ActionAuditEvent): Promise<void> | void;
}

export interface ActionResult<TOutput = unknown> {
  action: string;
  ok: boolean;
  output?: TOutput;
  error?: {
    code: string;
    message: string;
  };
}

export type ActionAuditEvent =
  | { type: 'action.invoked'; action: string; caller: string; at: string }
  | { type: 'action.completed'; action: string; caller: string; at: string }
  | { type: 'action.failed'; action: string; caller: string; at: string; error: string }
  | { type: 'action.denied'; action: string; caller: string; at: string; reason?: string };

/**
 * Registry-level action event delivered to listeners subscribed via
 * {@link AgentRelayActions.onEvent}. Unlike {@link ActionAuditEvent} it carries
 * the full caller and the action input/output so predicates can filter on them.
 */
export interface ActionListenerEvent {
  type: 'action.invoked' | 'action.completed' | 'action.failed' | 'action.denied';
  action: string;
  caller: ActionContext['caller'];
  input?: unknown;
  output?: unknown;
  error?: string;
  reason?: string;
  at: string;
}

export interface ActionHandle {
  unregister(): void;
}

export interface AgentRelayActions {
  register<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>): ActionHandle;
  invoke<TOutput = unknown>(input: InvokeActionInput): Promise<ActionResult<TOutput>>;
  list(input?: { visibility?: 'agent' | 'human' | 'internal' }): Promise<AgentRelayActionDescriptor[]>;
  /** Subscribe to registry-level action events. Returns an unsubscribe function. */
  onEvent?(handler: (event: ActionListenerEvent) => void): () => void;
}
