import { describe, expect, it, vi } from 'vitest';
import { McpRequestReplay, replayScopeOf, withReplayScope } from './request-replay.js';

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

  // A session can switch its acting identity (`as`, or register_agent moving
  // the default) and reuse a key; that must send, not replay another
  // identity's receipt.
  it('scopes a retained idempotency key to the acting identity', async () => {
    const replay = new McpRequestReplay();
    const operation = vi.fn(async () => 'receipt');
    const extra = { requestId: 1, sessionId: 's' };
    await replay.run('post_message', extra, 'k', operation, 'agent-a');
    await replay.run('post_message', { ...extra, requestId: 2 }, 'k', operation, 'agent-a');
    expect(operation).toHaveBeenCalledTimes(1);
    await replay.run('post_message', { ...extra, requestId: 3 }, 'k', operation, 'agent-b');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('derives a stable token-free scope from a tagged client', () => {
    const a = withReplayScope({}, 'token-a');
    expect(replayScopeOf(a)).toBe(replayScopeOf(withReplayScope({}, 'token-a')));
    expect(replayScopeOf(a)).not.toBe(replayScopeOf(withReplayScope({}, 'token-b')));
    expect(replayScopeOf(a)).not.toContain('token-a');
    expect(JSON.stringify(a)).toBe('{}');
    expect(replayScopeOf({})).toBe('');
  });

  // Retention is checked lazily: a settling write must not leave a timer
  // behind (it would land on whatever clock a later caller installed).
  it('retains a completed idempotency key for five minutes without scheduling a timer', async () => {
    vi.useFakeTimers();
    try {
      const replay = new McpRequestReplay();
      const operation = vi.fn(async () => 'receipt');
      await replay.run('post_message', { requestId: 1 }, 'k', operation);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 - 1);
      await replay.run('post_message', { requestId: 2 }, 'k', operation);
      expect(operation).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 1);
      await replay.run('post_message', { requestId: 3 }, 'k', operation);
      expect(operation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
