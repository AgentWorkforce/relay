import { describe, expect, it } from 'vitest';
import { aiSdkAdapterRegistry } from '../../../packages/harnesses/src/ai-sdk/adapter-registry.js';
import { AI_SDK_OBSERVABILITY_CAPABILITIES } from '../../../packages/harnesses/src/ai-sdk/relay-session.js';
import {
  createPtyObservabilityTranslator,
  getPtyObservabilityProfile,
  PTY_OBSERVABILITY_PROFILES,
} from '../../../packages/harnesses/src/observability.js';
import { compareProfiles } from './profile-report.js';

describe('PTY parity against the AI SDK reference profile', () => {
  it('registers every current PTY harness and shared AI SDK adapter', () => {
    expect(Object.keys(PTY_OBSERVABILITY_PROFILES).sort()).toEqual([
      'aider',
      'claude',
      'codex',
      'cursor-agent',
      'droid',
      'gemini',
      'goose',
      'grok',
      'opencode',
    ]);
    for (const entry of aiSdkAdapterRegistry.list().filter((value) => value.ptyAvailable)) {
      expect(() => getPtyObservabilityProfile(entry.name)).not.toThrow();
    }
  });

  it('claims exact broker lifecycle/error and only inferred busy/idle boundaries', () => {
    for (const profile of Object.values(PTY_OBSERVABILITY_PROFILES)) {
      expect(profile.activities.starting).toEqual({ available: true, fidelities: ['exact'] });
      expect(profile.activities.error).toEqual({ available: true, fidelities: ['exact'] });
      expect(profile.activities.thinking).toEqual({ available: true, fidelities: ['inferred'] });
      expect(profile.activities.idle).toEqual({ available: true, fidelities: ['inferred'] });
      expect(profile.events.lifecycle).toEqual({ available: true, fidelities: ['exact'] });
      expect(profile.events.errors).toEqual({ available: true, fidelities: ['exact'] });
      expect(profile.events.turns).toEqual({ available: true, fidelities: ['inferred'] });
    }
  });

  it('lists every reference gap by semantic family and fidelity, without a scalar score', () => {
    const comparison = compareProfiles(
      AI_SDK_OBSERVABILITY_CAPABILITIES,
      getPtyObservabilityProfile('claude')
    );
    expect(comparison.activities).toMatchObject({
      starting: { reference: ['exact'], candidate: ['exact'] },
      thinking: { reference: ['exact', 'inferred'], candidate: ['inferred'] },
      typing: { reference: ['exact'], candidate: ['unavailable'] },
      using_tool: { reference: ['exact'], candidate: ['unavailable'] },
      waiting: { reference: ['exact'], candidate: ['unavailable'] },
      idle: { reference: ['exact'], candidate: ['inferred'] },
      error: { reference: ['exact'], candidate: ['exact'] },
    });
    expect(comparison.semanticFamilies).toMatchObject({
      lifecycle: { reference: ['exact'], candidate: ['exact'] },
      turns: { reference: ['exact'], candidate: ['inferred'] },
      text: { reference: ['exact'], candidate: ['unavailable'] },
      reasoning: { reference: ['exact'], candidate: ['unavailable'] },
      tools: { reference: ['exact'], candidate: ['unavailable'] },
      tool_approvals: { reference: ['exact'], candidate: ['unavailable'] },
      files: { reference: ['exact'], candidate: ['unavailable'] },
      compaction: { reference: ['exact'], candidate: ['unavailable'] },
      usage: { reference: ['exact'], candidate: ['unavailable'] },
      errors: { reference: ['exact'], candidate: ['exact'] },
    });
    expect(comparison).not.toHaveProperty('score');
  });

  it('emits PTY observations whose provenance and fidelity match the profile', () => {
    const translator = createPtyObservabilityTranslator('codex');
    const events = [
      ...translator.translate({ type: 'starting', at: '2026-01-01T00:00:00.000Z' }),
      ...translator.translate({ type: 'busy', turnId: 'turn-1', at: '2026-01-01T00:00:01.000Z' }),
      ...translator.translate({ type: 'idle', turnId: 'turn-1', at: '2026-01-01T00:00:02.000Z' }),
      ...translator.translate({
        type: 'error',
        error: 'crashed',
        code: 'EXIT_1',
        at: '2026-01-01T00:00:03.000Z',
      }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      'session.starting',
      'activity.changed',
      'turn.started',
      'activity.changed',
      'turn.settled',
      'activity.changed',
      'session.failed',
      'activity.changed',
    ]);
    expect(events.filter((event) => ['session.starting', 'session.failed'].includes(event.type))).toSatisfy(
      (values) => values.every((event) => event.observability.fidelity === 'exact')
    );
    expect(events.filter((event) => ['turn.started', 'turn.settled'].includes(event.type))).toSatisfy(
      (values) => values.every((event) => event.observability.fidelity === 'inferred')
    );
    expect(events.every((event) => event.observability.source === 'broker')).toBe(true);
    expect(events.map((event) => event.observability.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
