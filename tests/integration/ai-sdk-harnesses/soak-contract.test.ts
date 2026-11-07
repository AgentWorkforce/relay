import { performance } from 'node:perf_hooks';
import type { AgentSessionEvent } from '@agent-relay/sdk';
import { describe, expect, it } from 'vitest';
import { aiSdkAdapterRegistry } from '../../../packages/harnesses/src/ai-sdk/adapter-registry.js';
import { HarnessHost } from '../../../packages/harnesses/src/ai-sdk/harness-host.js';
import { getPtyObservabilityProfile } from '../../../packages/harnesses/src/observability.js';
import {
  AI_SDK_OBSERVABILITY_CAPABILITIES,
  RelayHarnessSession,
} from '../../../packages/harnesses/src/ai-sdk/relay-session.js';
import { FakeHarnessController, FakeSandboxProvider, TEST_IDENTITY, message, settleEvents } from './fakes.js';
import { compareProfiles, summarizeProfile } from './profile-report.js';

const CYCLES = 100;

interface AdapterSoakMetrics {
  adapter: string;
  cycles: number;
  createSuccess: number;
  createRate: number;
  readyMs: { p50: number; p95: number };
  coldReadyMs: number;
  warmReadyMs: { samples: number; p50: number; p95: number };
  turnCompletion: number;
  activeInputAcceptance: number;
  duplicateInjections: number;
  lifecycleSuccess: number;
  cleanupSuccess: number;
  warmStartSamples: number;
  typedFailures: Record<string, number>;
  activityTransitionAccuracy: number;
  observability: ReturnType<typeof summarizeProfile>;
  ptyReferenceComparison?: ReturnType<typeof compareProfiles>;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(3));
}

type AdapterEntry = ReturnType<typeof aiSdkAdapterRegistry.list>[number];

async function runAdapterSoak(entry: AdapterEntry): Promise<AdapterSoakMetrics> {
  const adapter = entry.name;
  const readyMs: number[] = [];
  const warmReadyMs: number[] = [];
  let createSuccess = 0;
  let turnCompletion = 0;
  let activeInputAcceptance = 0;
  let duplicateInjections = 0;
  let lifecycleSuccess = 0;
  let cleanupSuccess = 0;
  let activityTransitionAccuracy = 0;
  const typedFailures: Record<string, number> = {};
  const sandbox = new FakeSandboxProvider();

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const controller = new FakeHarnessController({
      harnessId: adapter,
      autoComplete: false,
      compact: entry.lifecycle.compact,
    });
    const host = new HarnessHost({
      harness: controller.harness,
      sandboxProvider: sandbox,
      workspace: '/tmp/relay-ai-sdk-contract',
      sessionId: `${adapter}-soak-${cycle}`,
    });
    const events: AgentSessionEvent[] = [];
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host });
    session.onEvent((event) => {
      events.push(event);
    });
    try {
      const startedAt = performance.now();
      await host.start();
      const elapsed = performance.now() - startedAt;
      readyMs.push(elapsed);
      if (cycle > 0) warmReadyMs.push(elapsed);
      createSuccess += 1;

      const first = message(cycle * 10 + 1);
      const injected = message(cycle * 10 + 2);
      const duplicate = { ...injected, context: { ...injected.context } };
      await session.receiveMessage(first.message, first.context);
      await session.receiveMessage(injected.message, injected.context);
      await session.receiveMessage(duplicate.message, duplicate.context);
      activeInputAcceptance += controller.activeMessages.length === 1 ? 1 : 0;
      duplicateInjections += Math.max(0, controller.activeMessages.length - 1);
      controller.complete();
      await settleEvents();
      turnCompletion += host.state === 'ready' ? 1 : 0;
      const activities = events
        .filter(
          (event): event is Extract<AgentSessionEvent, { type: 'activity.changed' }> =>
            event.type === 'activity.changed'
        )
        .map((event) => event.activity);
      const requiredActivities = ['starting', 'thinking', 'typing', 'using_tool', 'waiting'] as const;
      activityTransitionAccuracy +=
        requiredActivities.every((activity) => activities.includes(activity)) && activities.at(-1) === 'idle'
          ? 1
          : 0;

      if (entry.lifecycle.compact) {
        await host.compact('soak');
        lifecycleSuccess += controller.compactCount === 1 ? 1 : 0;
      } else {
        await expect(host.compact('soak')).rejects.toThrow('unsupported');
        lifecycleSuccess += 1;
      }
      await session.release('soak complete');
      cleanupSuccess += sandbox.live.size === 0 && host.state === 'destroyed' ? 1 : 0;
    } catch (error) {
      const key = error instanceof Error ? error.constructor.name : 'UnknownFailure';
      typedFailures[key] = (typedFailures[key] ?? 0) + 1;
      await host.destroy().catch(() => undefined);
    }
  }

  return {
    adapter,
    cycles: CYCLES,
    createSuccess,
    createRate: createSuccess / CYCLES,
    readyMs: { p50: percentile(readyMs, 0.5), p95: percentile(readyMs, 0.95) },
    coldReadyMs: Number((readyMs[0] ?? 0).toFixed(3)),
    warmReadyMs: {
      samples: warmReadyMs.length,
      p50: percentile(warmReadyMs, 0.5),
      p95: percentile(warmReadyMs, 0.95),
    },
    turnCompletion,
    activeInputAcceptance,
    duplicateInjections,
    lifecycleSuccess,
    cleanupSuccess,
    warmStartSamples: warmReadyMs.length,
    typedFailures,
    activityTransitionAccuracy,
    observability: summarizeProfile(AI_SDK_OBSERVABILITY_CAPABILITIES),
    ...(entry.ptyAvailable
      ? {
          ptyReferenceComparison: compareProfiles(
            AI_SDK_OBSERVABILITY_CAPABILITIES,
            getPtyObservabilityProfile(entry.name)
          ),
        }
      : {}),
  };
}

describe('deterministic adapter promotion soak', () => {
  it('runs 100 isolated cycles per adapter and emits a host-scoped JSON report', async () => {
    const adapters: AdapterSoakMetrics[] = [];
    for (const entry of aiSdkAdapterRegistry.list()) adapters.push(await runAdapterSoak(entry));
    const report = {
      schemaVersion: 1,
      kind: 'relay.ai-sdk-harness-soak',
      evidenceScope: 'single-host-deterministic-fake-adapter',
      promotionDecision: 'not-authoritative-cross-platform',
      host: { platform: process.platform, arch: process.arch, node: process.versions.node },
      adapters,
    };

    process.stdout.write(`${JSON.stringify(report)}\n`);
    expect(adapters).toHaveLength(aiSdkAdapterRegistry.list().length);
    for (const metrics of adapters) {
      expect(metrics.cycles).toBe(100);
      expect(metrics.createRate).toBe(1);
      expect(metrics.warmReadyMs.samples).toBe(99);
      expect(metrics.turnCompletion).toBe(100);
      expect(metrics.activeInputAcceptance).toBe(100);
      expect(metrics.duplicateInjections).toBe(0);
      expect(metrics.lifecycleSuccess).toBe(100);
      expect(metrics.cleanupSuccess).toBe(100);
      expect(metrics.typedFailures).toEqual({});
      expect(metrics.activityTransitionAccuracy).toBe(100);
    }
  });
});
