import { describe, expect, it } from 'vitest';

import { MeteringCollector, checkBudget } from '../metering.js';
import type { MeteringRecord, ProxyTokenClaims } from '../types.js';

function createClaims(overrides: Partial<ProxyTokenClaims> = {}): ProxyTokenClaims {
  return {
    sub: 'workspace-1',
    aud: 'relay-llm-proxy',
    provider: 'openai',
    credentialId: 'cred-1',
    budget: undefined,
    iat: 1,
    exp: 2,
    jti: 'token-1',
    iss: 'relay-credential-proxy',
    ...overrides,
  };
}

function createRecord(overrides: Partial<MeteringRecord> = {}): MeteringRecord {
  return {
    requestId: 'req-1',
    workspaceId: 'workspace-1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputTokens: 100,
    outputTokens: 40,
    timestamp: '2026-04-10T10:00:00.000Z',
    durationMs: 125,
    credentialId: 'cred-1',
    endpoint: '/v1/chat/completions',
    ...overrides,
  };
}

describe('MeteringCollector', () => {
  it('records entries and retrieves usage by workspace', () => {
    const collector = new MeteringCollector();

    collector.record(createRecord());
    collector.record(
      createRecord({
        requestId: 'req-2',
        inputTokens: 60,
        outputTokens: 20,
      })
    );
    collector.record(
      createRecord({
        requestId: 'req-3',
        workspaceId: 'workspace-2',
        credentialId: 'cred-2',
        inputTokens: 5,
        outputTokens: 10,
      })
    );

    expect(collector.getUsageByWorkspace('workspace-1')).toEqual({
      inputTokens: 160,
      outputTokens: 60,
      requests: 2,
    });
    expect(collector.getUsageByCredential('cred-1')).toEqual({
      inputTokens: 160,
      outputTokens: 60,
      requests: 2,
    });
    expect(collector.getTotalUsage()).toEqual({
      inputTokens: 165,
      outputTokens: 70,
      requests: 3,
    });
  });

  it('flush returns and clears the buffer', () => {
    const collector = new MeteringCollector();
    const first = createRecord();
    const second = createRecord({ requestId: 'req-2', inputTokens: 10, outputTokens: 5 });

    collector.record(first);
    collector.record(second);

    expect(collector.flush()).toEqual([first, second]);
    expect(collector.flush()).toEqual([]);
    expect(collector.getTotalUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });
  });
});

describe('checkBudget', () => {
  it('allows requests when usage is under budget', () => {
    const collector = new MeteringCollector();
    collector.record(createRecord({ inputTokens: 120, outputTokens: 30 }));

    expect(
      checkBudget(
        createClaims({
          budget: 200,
        }),
        collector
      )
    ).toEqual({
      allowed: true,
      remaining: 50,
    });
  });

  it('blocks requests when usage is over budget', () => {
    const collector = new MeteringCollector();
    collector.record(createRecord({ inputTokens: 150, outputTokens: 75 }));

    expect(
      checkBudget(
        createClaims({
          budget: 200,
        }),
        collector
      )
    ).toEqual({
      allowed: false,
      remaining: 0,
    });
  });
});
