import { describe, expect, it } from 'vitest';

import {
  createPtyObservabilityTranslator,
  getPtyObservabilityProfile,
  PTY_OBSERVABILITY_PROFILES,
} from './observability.js';

describe('PTY observability profiles', () => {
  it('declares every built-in PTY harness against one honest baseline', () => {
    expect(Object.keys(PTY_OBSERVABILITY_PROFILES)).toHaveLength(9);
    for (const profile of Object.values(PTY_OBSERVABILITY_PROFILES)) {
      expect(profile.activities.starting).toEqual({ available: true, fidelities: ['exact'] });
      expect(profile.activities.thinking).toEqual({ available: true, fidelities: ['inferred'] });
      expect(profile.activities.typing).toEqual({ available: false });
      expect(profile.events.tools).toEqual({ available: false });
    }
    expect(getPtyObservabilityProfile('cursor')).toBe(getPtyObservabilityProfile('cursor-agent'));
  });

  it('rejects unknown harnesses instead of inventing capabilities', () => {
    expect(() => getPtyObservabilityProfile('unknown')).toThrow(/No PTY observability profile/);
  });
});

describe('PTY observability translator', () => {
  it('emits exact lifecycle and inferred turn boundaries with ordered provenance', () => {
    const translator = createPtyObservabilityTranslator('claude');
    const events = [
      ...translator.translate({ type: 'starting', at: '2026-07-15T00:00:00Z' }),
      ...translator.translate({ type: 'busy', turnId: 'turn-1', at: '2026-07-15T00:00:01Z' }),
      ...translator.translate({ type: 'idle', turnId: 'turn-1', at: '2026-07-15T00:00:02Z' }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      'session.starting',
      'activity.changed',
      'turn.started',
      'activity.changed',
      'turn.settled',
      'activity.changed',
    ]);
    expect(events.map((event) => event.observability.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[0]?.observability).toMatchObject({ source: 'broker', fidelity: 'exact' });
    expect(events[2]?.observability).toMatchObject({ source: 'broker', fidelity: 'inferred' });
  });

  it('deduplicates repeated boundaries and ignores stale idle signals', () => {
    const translator = createPtyObservabilityTranslator('codex');
    expect(translator.translate({ type: 'busy', turnId: 'turn-1' })).toHaveLength(2);
    expect(translator.translate({ type: 'busy', turnId: 'turn-1' })).toEqual([]);
    expect(translator.translate({ type: 'idle', turnId: 'old-turn' })).toEqual([]);
    expect(translator.translate({ type: 'idle', turnId: 'turn-1' })).toHaveLength(2);
  });

  it('emits exact runtime failures', () => {
    const translator = createPtyObservabilityTranslator('gemini');
    const events = translator.translate({ type: 'error', error: 'process exited', code: 'exit_1' });
    expect(events.map((event) => event.type)).toEqual(['session.failed', 'activity.changed']);
    expect(events.every((event) => event.observability.fidelity === 'exact')).toBe(true);
  });
});
