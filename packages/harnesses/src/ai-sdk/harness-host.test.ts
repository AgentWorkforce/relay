import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {
  HarnessV1,
  HarnessV1ContinueTurnState,
  HarnessV1PromptControl,
  HarnessV1ResumeSessionState,
  HarnessV1Session,
  HarnessV1StreamPart,
} from '@ai-sdk/harness';
import { describe, expect, it, vi } from 'vitest';
import { HarnessHost } from './harness-host.js';
import { LocalHostSandboxProvider } from './local-host-sandbox.js';

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function fakeHost() {
  const root = await mkdtemp(resolve(tmpdir(), 'relay-host-'));
  const turns: Array<{
    prompt: unknown;
    emit: (part: HarnessV1StreamPart) => void;
    done: ReturnType<typeof deferred>;
    submitUserMessage: ReturnType<typeof vi.fn>;
  }> = [];
  const resumeState: HarnessV1ResumeSessionState = {
    type: 'resume-session',
    harnessId: 'fake',
    specificationVersion: 'harness-v1',
    data: {},
  };
  const continueState: HarnessV1ContinueTurnState = {
    type: 'continue-turn',
    harnessId: 'fake',
    specificationVersion: 'harness-v1',
    data: {},
  };
  const session: HarnessV1Session = {
    sessionId: 'session',
    isResume: false,
    doPromptTurn: vi.fn((options) => {
      const done = deferred();
      const submitUserMessage = vi.fn(async () => undefined);
      turns.push({ prompt: options.prompt, emit: options.emit, done, submitUserMessage });
      return Promise.resolve({
        done: done.promise,
        submitUserMessage,
        submitToolResult: vi.fn(async () => undefined),
        submitToolApproval: vi.fn(async () => undefined),
      } satisfies HarnessV1PromptControl);
    }),
    doContinueTurn: vi.fn(() => {
      const done = deferred();
      return Promise.resolve({ done: done.promise, submitToolResult: vi.fn() });
    }),
    doCompact: vi.fn(async () => undefined),
    doSuspendTurn: vi.fn(async () => continueState),
    doDetach: vi.fn(async () => resumeState),
    doStop: vi.fn(async () => resumeState),
    doDestroy: vi.fn(async () => undefined),
  };
  const harness: HarnessV1 = {
    specificationVersion: 'harness-v1',
    harnessId: 'fake',
    builtinTools: {},
    doStart: vi.fn(async () => session),
  };
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const host = new HarnessHost({
    harness,
    sandboxProvider: new LocalHostSandboxProvider({
      workspace: resolve(root, 'workspace'),
      runtimeRoot: resolve(root, 'runtime'),
      gracefulShutdownMs: 10,
    }),
    workspace: resolve(root, 'workspace'),
    sessionId: 'session',
    onEvent: (event) => events.push(event),
  });
  return { host, harness, session, turns, events };
}

describe('HarnessHost', () => {
  it('starts, retains active control, normalizes stream parts, and settles', async () => {
    const { host, turns, events } = await fakeHost();
    await host.start();
    const turn = await host.startTurn('hello', 'turn-1');
    expect(host.hasActiveTurn).toBe(true);
    turns[0].emit({ type: 'text-start', id: 'text-1' });
    turns[0].emit({ type: 'text-delta', id: 'text-1', delta: 'hi' });
    turns[0].emit({ type: 'text-end', id: 'text-1' });
    turns[0].emit({
      type: 'finish',
      finishReason: { unified: 'stop' },
      totalUsage: { inputTokens: {}, outputTokens: {} },
    });
    await host.submitUserMessage('more');
    expect(turns[0].submitUserMessage).toHaveBeenCalledWith('more');
    turns[0].done.resolve();
    await turn.done;
    expect(host.state).toBe('ready');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'session.starting',
        'session.started',
        'turn.started',
        'text.delta',
        'turn.finished',
        'turn.settled',
      ])
    );
    const sequences = events.map((event) => (event.observability as { sequence: number }).sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    await host.destroy();
  });

  it('rejects overlapping turns and does not let stale completion clear a suspended generation', async () => {
    const { host, turns } = await fakeHost();
    await host.start();
    await host.startTurn('one', 'turn-1');
    await expect(host.startTurn('two')).rejects.toThrow(/running/);
    const continuation = await host.suspend();
    turns[0].done.resolve();
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(host.state).toBe('suspended');
    expect(continuation.type).toBe('continue-turn');
    await host.destroy();
  });

  it('serializes lifecycle methods and makes destroy idempotent', async () => {
    const { host, session } = await fakeHost();
    await host.start();
    await host.compact('short');
    expect(session.doCompact).toHaveBeenCalledWith('short');
    await Promise.all([host.destroy(), host.destroy()]);
    expect(session.doDestroy).toHaveBeenCalledTimes(1);
    expect(host.state).toBe('destroyed');
  });

  it('retries a typed bridge bind collision with a freshly reserved port', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'relay-host-port-retry-'));
    const ports: number[] = [];
    const session: HarnessV1Session = {
      sessionId: 'retry-session',
      isResume: false,
      doPromptTurn: vi.fn(),
      doDestroy: vi.fn(async () => undefined),
    };
    const harness: HarnessV1 = {
      specificationVersion: 'harness-v1',
      harnessId: 'retry',
      builtinTools: {},
      doStart: vi.fn(async ({ sandboxSession }) => {
        ports.push(sandboxSession.ports[0]);
        if (ports.length === 1) throw new Error('listen EADDRINUSE: address already in use');
        return session;
      }),
    };
    const host = new HarnessHost({
      harness,
      sandboxProvider: new LocalHostSandboxProvider({
        workspace: resolve(root, 'workspace'),
        runtimeRoot: resolve(root, 'runtime'),
      }),
      workspace: resolve(root, 'workspace'),
      sessionId: 'retry-session',
      portBindRetries: 2,
    });
    await host.start();
    expect(ports).toHaveLength(2);
    expect(ports[0]).not.toBe(ports[1]);
    await host.destroy();
  });
});
