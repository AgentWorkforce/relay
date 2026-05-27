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
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
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
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  visibility?: 'agent' | 'human' | 'internal';
  policy?: ActionPolicy;
  handler(input: TInput, context: ActionContext): Promise<TOutput> | TOutput;
}

export interface InvokeActionInput {
  name: string;
  input: unknown;
  context: ActionContext;
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

export interface ActionHandle {
  unregister(): void;
}

export interface AgentRelayActions {
  register<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>): ActionHandle;
  invoke<TOutput = unknown>(input: InvokeActionInput): Promise<ActionResult<TOutput>>;
  list(input?: { visibility?: 'agent' | 'human' | 'internal' }): Promise<AgentRelayActionDescriptor[]>;
}
