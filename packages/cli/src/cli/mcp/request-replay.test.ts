import { describe, expect, it, vi } from 'vitest';
import { McpRequestReplay } from './request-replay.js';

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('pending message write coalescing', () => {
  it('joins concurrent aliases, reports coalescing, and permits a sequential repeat', async () => {
    const replay = new McpRequestReplay();
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const coalesced = vi.fn();
    const send = (requestId: number) =>
      replay.run('reply_to_thread', { requestId, sessionId: 's' }, undefined, () =>
        replay.coalesceWrite(
          'reply_to_thread',
          { sessionId: 's' },
          ['agent', 'parent', 'ACK'],
          operation,
          coalesced
        )
      );
    const first = send(1);
    const alias = send(2);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(coalesced).toHaveBeenCalledTimes(1);
    pending.resolve('reply');
    expect(await first).toBe(await alias);
    await send(3);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('separates sessions, identities, targets, tools, and write options', async () => {
    const replay = new McpRequestReplay();
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const writes = [
      replay.coalesceWrite('post_message', { sessionId: 'a' }, ['alice', 'c', 'ACK', [], 'wait'], operation),
      replay.coalesceWrite('post_message', { sessionId: 'b' }, ['alice', 'c', 'ACK', [], 'wait'], operation),
      replay.coalesceWrite('post_message', { sessionId: 'a' }, ['bob', 'c', 'ACK', [], 'wait'], operation),
      replay.coalesceWrite('post_message', { sessionId: 'a' }, ['alice', 'd', 'ACK', [], 'wait'], operation),
      replay.coalesceWrite(
        'reply_to_thread',
        { sessionId: 'a' },
        ['alice', 'c', 'ACK', [], 'wait'],
        operation
      ),
      replay.coalesceWrite(
        'post_message',
        { sessionId: 'a' },
        ['alice', 'c', 'ACK', ['file'], 'wait'],
        operation
      ),
      replay.coalesceWrite('post_message', { sessionId: 'a' }, ['alice', 'c', 'ACK', [], 'steer'], operation),
    ];
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(7);
    pending.resolve('ok');
    await Promise.all(writes);
  });

  it('clears rejected writes and transport request IDs for a safe retry', async () => {
    const replay = new McpRequestReplay();
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const send = () =>
      replay.run('reply_to_thread', { requestId: 1 }, undefined, () =>
        replay.coalesceWrite('reply_to_thread', {}, ['a', 'p', 'ACK'], operation)
      );
    const first = send();
    expect(send()).toBe(first);
    const assertion = expect(first).rejects.toThrow('unavailable');
    pending.reject(new Error('unavailable'));
    await assertion;
    operation.mockResolvedValue('retry');
    expect(await send()).toBe('retry');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
