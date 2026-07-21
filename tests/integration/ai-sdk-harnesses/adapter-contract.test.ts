import type { AgentSessionEvent } from '@agent-relay/sdk';
import { describe, expect, it } from 'vitest';
import { aiSdkAdapterRegistry } from '../../../packages/harnesses/src/ai-sdk/adapter-registry.js';
import { HarnessHost } from '../../../packages/harnesses/src/ai-sdk/harness-host.js';
import {
  AI_SDK_OBSERVABILITY_CAPABILITIES,
  formatInboundRelayPrompt,
  RelayHarnessSession,
} from '../../../packages/harnesses/src/ai-sdk/relay-session.js';
import { FakeHarnessController, FakeSandboxProvider, TEST_IDENTITY, message, settleEvents } from './fakes.js';

function host(controller: FakeHarnessController, sandbox = new FakeSandboxProvider(), sessionId?: string) {
  return {
    sandbox,
    host: new HarnessHost({
      harness: controller.harness,
      sandboxProvider: sandbox,
      workspace: '/tmp/relay-ai-sdk-contract',
      sessionId,
    }),
  };
}

describe.each(aiSdkAdapterRegistry.list().map((entry) => [entry.name, entry] as const))(
  '%s deterministic adapter contract',
  (_name, entry) => {
    it('supports cold and warm creation with one bootstrap per stable recipe', async () => {
      const sandbox = new FakeSandboxProvider();
      const firstController = new FakeHarnessController({ harnessId: entry.name });
      const secondController = new FakeHarnessController({ harnessId: entry.name });
      const first = host(firstController, sandbox, `${entry.name}-cold`).host;
      const second = host(secondController, sandbox, `${entry.name}-warm`).host;

      await first.start();
      await first.destroy();
      await second.start();

      expect(sandbox.createCount).toBe(2);
      expect(sandbox.bootstrapCount).toBe(1);
      expect(second.state).toBe('ready');
      await second.destroy();
      expect(sandbox.live.size).toBe(0);
    });

    it('runs first and subsequent turns without replaying prior prompts', async () => {
      const controller = new FakeHarnessController({ harnessId: entry.name });
      const runtime = host(controller).host;
      await runtime.start();
      await (
        await runtime.startTurn('first', 'turn-1')
      ).done;
      await (
        await runtime.startTurn('second', 'turn-2')
      ).done;

      expect(controller.prompts).toEqual(['first', 'second']);
      expect(runtime.state).toBe('ready');
      await runtime.destroy();
    });

    it('detaches and resumes the same parked sandbox before a new turn', async () => {
      const sandbox = new FakeSandboxProvider();
      const controller = new FakeHarnessController({ harnessId: entry.name });
      const sessionId = `${entry.name}-detach-resume`;
      const original = host(controller, sandbox, sessionId).host;
      await original.start();
      const resumeFrom = await original.detach();

      const resumed = new HarnessHost({
        harness: controller.harness,
        sandboxProvider: sandbox,
        workspace: '/tmp/relay-ai-sdk-contract',
        sessionId,
        resumeFrom,
      });
      await resumed.start();
      await (
        await resumed.startTurn('after detach', 'turn-after-detach')
      ).done;

      expect(sandbox.resumeCount).toBe(1);
      expect(controller.starts.at(-1)?.resumeFrom).toEqual(resumeFrom);
      expect(controller.prompts).toEqual(['after detach']);
      await resumed.destroy();
      expect(sandbox.live.size).toBe(0);
    });

    it('stops and resumes with a fresh process wrapper and declared continuity', async () => {
      const sandbox = new FakeSandboxProvider();
      const controller = new FakeHarnessController({ harnessId: entry.name });
      const sessionId = `${entry.name}-stop-resume`;
      const original = host(controller, sandbox, sessionId).host;
      await original.start();
      const resumeFrom = await original.stop();
      expect(sandbox.live.size).toBe(0);

      const resumed = new HarnessHost({
        harness: controller.harness,
        sandboxProvider: sandbox,
        workspace: '/tmp/relay-ai-sdk-contract',
        sessionId,
        resumeFrom,
      });
      await resumed.start();
      await (
        await resumed.startTurn('after stop', 'turn-after-stop')
      ).done;

      expect(sandbox.resumeCount).toBe(1);
      expect(sandbox.createCount).toBe(2);
      expect(controller.starts.at(-1)?.resumeFrom).toEqual(resumeFrom);
      expect(entry.lifecycle.stopPreservesConversation).toBe(entry.name !== 'deepagents');
      await resumed.destroy();
    });

    it('matches every declared lifecycle capability with the method outcome', async () => {
      const controller = new FakeHarnessController({
        harnessId: entry.name,
        autoComplete: false,
        compact: entry.lifecycle.compact,
      });
      const sandbox = new FakeSandboxProvider();
      const runtime = host(controller, sandbox, `${entry.name}-lifecycle`).host;
      await runtime.start();

      if (entry.lifecycle.compact) {
        await expect(runtime.compact('retain decisions')).resolves.toBeUndefined();
      } else {
        await expect(runtime.compact('retain decisions')).rejects.toThrow('unsupported');
      }

      const active = await runtime.startTurn('suspend me', 'turn-suspend');
      const continuedState = await runtime.suspend();
      expect(continuedState.type).toBe('continue-turn');
      await active.done;
      const continued = await runtime.continue(continuedState, 'turn-continued');
      controller.complete();
      await continued.done;
      expect(controller.suspendCount).toBe(1);
      expect(controller.continueCount).toBe(1);

      const detachedState = await runtime.detach();
      expect(detachedState.type).toBe('resume-session');
      expect(controller.detachCount).toBe(1);
      await runtime.destroy();
      expect(sandbox.live.size).toBe(0);
    });

    it('declares adapter-specific continuity limitations without hiding support', () => {
      expect(entry.lifecycle.activeInput).toBe(true);
      expect(entry.lifecycle.destroy).toBe(true);
      expect(entry.lifecycle.stopPreservesConversation).toBe(entry.name !== 'deepagents');
      expect(entry.lifecycle.compact).toBe(entry.name !== 'deepagents');
      expect(entry.rollout).toBe('experimental');
    });
  }
);

describe('RelayHarnessSession delivery contract', () => {
  it('starts one turn from idle and accepts one active injection', async () => {
    const controller = new FakeHarnessController({ autoComplete: false });
    const runtime = host(controller).host;
    await runtime.start();
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host: runtime });

    const first = message(1);
    const second = message(2);
    await expect(session.receiveMessage(first.message, first.context)).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(session.receiveMessage(second.message, second.context)).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(controller.prompts).toEqual([formatInboundRelayPrompt(first.message)]);
    expect(controller.activeMessages).toEqual([formatInboundRelayPrompt(second.message)]);
    controller.complete();
    await settleEvents();
    await session.release();
  });

  it('deduplicates identical ids and preserves concurrent input order', async () => {
    const controller = new FakeHarnessController({ autoComplete: false });
    const runtime = host(controller).host;
    await runtime.start();
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host: runtime });
    const first = message(1);
    const inputs = [message(2), message(3), message(4)];

    const firstReceipt = await session.receiveMessage(first.message, first.context);
    const duplicateReceipts = await Promise.all([
      session.receiveMessage(first.message, first.context),
      session.receiveMessage(first.message, first.context),
    ]);
    const concurrentReceipts = await Promise.all(
      inputs.map((input) => session.receiveMessage(input.message, input.context))
    );

    expect(duplicateReceipts).toEqual([firstReceipt, firstReceipt]);
    expect(concurrentReceipts.every((receipt) => receipt.status === 'accepted')).toBe(true);
    expect(controller.prompts).toEqual([formatInboundRelayPrompt(first.message)]);
    expect(controller.activeMessages).toEqual(inputs.map((input) => formatInboundRelayPrompt(input.message)));
    controller.complete();
    await settleEvents();
    await session.release();
  });

  it('drops queued work on release without emitting a false delivery acknowledgement', async () => {
    const controller = new FakeHarnessController({ autoComplete: false });
    const runtime = host(controller).host;
    await runtime.start();
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host: runtime });
    const events: AgentSessionEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
    });
    const first = message(1);
    const queued = message(2);
    queued.context.mode = 'on-idle';

    await session.receiveMessage(first.message, first.context);
    await expect(session.receiveMessage(queued.message, queued.context)).resolves.toMatchObject({
      status: 'deferred',
      metadata: { queued: true },
    });
    await session.release('contract cleanup');
    controller.complete();
    await settleEvents();

    expect(controller.prompts).toEqual([formatInboundRelayPrompt(first.message)]);
    expect(events.filter((event) => event.type === 'delivery.accepted')).toHaveLength(1);
    expect(runtime.state).toBe('destroyed');
  });

  it('rejects unsupported active input rather than acknowledging it', async () => {
    const controller = new FakeHarnessController({ autoComplete: false, activeInput: false });
    const runtime = host(controller).host;
    await runtime.start();
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host: runtime });
    const first = message(1);
    const second = message(2);
    await session.receiveMessage(first.message, first.context);

    await expect(session.receiveMessage(second.message, second.context)).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });
    expect(controller.activeMessages).toEqual([]);
    controller.complete();
    await settleEvents();
    await session.release();
  });

  it('publishes the complete AI SDK reference capability profile', async () => {
    const controller = new FakeHarnessController();
    const runtime = host(controller).host;
    await runtime.start();
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host: runtime });
    const events: AgentSessionEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
    });

    expect(session.capabilities.observability).toEqual(AI_SDK_OBSERVABILITY_CAPABILITIES);
    expect(events[0]).toMatchObject({
      type: 'observability.capabilities',
      capabilities: AI_SDK_OBSERVABILITY_CAPABILITIES,
      observability: { source: 'ai-sdk', fidelity: 'exact', sequence: 0 },
    });
    await session.release();
  });
});

describe('failure cleanup contract', () => {
  it('destroys an owned sandbox when adapter startup fails', async () => {
    const controller = new FakeHarnessController({ failStart: new Error('typed fake startup failure') });
    const runtime = host(controller);
    const events: string[] = [];
    runtime.host.onEvent((event) => {
      events.push(event.type);
    });

    await expect(runtime.host.start()).rejects.toThrow('typed fake startup failure');
    expect(runtime.host.state).toBe('failed');
    expect(runtime.sandbox.destroyCount).toBe(1);
    expect(runtime.sandbox.live.size).toBe(0);
    expect(events).toEqual(['session.starting', 'session.failed']);
  });
});
