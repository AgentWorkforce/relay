import { describe, expect, it } from 'vitest';

import { aggregateMetrics } from './metrics.js';
import type { ScenarioResult } from '../types.js';

function result(overrides: Partial<ScenarioResult>): ScenarioResult {
  return {
    id: 'x',
    title: 'x',
    pass: true,
    sent: 1,
    expected: 1,
    phantoms: [],
    totalIntents: 0,
    protocolAdherence: null,
    wrongChannelReplies: 0,
    deliveryOk: true,
    events: { relayInbound: 1, dropped: 0, aclDenied: 0 },
    ...overrides,
  };
}

describe('aggregateMetrics', () => {
  it('computes rates across scenarios', () => {
    const m = aggregateMetrics([
      result({ sent: 1, expected: 1, pass: true }),
      result({ sent: 1, expected: 2, pass: false }),
    ]);
    expect(m.messageSentRate).toBeCloseTo(2 / 3);
    expect(m.scenariosPassed).toBe(1);
    expect(m.scenariosTotal).toBe(2);
    expect(m.deliverySuccessRate).toBe(1);
  });

  it('phantom rate is phantomCount / totalIntents', () => {
    const m = aggregateMetrics([
      result({
        totalIntents: 3,
        phantoms: [
          { agent: 'A', verb: 'tell', snippet: '' },
          { agent: 'A', verb: 'post', snippet: '' },
        ],
      }),
    ]);
    expect(m.phantomCount).toBe(2);
    expect(m.phantomRate).toBeCloseTo(2 / 3);
  });

  it('phantom rate is 0 when no intents were expressed', () => {
    expect(aggregateMetrics([result({ totalIntents: 0, phantoms: [] })]).phantomRate).toBe(0);
  });

  it('protocol adherence averages only applicable scenarios', () => {
    const m = aggregateMetrics([
      result({ protocolAdherence: 1 }),
      result({ protocolAdherence: 0.5 }),
      result({ protocolAdherence: null }),
    ]);
    expect(m.protocolAdherence).toBeCloseTo(0.75);
  });

  it('delivery failures lower the success rate', () => {
    const m = aggregateMetrics([result({ deliveryOk: true }), result({ deliveryOk: false })]);
    expect(m.deliverySuccessRate).toBe(0.5);
  });
});
