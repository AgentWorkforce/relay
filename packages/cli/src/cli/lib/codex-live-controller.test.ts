import { describe, expect, it, vi } from 'vitest';

import type { LiveTeleportCloudClient, LiveTeleportLifecycleStatus } from '@agent-relay/cloud';

import {
  CodexLiveController,
  type CodexControllerState,
  type CodexControllerStateStore,
  type CodexPersistedMountResumeProvider,
  type CodexWorkspaceSealHandle,
  type CodexWorkspaceSealProvider,
} from './codex-live-controller.js';
import type { CodexAppServerSession, CodexTurnResult } from './codex-app-server.js';

const source = {
  kind: 'relayfile-checkpoint-seal' as const,
  receipt: { sealId: 'seal-1', sealToken: 'opaque' },
};

function sealHandle(overrides: Partial<CodexWorkspaceSealHandle> = {}): CodexWorkspaceSealHandle {
  return {
    source,
    restore: { resumeId: 'resume-1', workspaceId: 'workspace-1', localRoot: '/repo' },
    resumeLocal: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}
const convergence = {
  verdict: 'converged' as const,
  source: {
    cursor: 'evt_10',
    manifestSha256: 'a'.repeat(64),
    files: 2,
    bytes: 20,
    conflictArtifacts: [],
    conflictDigest: 'b'.repeat(64),
    sealedAt: '2026-08-23T11:59:00.000Z',
  },
  destination: {
    cursor: 'evt_10',
    manifestSha256: 'a'.repeat(64),
    files: 2,
    bytes: 20,
    conflictArtifacts: [],
    conflictDigest: 'b'.repeat(64),
    pendingWriteback: 0 as const,
    hasPendingWriteback: false as const,
    outboxNeedsAttention: false as const,
    ephemeralPaths: [] as [],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function turnResult(turnId = 'turn-1'): CodexTurnResult {
  return { turnId, response: {}, completed: { method: 'turn/completed' } };
}

function memoryStore(initial: CodexControllerState | null = null): CodexControllerStateStore & {
  value: CodexControllerState | null;
} {
  return {
    value: initial,
    read() {
      return this.value ? structuredClone(this.value) : null;
    },
    write(state) {
      this.value = structuredClone(state);
    },
  };
}

function appServer(overrides: Partial<CodexAppServerSession> = {}): CodexAppServerSession {
  return {
    initialize: vi.fn(async () => undefined),
    startThread: vi.fn(async () => 'thread-1'),
    resumeThread: vi.fn(async () => undefined),
    addEnvironment: vi.fn(async () => undefined),
    environmentStatus: vi.fn(async () => ({ status: 'ready' })),
    runTurn: vi.fn(async () => turnResult()),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function lifecycle(
  input: { sessionId: string; generation: number },
  status: LiveTeleportLifecycleStatus['status']
): LiveTeleportLifecycleStatus {
  return { sessionId: input.sessionId, generation: input.generation, status };
}

function cloud(overrides: Partial<LiveTeleportCloudClient> = {}): LiveTeleportCloudClient {
  return {
    prewarm: vi.fn(async (input) => ({
      prewarmId: `prewarm-${input.generation}`,
      generation: input.generation,
      status: 'ready' as const,
    })),
    status: vi.fn(async (input) => lifecycle(input, 'ready')),
    acquire: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      generation: input.generation,
      environmentId: `environment-${input.generation}`,
      connectPath: `/api/v1/live-teleports/connect/${input.sessionId}/${input.generation}`,
      execServerUrl: `wss://cloud.agentrelay.test/api/v1/live-teleports/connect/${input.sessionId}/${input.generation}`,
      workspaceCwd: '/workspace',
      expiresAt: '2026-08-23T13:00:00.000Z',
      convergence,
    })),
    revoke: vi.fn(async (input) => ({ ...lifecycle(input, 'revoked'), status: 'revoked' as const })),
    ...overrides,
  };
}

function createController(
  options: {
    store?: ReturnType<typeof memoryStore>;
    cloud?: LiveTeleportCloudClient;
    sessions?: CodexAppServerSession[];
    probe?: () => Promise<void>;
    checkpointAndSeal?: CodexWorkspaceSealProvider;
    resumePersistedLocalMount?: CodexPersistedMountResumeProvider;
    lifecycleDeadlineMs?: number;
    lifecyclePollIntervalMs?: number;
  } = {}
) {
  const store = options.store ?? memoryStore();
  const cloudClient = options.cloud ?? cloud();
  const sessions = options.sessions ?? [appServer()];
  const createAppServer = vi.fn(async () => {
    const session = sessions.shift();
    if (!session) throw new Error('no app server');
    return session;
  });
  const checkpointAndSeal = vi.fn(options.checkpointAndSeal ?? (async () => sealHandle()));
  const resumePersistedLocalMount = vi.fn(options.resumePersistedLocalMount ?? (async () => undefined));
  const controller = new CodexLiveController(
    {
      workspaceRoot: '/repo',
      socketPath: '/state/controller.sock',
      ...(options.lifecycleDeadlineMs ? { lifecycleDeadlineMs: options.lifecycleDeadlineMs } : {}),
      ...(options.lifecyclePollIntervalMs
        ? { lifecyclePollIntervalMs: options.lifecyclePollIntervalMs }
        : {}),
    },
    {
      cloud: cloudClient,
      store,
      createAppServer,
      probeCapability: options.probe ?? (async () => undefined),
      checkpointAndSeal,
      resumePersistedLocalMount,
      sleep: async () => undefined,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      sessionId: () => 'session-1',
      pid: 123,
    }
  );
  return {
    controller,
    store,
    cloud: cloudClient,
    createAppServer,
    checkpointAndSeal,
    resumePersistedLocalMount,
  };
}

function persistedRemote(overrides: Partial<CodexControllerState> = {}): CodexControllerState {
  return {
    version: 1,
    sessionId: 'session-1',
    threadId: 'thread-1',
    workspaceRoot: '/repo',
    source,
    mountRestore: { resumeId: 'resume-7', workspaceId: 'workspace-1', localRoot: '/repo' },
    generation: 7,
    phase: 'remote',
    controllerPid: 99,
    socketPath: '/old.sock',
    turnActive: false,
    remote: {
      sessionId: 'session-1',
      generation: 7,
      environmentId: 'env-7',
      connectPath: '/api/v1/live-teleports/connect/session-1/7',
      execServerUrl: 'wss://cloud.agentrelay.test/api/v1/live-teleports/connect/session-1/7',
      workspaceCwd: '/workspace',
      expiresAt: '2026-08-23T13:00:00.000Z',
      attached: true,
      convergence,
    },
    updatedAt: '2026-08-23T11:00:00.000Z',
    ...overrides,
  };
}

describe('CodexLiveController', () => {
  it('fails before starting an app-server when the local experimental capability is unsupported', async () => {
    const { controller, createAppServer } = createController({
      probe: async () => {
        throw new Error('environment/status unsupported');
      },
    });

    await expect(controller.initialize()).rejects.toThrow('environment/status unsupported');
    expect(createAppServer).not.toHaveBeenCalled();
  });

  it('prewarms without stopping or sealing the active local mount', async () => {
    const cloudClient = cloud();
    const { controller, checkpointAndSeal } = createController({ cloud: cloudClient });

    await controller.initialize();

    expect(checkpointAndSeal).not.toHaveBeenCalled();
    expect(cloudClient.prewarm).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        generation: 1,
        workspaceRoot: '/',
        idempotencyKey: 'session-1:1:prewarm',
      })
    );
  });

  it('rejects stale generations and applies a mid-turn teleport only at the next boundary', async () => {
    const firstTurn = deferred<CodexTurnResult>();
    const original = appServer({
      runTurn: vi
        .fn()
        .mockImplementationOnce(() => firstTurn.promise)
        .mockResolvedValueOnce(turnResult('turn-2')),
    });
    const cloudClient = cloud();
    const { controller } = createController({ sessions: [original], cloud: cloudClient });
    await controller.initialize();

    expect(() => controller.requestTeleport({ requestId: 'stale', expectedGeneration: 0 })).toThrow(
      'Stale teleport generation'
    );
    const running = controller.runTurn('local turn');
    await vi.waitFor(() => expect(original.runTurn).toHaveBeenCalledTimes(1));
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    expect(cloudClient.acquire).not.toHaveBeenCalled();

    firstTurn.resolve(turnResult());
    await running;
    await controller.runTurn('remote turn');

    expect(original.runTurn).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-1',
      text: 'local turn',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
    expect(original.runTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      text: 'remote turn',
      execution: {
        kind: 'remote',
        environment: { environmentId: 'environment-1', cwd: '/workspace' },
      },
    });

    expect(cloudClient.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 1,
        workspaceRoot: '/',
        source,
        prewarmId: 'prewarm-1',
        idempotencyKey: 'session-1:1:acquire',
      })
    );
  });

  it('reports verifying—not remote—until the first Cloud turn completes', async () => {
    const firstRemoteTurn = deferred<CodexTurnResult>();
    const original = appServer({ runTurn: vi.fn(() => firstRemoteTurn.promise) });
    const { controller } = createController({ sessions: [original] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    const running = controller.runTurn('first remote turn');
    await vi.waitFor(() => expect(controller.status().phase).toBe('verifying'));
    expect(controller.status()).toMatchObject({ execution: 'verifying', phase: 'verifying' });
    expect(controller.status()).not.toHaveProperty('remote');

    firstRemoteTurn.resolve(turnResult());
    await running;
    expect(controller.status()).toMatchObject({ execution: 'cloud', phase: 'remote' });
    expect(controller.status().remote).toMatchObject({ attached: true, environmentId: 'environment-1' });
    expect(controller.status().remote).not.toHaveProperty('execServerUrl');
    expect(controller.status().remote).not.toHaveProperty('connectPath');
    expect(controller.status()).not.toHaveProperty('source');
    expect(controller.status()).not.toHaveProperty('mountRestore');

    await controller.runTurn('subsequent remote turn');
    expect(original.runTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      text: 'subsequent remote turn',
      execution: { kind: 'remote' },
    });
  });

  it('confirms revoke, closes the old controller, and resumes the same thread after first-turn failure', async () => {
    const original = appServer({ runTurn: vi.fn(async () => Promise.reject(new Error('remote died'))) });
    const replacement = appServer();
    const cloudClient = cloud();
    const sealed = sealHandle();
    const { controller } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('do not replay me')).rejects.toThrow('resumed locally');

    expect(cloudClient.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'session-1:1:first-turn-failed-revoke' })
    );
    expect(original.close).toHaveBeenCalled();
    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(replacement.initialize).toHaveBeenCalled();
    expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(replacement.runTurn).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ generation: 2, phase: 'local', execution: 'local' });
  });

  it('fails fenced and never resumes locally when first-turn revoke is unconfirmed', async () => {
    const original = appServer({ runTurn: vi.fn(async () => Promise.reject(new Error('remote died'))) });
    const replacement = appServer();
    const cloudClient = cloud({
      revoke: vi.fn(async () => Promise.reject(new Error('revoke timeout'))),
      status: vi.fn(async (input) => lifecycle(input, 'ready')),
    });
    const { controller, createAppServer } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('must not run locally')).rejects.toThrow('could not be confirmed');

    expect(original.close).toHaveBeenCalled();
    expect(createAppServer).toHaveBeenCalledTimes(1);
    expect(replacement.resumeThread).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'fenced', execution: 'fenced' });
  });

  it('does not trust a mount state or arbitrary receipt when no real seal provider is available', async () => {
    const seal = vi
      .fn<CodexWorkspaceSealProvider>()
      .mockRejectedValue(new Error('checkpoint-and-seal API unavailable'));
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud();
    const { controller } = createController({
      checkpointAndSeal: seal,
      sessions: [original, replacement],
      cloud: cloudClient,
    });
    await controller.initialize();
    expect(controller.status()).toMatchObject({ phase: 'local', workspaceSource: 'unavailable' });
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('local only')).rejects.toThrow('checkpoint-and-seal API unavailable');

    expect(cloudClient.acquire).not.toHaveBeenCalled();
    expect(cloudClient.revoke).toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
  });

  it('does not persist a seal whose restore identity targets another local root', async () => {
    const sealed = sealHandle({
      restore: { resumeId: 'resume-1', workspaceId: 'workspace-1', localRoot: '/other' },
    });
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud();
    const { controller, store } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('must stay on this mount')).rejects.toThrow('invalid restore identity');

    expect(cloudClient.acquire).not.toHaveBeenCalled();
    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(store.value?.source).toBeUndefined();
    expect(store.value?.mountRestore).toBeUndefined();
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
  });

  it('thaws the exact sealed mount after acquire failure before local resume', async () => {
    const sealed = sealHandle();
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud({ acquire: vi.fn(async () => Promise.reject(new Error('acquire failed'))) });
    const { controller } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('local after abort')).rejects.toThrow('acquire failed');

    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
    await controller.runTurn('second input');
    expect(replacement.runTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'second input',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
  });

  it('does not resume local execution when a fenced mount cannot be thawed', async () => {
    const sealed = sealHandle({ resumeLocal: vi.fn(async () => Promise.reject(new Error('mount dead'))) });
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud({ acquire: vi.fn(async () => Promise.reject(new Error('acquire failed'))) });
    const { controller, createAppServer } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('must stay fenced')).rejects.toThrow('could not resume');

    expect(createAppServer).toHaveBeenCalledTimes(1);
    expect(replacement.resumeThread).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'recovery_failed', execution: 'fenced' });
  });

  it('polls warming lifecycle status to ready before acquisition', async () => {
    const cloudClient = cloud({
      prewarm: vi.fn(async (input) => ({
        prewarmId: `prewarm-${input.generation}`,
        generation: input.generation,
        status: 'warming' as const,
      })),
      status: vi
        .fn()
        .mockImplementationOnce(async (input) => ({
          ...lifecycle(input, 'warming'),
          prewarmId: 'prewarm-1',
          retryAfterMs: 1,
        }))
        .mockImplementationOnce(async (input) => ({
          ...lifecycle(input, 'ready'),
          prewarmId: 'prewarm-1',
        })),
    });
    const { controller, checkpointAndSeal } = createController({ cloud: cloudClient });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await controller.runTurn('after convergence');

    expect(cloudClient.status).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cloudClient.status).mock.invocationCallOrder.at(-1)).toBeLessThan(
      checkpointAndSeal.mock.invocationCallOrder[0]!
    );
    expect(cloudClient.acquire).toHaveBeenCalled();
  });

  it('bounds non-convergence and recovers locally instead of blocking forever', async () => {
    const cloudClient = cloud({
      prewarm: vi.fn(async (input) => ({
        prewarmId: `prewarm-${input.generation}`,
        generation: input.generation,
        status: 'warming' as const,
      })),
      status: vi.fn(async (input) => ({ ...lifecycle(input, 'warming'), retryAfterMs: 1 })),
    });
    const original = appServer();
    const replacement = appServer();
    const { controller } = createController({
      cloud: cloudClient,
      sessions: [original, replacement],
      lifecycleDeadlineMs: 5,
      lifecyclePollIntervalMs: 1,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('bounded')).rejects.toThrow('did not converge');

    expect(cloudClient.acquire).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
  });

  it('polls Codex environment/status until ready', async () => {
    const original = appServer({
      environmentStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: 'connecting' })
        .mockResolvedValueOnce({ status: 'ready' }),
    });
    const { controller } = createController({ sessions: [original] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await controller.runTurn('ready after poll');

    expect(original.environmentStatus).toHaveBeenCalledTimes(2);
  });

  it('rolls back only after a confirmed fence and resumes through a fresh app-server', async () => {
    const original = appServer();
    const replacement = appServer();
    const sealed = sealHandle();
    const { controller } = createController({
      sessions: [original, replacement],
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote');

    const status = await controller.rollback();

    expect(original.close).toHaveBeenCalled();
    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(status).toMatchObject({ phase: 'local', generation: 2, execution: 'local' });
  });

  it('persists fenced on restart and never constructs a local app-server after unconfirmed revoke', async () => {
    const persisted = persistedRemote();
    persisted.remote!.expiresAt = '2026-08-23T11:00:00.000Z';
    const store = memoryStore(persisted);
    const cloudClient = cloud({
      revoke: vi.fn(async () => Promise.reject(new Error('timeout'))),
      status: vi.fn(async (input) => lifecycle(input, 'ready')),
    });
    const { controller, createAppServer } = createController({ store, cloud: cloudClient });

    await expect(controller.initialize()).rejects.toThrow('could not confirm Cloud fencing');

    expect(createAppServer).not.toHaveBeenCalled();
    expect(store.value).toMatchObject({ phase: 'fenced', generation: 7 });
  });

  it('resumes locally only after Cloud authoritatively confirms the persisted lease expired', async () => {
    const expired = persistedRemote({
      remote: { ...persistedRemote().remote!, expiresAt: '2026-08-23T11:59:59.000Z' },
    });
    const store = memoryStore(expired);
    const resumed = appServer();
    const cloudClient = cloud({
      revoke: vi.fn(async (input) => ({ ...lifecycle(input, 'expired'), status: 'expired' as const })),
    });
    const { controller, resumePersistedLocalMount } = createController({
      store,
      sessions: [resumed],
      cloud: cloudClient,
    });

    await expect(controller.initialize()).resolves.toMatchObject({
      phase: 'local',
      generation: 8,
      threadId: 'thread-1',
    });

    expect(cloudClient.revoke).toHaveBeenCalled();
    expect(resumePersistedLocalMount).toHaveBeenCalledWith(expect.objectContaining({ source }));
    expect(resumed.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(store.value?.source).toBeUndefined();
    expect(store.value?.mountRestore).toBeUndefined();
  });

  it('fails recovery if the same thread cannot be resumed after a confirmed fence', async () => {
    const store = memoryStore(persistedRemote());
    const resumed = appServer({ resumeThread: vi.fn(async () => Promise.reject(new Error('gone'))) });
    const { controller } = createController({ store, sessions: [resumed] });

    await expect(controller.initialize()).rejects.toThrow('Could not resume Codex thread thread-1');

    expect(store.value).toMatchObject({ phase: 'recovery_failed', generation: 7 });
  });

  it('does not adopt a persisted thread from a different workspace', async () => {
    const store = memoryStore(persistedRemote({ workspaceRoot: '/different-repo' }));
    const { controller, createAppServer } = createController({ store });

    await expect(controller.initialize()).rejects.toThrow('belongs to /different-repo');
    expect(createAppServer).not.toHaveBeenCalled();
  });

  it('marks shutdown fenced when revoke cannot be confirmed', async () => {
    const original = appServer();
    const cloudClient = cloud({
      revoke: vi.fn(async () => Promise.reject(new Error('timeout'))),
      status: vi.fn(async (input) => lifecycle(input, 'ready')),
    });
    const { controller } = createController({ sessions: [original], cloud: cloudClient });
    await controller.initialize();

    await controller.close();

    expect(original.close).toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'fenced', execution: 'fenced' });
  });

  it('resumes and verifies the sealed local mount on ordinary shutdown after remote execution', async () => {
    const sealed = sealHandle();
    const original = appServer();
    const { controller } = createController({
      sessions: [original],
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote turn');

    await controller.close();

    expect(original.close).toHaveBeenCalled();
    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(sealed.close).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2, execution: 'local' });
  });
});
