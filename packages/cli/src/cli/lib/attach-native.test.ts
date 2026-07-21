import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import { attachNative, renderNativeHarnessDiagnostic, renderAgentEvent } from './attach-native.js';

const envelope = (kind: string, fields: Record<string, unknown> = {}) =>
  ({
    protocol_version: 1 as const,
    name: 'Worker',
    sequence: 4,
    timestamp: '2026-07-15T00:00:00.000Z',
    event: { kind, ...fields },
  }) as never;

describe('native harness attach rendering', () => {
  it('rejects passthrough without probing a terminal or broker', async () => {
    let error = '';
    await expect(
      attachNative(
        'Worker',
        'passthrough',
        {},
        {
          output: { stdout: () => undefined, stderr: (text) => (error += text) },
        }
      )
    ).resolves.toBe(1);
    expect(error).toMatch(/do not expose a terminal byte stream/);
  });

  it('waits for broker acknowledgement before reporting line input accepted', async () => {
    const output: string[] = [];
    let disconnected = false;
    let finishStream: ((value: IteratorResult<never>) => void) | undefined;
    const iterator = {
      next: () => new Promise<IteratorResult<never>>((resolve) => (finishStream = resolve)),
      return: async () => {
        finishStream?.({ done: true, value: undefined as never });
        return { done: true, value: undefined as never };
      },
    };
    const client = {
      currentEventSeq: async () => 12,
      subscribeAgentEvents: () => ({ [Symbol.asyncIterator]: () => iterator }),
      getAgentEventHistory: async () => ({
        protocol_version: 1,
        name: 'Worker',
        events: [],
        high_water_sequence: 0,
        oldest_available_sequence: null,
        gap: false,
      }),
      onEvent: () => () => undefined,
      disconnect: () => {
        disconnected = true;
      },
      sendNativeHarnessCommand: async () => ({
        protocol_version: 1,
        request_id: 'req-1',
        idempotency_key: 'input-1',
        accepted: true,
      }),
    };
    const readline = new EventEmitter() as EventEmitter & { close(): void };
    let promptText = '';
    let promptCount = 0;
    readline.close = () => undefined;
    Object.assign(readline, {
      terminal: true,
      setPrompt: (value: string) => (promptText = value),
      prompt: () => {
        promptCount += 1;
      },
    });
    await expect(
      attachNative(
        'Worker',
        'drive',
        { brokerUrl: 'http://broker' },
        {
          connect: () => client as never,
          output: { stdout: (text) => output.push(text), stderr: (text) => output.push(text) },
          createReadline: () => {
            queueMicrotask(() => {
              readline.emit('line', 'continue');
              readline.emit('line', '/detach');
            });
            return readline as never;
          },
          onSignal: () => () => undefined,
        }
      )
    ).resolves.toBe(0);
    expect(output).toContain('[input] accepted\n');
    expect(promptText).toBe('> ');
    expect(promptCount).toBeGreaterThanOrEqual(1);
    expect(disconnected).toBe(true);
  });

  it('renders text and compact normalized activity without protocol JSON', () => {
    expect(renderAgentEvent(envelope('text.delta', { delta: 'hello' }))).toBe('hello');
    expect(
      renderAgentEvent(envelope('activity.changed', { activity: 'waiting', reason: 'tool_approval' }))
    ).toBe('\n[activity] waiting (tool_approval)\n');
    expect(renderAgentEvent(envelope('tool.called', { tool: 'shell' }))).toBe('\n[tool] shell started\n');
    expect(renderAgentEvent(envelope('file.changed', { operation: 'update', path: 'a.ts' }))).toBe(
      '[file] update a.ts\n'
    );
  });

  it('hides reasoning unless explicitly requested', () => {
    const reasoning = envelope('reasoning.delta', { delta: 'private thought' });
    expect(renderAgentEvent(reasoning)).toBeNull();
    expect(renderAgentEvent(reasoning, { reasoning: true })).toBe('private thought');
  });

  it('emits one valid NDJSON object per event in JSON mode', () => {
    const rendered = renderAgentEvent(envelope('text.delta', { delta: 'hello' }), { json: true });
    expect(rendered?.endsWith('\n')).toBe(true);
    expect(JSON.parse(rendered!.trim())).toMatchObject({
      kind: 'agent_event',
      name: 'Worker',
      sequence: 4,
      event: { kind: 'text.delta', delta: 'hello' },
    });
  });

  it('keeps reasoning opt-in in NDJSON mode', () => {
    const reasoning = envelope('reasoning.delta', { delta: 'private thought' });
    expect(renderAgentEvent(reasoning, { json: true })).toBeNull();
    expect(renderAgentEvent(reasoning, { json: true, reasoning: true })).toContain('private thought');
  });

  it('keeps diagnostics opt-in in both human and JSON modes', () => {
    const diagnostic = {
      protocol_version: 1 as const,
      name: 'Worker',
      sequence: 5,
      timestamp: '2026-07-15T00:00:00.000Z',
      diagnostic: { level: 'warning' as const, message: 'adapter warning' },
    };
    expect(renderNativeHarnessDiagnostic(diagnostic)).toBeNull();
    expect(renderNativeHarnessDiagnostic(diagnostic, { diagnostics: true })).toBe(
      '[diagnostic:warning] adapter warning\n'
    );
    expect(() =>
      JSON.parse(renderNativeHarnessDiagnostic(diagnostic, { diagnostics: true, json: true })!.trim())
    ).not.toThrow();
  });
});
