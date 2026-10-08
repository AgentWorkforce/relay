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

describe('MCP request replay', () => {
  it('runs distinct request IDs separately even while an identical write is pending', async () => {
    const replay = new McpRequestReplay();
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const first = replay.run('reply_to_thread', { requestId: 1, sessionId: 's' }, undefined, operation);
    const second = replay.run('reply_to_thread', { requestId: 2, sessionId: 's' }, undefined, operation);
    expect(operation).toHaveBeenCalledTimes(2);
    pending.resolve('reply');
    await Promise.all([first, second]);
  });

  it('joins a transport replay of one request ID within a session and tool', async () => {
    const replay = new McpRequestReplay();
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const first = replay.run('post_message', { requestId: 7, sessionId: 'a' }, undefined, operation);
    expect(replay.run('post_message', { requestId: 7, sessionId: 'a' }, undefined, operation)).toBe(first);
    void replay.run('post_message', { requestId: 7, sessionId: 'b' }, undefined, operation);
    void replay.run('reply_to_thread', { requestId: 7, sessionId: 'a' }, undefined, operation);
    expect(operation).toHaveBeenCalledTimes(3);
    pending.resolve('ok');
    await first;
  });

  it('clears a rejected request ID for a safe retry', async () => {
    const replay = new McpRequestReplay();
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const send = () => replay.run('reply_to_thread', { requestId: 1 }, undefined, operation);
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
