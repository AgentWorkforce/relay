/**
 * A2A (Agent-to-Agent) protocol data model types.
 */

import { randomUUID } from 'node:crypto';

// --- Data model ---

export interface A2APart {
  text?: string;
  file?: Record<string, unknown>; // FileContent — phase 2
  data?: Record<string, unknown>; // Structured data — phase 2
}

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  messageId?: string;
  contextId?: string;
  taskId?: string;
}

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled';

export const VALID_TASK_STATES: ReadonlySet<string> = new Set([
  'submitted',
  'working',
  'completed',
  'failed',
  'canceled',
]);

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  messages: A2AMessage[];
  artifacts: Record<string, unknown>[];
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: Record<string, unknown>;
  skills: A2ASkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface A2AConfig {
  /** Server mode */
  serverPort?: number;
  serverHost?: string;
  /** Client mode */
  targetUrl?: string;
  /** Agent Card registry (known A2A agent URLs) */
  registry?: string[];
  /** Auth */
  authScheme?: 'bearer' | 'api_key' | string;
  authToken?: string;
  /** Agent metadata */
  agentDescription?: string;
  skills?: A2ASkill[];
}

// --- Factories ---

export function createA2APart(text?: string): A2APart {
  const part: A2APart = {};
  if (text !== undefined) part.text = text;
  return part;
}

export function createA2AMessage(
  role: 'user' | 'agent',
  parts: A2APart[],
  opts?: { messageId?: string; contextId?: string; taskId?: string },
): A2AMessage {
  return {
    role,
    parts,
    messageId: opts?.messageId ?? randomUUID(),
    contextId: opts?.contextId,
    taskId: opts?.taskId,
  };
}

export function createA2ATaskStatus(
  state: A2ATaskState,
  message?: A2AMessage,
): A2ATaskStatus {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  };
}

export function createA2ATask(
  id: string,
  contextId?: string,
): A2ATask {
  return {
    id,
    contextId,
    status: createA2ATaskStatus('submitted'),
    messages: [],
    artifacts: [],
  };
}

export function createA2AAgentCard(
  name: string,
  description: string,
  url: string,
  skills: A2ASkill[] = [],
): A2AAgentCard {
  return {
    name,
    description,
    url,
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    skills,
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}

// --- Serialization helpers ---

export function a2aPartToDict(part: A2APart): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (part.text !== undefined) d.text = part.text;
  if (part.file !== undefined) d.file = part.file;
  if (part.data !== undefined) d.data = part.data;
  return d;
}

export function a2aPartFromDict(d: Record<string, unknown>): A2APart {
  return {
    text: d.text as string | undefined,
    file: d.file as Record<string, unknown> | undefined,
    data: d.data as Record<string, unknown> | undefined,
  };
}

export function a2aMessageToDict(msg: A2AMessage): Record<string, unknown> {
  const d: Record<string, unknown> = {
    role: msg.role,
    parts: msg.parts.map(a2aPartToDict),
  };
  if (msg.messageId !== undefined) d.messageId = msg.messageId;
  if (msg.contextId !== undefined) d.contextId = msg.contextId;
  if (msg.taskId !== undefined) d.taskId = msg.taskId;
  return d;
}

export function a2aMessageFromDict(d: Record<string, unknown>): A2AMessage {
  const parts = (d.parts as Record<string, unknown>[] | undefined ?? []).map(a2aPartFromDict);
  return {
    role: d.role as 'user' | 'agent',
    parts,
    messageId: d.messageId as string | undefined,
    contextId: d.contextId as string | undefined,
    taskId: d.taskId as string | undefined,
  };
}

export function a2aMessageGetText(msg: A2AMessage): string {
  return msg.parts
    .filter((p) => p.text)
    .map((p) => p.text!)
    .join(' ');
}

export function a2aTaskStatusToDict(status: A2ATaskStatus): Record<string, unknown> {
  const d: Record<string, unknown> = { state: status.state };
  if (status.message !== undefined) d.message = a2aMessageToDict(status.message);
  if (status.timestamp !== undefined) d.timestamp = status.timestamp;
  return d;
}

export function a2aTaskStatusFromDict(d: Record<string, unknown>): A2ATaskStatus {
  let message: A2AMessage | undefined;
  if (d.message !== undefined && d.message !== null) {
    message = a2aMessageFromDict(d.message as Record<string, unknown>);
  }
  return {
    state: d.state as A2ATaskState,
    message,
    timestamp: d.timestamp as string | undefined,
  };
}

export function a2aTaskToDict(task: A2ATask): Record<string, unknown> {
  return {
    id: task.id,
    contextId: task.contextId,
    status: a2aTaskStatusToDict(task.status),
    messages: task.messages.map(a2aMessageToDict),
    artifacts: task.artifacts,
  };
}

export function a2aTaskFromDict(d: Record<string, unknown>): A2ATask {
  const status = d.status
    ? a2aTaskStatusFromDict(d.status as Record<string, unknown>)
    : createA2ATaskStatus('submitted');
  const messages = ((d.messages as Record<string, unknown>[]) ?? []).map(a2aMessageFromDict);
  return {
    id: d.id as string,
    contextId: d.contextId as string | undefined,
    status,
    messages,
    artifacts: (d.artifacts as Record<string, unknown>[]) ?? [],
  };
}

export function a2aSkillToDict(skill: A2ASkill): Record<string, unknown> {
  return { id: skill.id, name: skill.name, description: skill.description };
}

export function a2aSkillFromDict(d: Record<string, unknown>): A2ASkill {
  return {
    id: d.id as string,
    name: d.name as string,
    description: d.description as string,
  };
}

export function a2aAgentCardToDict(card: A2AAgentCard): Record<string, unknown> {
  return {
    name: card.name,
    description: card.description,
    url: card.url,
    version: card.version,
    capabilities: card.capabilities,
    skills: card.skills.map(a2aSkillToDict),
    defaultInputModes: card.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes,
  };
}

export function a2aAgentCardFromDict(d: Record<string, unknown>): A2AAgentCard {
  const skills = ((d.skills as Record<string, unknown>[]) ?? []).map(a2aSkillFromDict);
  return {
    name: d.name as string,
    description: d.description as string,
    url: d.url as string,
    version: (d.version as string) ?? '1.0.0',
    capabilities: (d.capabilities as Record<string, unknown>) ?? {
      streaming: true,
      pushNotifications: false,
    },
    skills,
    defaultInputModes: (d.defaultInputModes as string[]) ?? ['text'],
    defaultOutputModes: (d.defaultOutputModes as string[]) ?? ['text'],
  };
}

// --- JSON-RPC 2.0 helpers ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string };
  id: string | number | null;
}

export function makeJsonRpcRequest(
  method: string,
  params: Record<string, unknown>,
  id?: string | number,
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    method,
    params,
    id: id ?? randomUUID(),
  };
}

export function makeJsonRpcResponse(
  result: unknown,
  id: string | number,
): JsonRpcResponse {
  return { jsonrpc: '2.0', result, id };
}

export function makeJsonRpcError(
  code: number,
  message: string,
  id: string | number | null,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id,
  };
}

// Standard JSON-RPC error codes
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

// A2A-specific error codes
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;
