import { describe, expect, it } from 'vitest';

import {
  classifyBrokerStartError,
  classifyBrokerStartStage,
  describeError,
  readNodeDeliveryStatus,
  waitForNodeDelivery,
} from './broker-lifecycle.js';

describe('describeError', () => {
  it('returns plain message for a bare Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('unwraps the Node fetch failed cause and surfaces the network code', () => {
    // Mirror the shape Node 22 produces: TypeError with a cause carrying .code.
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3889'), {
      code: 'ECONNREFUSED',
    });
    const err = new TypeError('fetch failed', { cause });

    const result = describeError(err);
    expect(result).toContain('fetch failed');
    expect(result).toContain('ECONNREFUSED');
    expect(result).toContain('127.0.0.1');
  });

  it('unwraps DNS errors (ENOTFOUND)', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.agentrelay.com'), {
      code: 'ENOTFOUND',
    });
    const err = new TypeError('fetch failed', { cause });

    const result = describeError(err);
    expect(result).toContain('ENOTFOUND');
    expect(result).toContain('agentrelay.com');
  });

  it('handles non-Error values without throwing', () => {
    expect(describeError('something went wrong')).toBe('something went wrong');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(null)).toBe('null');
  });

  it('caps the cause-chain walk so a cycle cannot loop forever', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    // Just needs to terminate — the assertion is the absence of a hang.
    expect(typeof describeError(a)).toBe('string');
  });
});

describe('classifyBrokerStartError', () => {
  it('prefers the underlying network code over the constructor name', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause });

    expect(classifyBrokerStartError(err)).toBe('ECONNREFUSED');
  });

  it('falls back to the constructor name when no code is present', () => {
    expect(classifyBrokerStartError(new Error('whatever'))).toBe('Error');
    expect(classifyBrokerStartError(new TypeError('boom'))).toBe('TypeError');
  });

  it('handles non-Error values', () => {
    expect(classifyBrokerStartError('oops')).toBe('string');
    expect(classifyBrokerStartError(undefined)).toBe('undefined');
  });
});

describe('classifyBrokerStartStage', () => {
  it('marks already-running brokers from the message text', () => {
    const message = 'another broker instance is already running in this directory (/tmp/x)';
    expect(classifyBrokerStartStage(new Error(message), message)).toBe('already_running');
  });

  it('classifies fetch failures as connect-stage errors', () => {
    const cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause });
    expect(classifyBrokerStartStage(err, 'fetch failed')).toBe('connect');
  });

  it('classifies broker-exited-before-ready as a spawn failure', () => {
    const message = 'Broker process exited with code 1 before becoming ready (pid=123; …)';
    expect(classifyBrokerStartStage(new Error(message), message)).toBe('spawn');
  });

  it('falls back to startup for everything else', () => {
    expect(classifyBrokerStartStage(new Error('???'), '???')).toBe('startup');
  });
});

describe('readNodeDeliveryStatus', () => {
  it('reads the canonical snake_case broker status shape', () => {
    expect(
      readNodeDeliveryStatus({
        node_connected: true,
        node_delivery: { token_present: true, connected: true },
      })
    ).toEqual({ tokenPresent: true, connected: true });
  });

  it('defaults absent node delivery fields to false', () => {
    expect(readNodeDeliveryStatus({ agent_count: 0 })).toEqual({
      tokenPresent: false,
      connected: false,
    });
  });

  it('rejects non-object status values', () => {
    expect(readNodeDeliveryStatus(null)).toBeNull();
    expect(readNodeDeliveryStatus('nope')).toBeNull();
  });
});

describe('waitForNodeDelivery', () => {
  it('continues polling after a transient status failure', async () => {
    let now = 0;
    let calls = 0;
    const relay = {
      async getStatus() {
        calls += 1;
        if (calls === 1) {
          throw new Error('broker not ready yet');
        }
        return {
          node_connected: calls >= 3,
          node_delivery: { token_present: true, connected: calls >= 3 },
        };
      },
    };
    const deps = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };

    await expect(waitForNodeDelivery(relay as never, deps as never, 1_000)).resolves.toEqual({
      ready: true,
      status: {
        node_connected: true,
        node_delivery: { token_present: true, connected: true },
      },
    });
    expect(calls).toBe(3);
  });
});
