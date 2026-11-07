import { describe, expect, it, vi } from 'vitest';

import { enableInboxPiggyback } from './telemetry.js';
import type { SessionState } from './types.js';

const SQL_ERROR_MESSAGE =
  'Failed query: delete from "agents" where "agents"."id" = ?\nparams: 214015171589668864';

function harness() {
  const tools = new Map<string, (input: unknown) => Promise<unknown>>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: (input: unknown) => Promise<unknown>) => {
      tools.set(name, handler);
    }),
  };
  const session: SessionState = {
    workspaceKey: null,
    agentToken: null,
    agentName: null,
    agents: undefined,
    wsBridge: null,
    subscriptions: null,
    wsInitAttempted: false,
  };
  enableInboxPiggyback(
    server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
    () => session,
    () => ({ inbox: vi.fn(async () => ({})) }) as never,
    vi.fn()
  );

  // Register through the now-wrapped registerTool so `tools` ends up holding
  // the wrapper (which does the redaction), not the raw handler.
  function register(name: string, rawHandler: (input: unknown) => Promise<unknown>) {
    server.registerTool(name, {}, rawHandler);
    return tools.get(name)!;
  }

  return { register };
}

describe('enableInboxPiggyback SQL/diagnostic redaction', () => {
  it("redacts an isError result's structuredContent, not just content[].text", async () => {
    const { register } = harness();
    // Models exactly what action-tools.ts's jsonContent(...) produces for a
    // relay failure: the SQL leak lands in both content[].text and
    // structuredContent.error.
    const wrapped = register('some_tool', async () => ({
      content: [{ type: 'text', text: SQL_ERROR_MESSAGE }],
      structuredContent: { ok: false, error: SQL_ERROR_MESSAGE },
      isError: true,
    }));
    const result = (await wrapped({})) as {
      content: Array<{ text: string }>;
      structuredContent: { ok: boolean; error: string };
    };

    expect(result.content[0].text).not.toContain('delete from');
    expect(result.content[0].text).not.toContain('params:');
    expect(result.structuredContent.error).not.toContain('delete from');
    expect(result.structuredContent.error).not.toContain('214015171589668864');
  });

  it('redacts nested string leaves inside structuredContent, not just a top-level "error" field', async () => {
    const { register } = harness();
    const wrapped = register('some_tool', async () => ({
      content: [{ type: 'text', text: 'redacted already' }],
      structuredContent: { ok: false, detail: { cause: SQL_ERROR_MESSAGE, code: 'db_error' } },
      isError: true,
    }));
    const result = (await wrapped({})) as {
      structuredContent: { detail: { cause: string; code: string } };
    };

    expect(result.structuredContent.detail.cause).not.toContain('delete from');
    expect(result.structuredContent.detail.code).toBe('db_error');
  });

  it('does not touch structuredContent on a successful (non-isError) result', async () => {
    const { register } = harness();
    const wrapped = register('some_tool', async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { note: SQL_ERROR_MESSAGE },
    }));
    const result = (await wrapped({})) as { structuredContent: { note: string } };

    // Not an error result, so nothing here is a diagnostic to redact — the
    // sanitizer must be scoped to isError results only.
    expect(result.structuredContent.note).toBe(SQL_ERROR_MESSAGE);
  });

  it('preserves the original error object when no redaction is needed', async () => {
    const { register } = harness();
    const original = new Error('Agent "chief" not found');
    const wrapped = register('some_tool', async () => {
      throw original;
    });

    await expect(wrapped({})).rejects.toBe(original);
  });

  it('throws a sanitized error whose message and stack contain no SQL', async () => {
    const { register } = harness();
    class CustomRelayError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomRelayError';
      }
    }
    const wrapped = register('some_tool', async () => {
      throw new CustomRelayError(SQL_ERROR_MESSAGE);
    });

    let caught: unknown;
    try {
      await wrapped({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).not.toContain('delete from');
    expect(error.message).not.toContain('params:');
    // Type (name) is preserved even though the object identity is not (a
    // fresh Error is constructed so the sanitized message, not the raw SQL,
    // is what ends up baked into the new stack's header line).
    expect(error.name).toBe('CustomRelayError');
    expect(error.stack).not.toContain('delete from');
  });
});
