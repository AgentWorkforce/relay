import { describe, expect, it } from 'vitest';
import {
  GET_AGENT_RATE_LIMIT_DEFAULT_BACKOFF_MS,
  GET_AGENT_RATE_LIMIT_MAX_ATTEMPTS,
  getAgent,
  type EngineHandle,
} from './harness.js';

/** Minimal fake `EngineHandle` whose `fetchJson` is driven by a scripted list
 * of responses (one per call), so `getAgent`'s retry logic can be exercised
 * deterministically without a real Relaycast engine or network. */
function fakeEngine(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>): {
  engine: EngineHandle;
  calls: number[];
} {
  const calls: number[] = [];
  let index = 0;
  const engine: EngineHandle = {
    baseUrl: 'http://127.0.0.1:0',
    port: 0,
    async stop() {},
    async fetchJson() {
      calls.push(Date.now());
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        status: next.status,
        body: next.body,
        headers: new Headers(next.headers ?? {}),
      };
    },
  };
  return { engine, calls };
}

const RATE_LIMIT_BODY = {
  ok: false,
  error: {
    code: 'rate_limit_exceeded',
    message: 'Rate limit exceeded. 300 requests per minute allowed for free plan.',
  },
};

describe('getAgent 429 rate_limit_exceeded retry', () => {
  it('retries a single rate_limit_exceeded 429 honoring Retry-After and eventually succeeds', async () => {
    const { engine, calls } = fakeEngine([
      { status: 429, body: RATE_LIMIT_BODY, headers: { 'retry-after': '0' } },
      { status: 200, body: { data: { name: 'worker-a' } } },
    ]);

    const started = Date.now();
    const result = await getAgent(engine, 'rk_test', 'worker-a');
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({ name: 'worker-a' });
    expect(calls).toHaveLength(2);
    // Retry-After: 0 means no meaningful delay is required.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('exhausts the attempt/deadline cap and throws on a persistent rate_limit_exceeded 429', async () => {
    const { engine, calls } = fakeEngine([
      { status: 429, body: RATE_LIMIT_BODY, headers: { 'retry-after': '0' } },
    ]);

    await expect(getAgent(engine, 'rk_test', 'worker-a')).rejects.toThrow(/rate_limit_exceeded/);
    expect(calls.length).toBe(GET_AGENT_RATE_LIMIT_MAX_ATTEMPTS);
  });

  it('fails fast (does not hang) when the rate limit persists without Retry-After', async () => {
    const { engine } = fakeEngine([{ status: 429, body: RATE_LIMIT_BODY }]);

    const started = Date.now();
    await expect(getAgent(engine, 'rk_test', 'worker-a')).rejects.toThrow();
    const elapsedMs = Date.now() - started;

    // Default backoff is bounded and small; the whole retry budget must stay
    // well under the deadline cap, not hang.
    const worstCase = GET_AGENT_RATE_LIMIT_DEFAULT_BACKOFF_MS * GET_AGENT_RATE_LIMIT_MAX_ATTEMPTS + 1_000;
    expect(elapsedMs).toBeLessThan(worstCase);
  });

  it('does not retry a non-rate_limit_exceeded 429 and throws immediately', async () => {
    const { engine, calls } = fakeEngine([
      { status: 429, body: { ok: false, error: { code: 'some_other_error', message: 'nope' } } },
    ]);

    await expect(getAgent(engine, 'rk_test', 'worker-a')).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry other statuses and throws immediately, exactly as before', async () => {
    const { engine, calls } = fakeEngine([{ status: 500, body: { ok: false } }]);

    await expect(getAgent(engine, 'rk_test', 'worker-a')).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  it('still returns null on 404 without retrying', async () => {
    const { engine, calls } = fakeEngine([{ status: 404, body: {} }]);

    const result = await getAgent(engine, 'rk_test', 'worker-a');
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
