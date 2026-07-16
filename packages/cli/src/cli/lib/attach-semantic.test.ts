import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import { attachSemantic, renderSemanticDiagnostic, renderSemanticEvent } from './attach-semantic.js';

const envelope = (kind: string, fields: Record<string, unknown> = {}) =>
  ({
    protocol_version: 1 as const,
    name: 'Worker',
    sequence: 4,
    timestamp: '2026-07-15T00:00:00.000Z',
    event: { kind, ...fields },
  }) as never;

describe('semantic attach rendering', () => {
  it('rejects passthrough without probing a terminal or broker', async () => {
    let error = '';
    await expect(
      attachSemantic(
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
      subscribeSemanticEvents: () => ({ [Symbol.asyncIterator]: () => iterator }),
      getSemanticHistory: async () => ({
        protocol_version: 1,
        name: 'Worker',
        events: [],
        high_water_sequence: 0,
        oldest_available_sequence: null,
        gap: false,
      }),
      onEvent: () => () => undefined,
      sendSemanticCommand: async () => ({
        protocol_version: 1,
        request_id: 'req-1',
        idempotency_key: 'input-1',
        accepted: true,
      }),
    };
    const readline = new EventEmitter() as EventEmitter & { close(): void };
    readline.close = () => undefined;
    await expect(
      attachSemantic(
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
  });

  it('renders text and compact semantic activity without protocol JSON', () => {
    expect(renderSemanticEvent(envelope('text.delta', { delta: 'hello' }))).toBe('hello');
    expect(
      renderSemanticEvent(envelope('activity.changed', { activity: 'waiting', reason: 'tool_approval' }))
    ).toBe('\n[activity] waiting (tool_approval)\n');
    expect(renderSemanticEvent(envelope('tool.called', { tool: 'shell' }))).toBe('\n[tool] shell started\n');
    expect(renderSemanticEvent(envelope('file.changed', { operation: 'update', path: 'a.ts' }))).toBe(
      '[file] update a.ts\n'
    );
  });

  it('hides reasoning unless explicitly requested', () => {
    const reasoning = envelope('reasoning.delta', { delta: 'private thought' });
    expect(renderSemanticEvent(reasoning)).toBeNull();
    expect(renderSemanticEvent(reasoning, { reasoning: true })).toBe('private thought');
  });

  it('emits one valid NDJSON object per event in JSON mode', () => {
    const rendered = renderSemanticEvent(envelope('text.delta', { delta: 'hello' }), { json: true });
    expect(rendered?.endsWith('\n')).toBe(true);
    expect(JSON.parse(rendered!.trim())).toMatchObject({
      kind: 'semantic_event',
      name: 'Worker',
      sequence: 4,
      event: { kind: 'text.delta', delta: 'hello' },
    });
  });

  it('keeps reasoning opt-in in NDJSON mode', () => {
    const reasoning = envelope('reasoning.delta', { delta: 'private thought' });
    expect(renderSemanticEvent(reasoning, { json: true })).toBeNull();
    expect(renderSemanticEvent(reasoning, { json: true, reasoning: true })).toContain('private thought');
  });

  it('keeps diagnostics opt-in in both human and JSON modes', () => {
    const diagnostic = {
      protocol_version: 1 as const,
      name: 'Worker',
      sequence: 5,
      timestamp: '2026-07-15T00:00:00.000Z',
      diagnostic: { level: 'warning' as const, message: 'adapter warning' },
    };
    expect(renderSemanticDiagnostic(diagnostic)).toBeNull();
    expect(renderSemanticDiagnostic(diagnostic, { diagnostics: true })).toBe(
      '[diagnostic:warning] adapter warning\n'
    );
    expect(() =>
      JSON.parse(renderSemanticDiagnostic(diagnostic, { diagnostics: true, json: true })!.trim())
    ).not.toThrow();
  });
});
