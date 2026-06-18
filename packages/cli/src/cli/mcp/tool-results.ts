import {
  INVALID_AGENT_TOKEN_CODE,
  agentTokenRecoveryMessage,
} from '@agent-relay/sdk';
import { z } from 'zod';

/** Permissive output schema for tools that return arbitrary JSON objects. */
export const jsonResult = z.object({}).passthrough();

export type JsonToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

/** Wrap an arbitrary value as an MCP tool result with both text and structured content. */
export function jsonContent(value: unknown): JsonToolResult {
  const structuredContent =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

/** Wrap a human-readable message as an MCP tool result. */
export function textContent(message: string, structuredContent: Record<string, unknown> = { message }) {
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent,
  };
}

export function hasContentArray(value: unknown): value is { content: Array<Record<string, unknown>> } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content)
  );
}

export function isErrorToolResult(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { isError?: unknown }).isError === true);
}

/** Standard MCP error result describing an invalid/expired agent token. */
export function invalidAgentTokenToolResult(): JsonToolResult & { isError: true } {
  const text = agentTokenRecoveryMessage();
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      error: { code: INVALID_AGENT_TOKEN_CODE, message: text },
    },
    isError: true,
  };
}
