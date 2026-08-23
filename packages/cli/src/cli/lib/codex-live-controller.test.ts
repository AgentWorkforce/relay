import { describe, expect, it, vi } from 'vitest';

import type { LiveTeleportCloudClient } from '@agent-relay/cloud';

import {
  CodexLiveController,
  type CodexControllerState,
  type CodexControllerStateStore,
} from './codex-live-controller.js';
import type { CodexAppServerSession } from './codex-app-server.js';

const source = { kind: 'relayfile-mount' as const, mountStatePath: '/repo/.relayfile-mount-state.json' };
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
    runTurn: vi.fn(async () => ({
      turnId: 'turn-1',
      response: {},
      completed: { method: 'turn/completed' },
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function cloud(overrides: Partial<LiveTeleportCloudClient> = {}): LiveTeleportCloudClient {
  return {
    prewarm: vi.fn(async (input) => ({
      prewarmId: `prewarm-${input.generation}`,
      generation: input.generation,
      status: 'ready' as const,
    })),
    acquire: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      generation: input.generation,
      environmentId: `environment-${input.generation}`,
      execServerUrl: 'wss://exec.agentrelay.test/ticket',
      workspaceCwd: '/workspace',
      expiresAt: '2026-08-23T13:00:00.000Z',
      convergence,
    })),
    revoke: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createController(
  options: {
    store?: ReturnType<typeof memoryStore>;
    cloud?: LiveTeleportCloudClient;
    sessions?: CodexAppServerSession[];
    probe?: () => Promise<void>;
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
  const controller = new CodexLiveController(
    { workspaceRoot: '/repo', source, socketPath: '/state/controller.sock' },
    {
      cloud: cloudClient,
      store,
      createAppServer,
      probeCapability: options.probe ?? (async () => undefined),
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      sessionId: () => 'session-1',
      pid: 123,
    }
  );
  return { controller, store, cloud: cloudClient, createAppServer };
}

describe('CodexLiveController', () => {
  it('fails closed before starting an app-server when the local experimental capability is unsupported', async () => {
    const { controller, createAppServer } = createController({
      probe: async () => {
        throw new Error('environment/status unsupported');
      },
    });

    await expect(controller.initialize()).rejects.toThrow('environment/status unsupported');
    expect(createAppServer).not.toHaveBeenCalled();
  });

  it('rejects a stale generation and makes duplicate request ids idempotent', async () => {
    const { controller } = createController();
    await controller.initialize();

    expect(() => controller.requestTeleport({ requestId: 'request-stale', expectedGeneration: 0 })).toThrow(
      'Stale teleport generation'
    );
    const first = controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    const duplicate = controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    expect(first.phase).toBe('teleport_pending');
    expect(duplicate.pending?.requestId).toBe('request-1');
  });

  it('queues a mid-turn request and applies it only at the following turn boundary', async () => {
    const firstTurn = deferred<{
      turnId: string;
      response: object;
      completed: { method: string };
    }>();
    const session = appServer({
      runTurn: vi
        .fn()
        .mockImplementationOnce(() => firstTurn.promise)
        .mockResolvedValueOnce({ turnId: 'turn-2', response: {}, completed: { method: 'turn/completed' } }),
    });
    const cloudClient = cloud();
    const { controller } = createController({ sessions: [session], cloud: cloudClient });
    await controller.initialize();

    const running = controller.runTurn('local turn');
    await vi.waitFor(() => expect(session.runTurn).toHaveBeenCalledTimes(1));
    const queued = controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    expect(queued.turnActive).toBe(true);
    expect(queued.phase).toBe('teleport_pending');
    expect(cloudClient.acquire).not.toHaveBeenCalled();

    firstTurn.resolve({ turnId: 'turn-1', response: {}, completed: { method: 'turn/completed' } });
    await running;
    expect(cloudClient.acquire).not.toHaveBeenCalled();

    await controller.runTurn('remote turn');
    expect(cloudClient.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        threadId: 'thread-1',
        generation: 1,
        source,
        prewarmId: 'prewarm-1',
        idempotencyKey: 'session-1:1:acquire',
      })
    );
    expect(vi.mocked(session.addEnvironment).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(session.runTurn).mock.invocationCallOrder[1]!
    );
    expect(session.runTurn).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      text: 'remote turn',
      environment: { environmentId: 'environment-1', cwd: '/workspace' },
    });
  });

  it('keeps execution local when Cloud acquisition fails before turn/start', async () => {
    const session = appServer();
    const cloudClient = cloud({ acquire: vi.fn(async () => Promise.reject(new Error('Cloud unavailable'))) });
    const { controller } = createController({ sessions: [session], cloud: cloudClient });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('must not run remotely')).rejects.toThrow('execution remains local');
    expect(session.addEnvironment).not.toHaveBeenCalled();
    expect(session.runTurn).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ execution: 'local', phase: 'local', turnActive: false });
    expect(cloudClient.revoke).toHaveBeenCalled();
  });

  it('rejects a stale generation returned by Cloud', async () => {
    const session = appServer();
    const cloudClient = cloud({
      acquire: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        generation: input.generation + 1,
        environmentId: 'stale',
        execServerUrl: 'wss://exec.agentrelay.test/stale',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T13:00:00.000Z',
        convergence,
      })),
    });
    const { controller } = createController({ sessions: [session], cloud: cloudClient });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('no cross-generation execution')).rejects.toThrow(
      'stale or cross-session'
    );
    expect(session.addEnvironment).not.toHaveBeenCalled();
  });

  it('revokes and stays local when Codex cannot verify the environment ready', async () => {
    const session = appServer({
      environmentStatus: vi.fn(async () => ({ status: 'connecting' })),
    });
    const cloudClient = cloud();
    const { controller } = createController({ sessions: [session], cloud: cloudClient });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('must stay local')).rejects.toThrow(
      'did not report the Cloud execution environment ready'
    );
    expect(session.runTurn).not.toHaveBeenCalled();
    expect(cloudClient.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'session-1:1:failed-acquire-revoke' })
    );
    expect(controller.status()).toMatchObject({ phase: 'local', execution: 'local' });
  });

  it('uses Codex stickiness after explicitly attaching the first remote turn', async () => {
    const session = appServer();
    const { controller } = createController({ sessions: [session] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await controller.runTurn('first remote turn');
    await controller.runTurn('sticky remote turn');

    expect(session.runTurn).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-1',
      text: 'first remote turn',
      environment: { environmentId: 'environment-1', cwd: '/workspace' },
    });
    expect(session.runTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      text: 'sticky remote turn',
    });
    expect(controller.status().remote).not.toHaveProperty('execServerUrl');
  });

  it('rolls back by restarting, initializing, and resuming the same thread locally', async () => {
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud();
    const { controller } = createController({ sessions: [original, replacement], cloud: cloudClient });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote turn');

    const status = await controller.rollback();

    expect(original.close).toHaveBeenCalled();
    expect(replacement.initialize).toHaveBeenCalled();
    expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(status).toMatchObject({ generation: 2, phase: 'local', execution: 'local' });
    await controller.runTurn('local again');
    expect(replacement.runTurn).toHaveBeenCalledWith({ threadId: 'thread-1', text: 'local again' });
  });

  it('fails closed if rollback cannot resume the same thread', async () => {
    const original = appServer();
    const replacement = appServer({
      resumeThread: vi.fn(async () => Promise.reject(new Error('thread missing'))),
    });
    const { controller } = createController({ sessions: [original, replacement] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote turn');

    await expect(controller.rollback()).rejects.toThrow('Could not resume Codex thread thread-1');
    expect(controller.status()).toMatchObject({ phase: 'recovery_failed', execution: 'local' });
    await expect(controller.runTurn('must not continue')).rejects.toThrow('recovery_failed');
  });

  it('recovers persisted remote state locally on controller restart', async () => {
    const store = memoryStore({
      version: 1,
      sessionId: 'session-1',
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      source,
      generation: 7,
      phase: 'remote',
      controllerPid: 99,
      socketPath: '/old.sock',
      turnActive: false,
      remote: {
        sessionId: 'session-1',
        generation: 7,
        environmentId: 'env-7',
        execServerUrl: 'wss://exec.agentrelay.test/old',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T13:00:00.000Z',
        attached: true,
        convergence,
      },
      updatedAt: '2026-08-23T11:00:00.000Z',
    });
    const resumed = appServer();
    const cloudClient = cloud();
    const { controller } = createController({ store, sessions: [resumed], cloud: cloudClient });

    await expect(controller.initialize()).resolves.toMatchObject({
      generation: 8,
      phase: 'local',
      execution: 'local',
      threadId: 'thread-1',
    });
    expect(cloudClient.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', generation: 7 })
    );
    expect(resumed.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
  });

  it('persists recovery_failed when restart cannot resume the thread', async () => {
    const store = memoryStore({
      version: 1,
      sessionId: 'session-1',
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      source,
      generation: 7,
      phase: 'local',
      controllerPid: 99,
      socketPath: '/old.sock',
      turnActive: false,
      updatedAt: '2026-08-23T11:00:00.000Z',
    });
    const resumed = appServer({ resumeThread: vi.fn(async () => Promise.reject(new Error('gone'))) });
    const { controller } = createController({ store, sessions: [resumed] });

    await expect(controller.initialize()).rejects.toThrow('Could not resume Codex thread thread-1');
    expect(store.value).toMatchObject({ phase: 'recovery_failed', generation: 7 });
  });

  it('does not adopt a persisted thread from a different workspace', async () => {
    const store = memoryStore({
      version: 1,
      sessionId: 'session-1',
      threadId: 'thread-other',
      workspaceRoot: '/different-repo',
      source,
      generation: 3,
      phase: 'local',
      controllerPid: 99,
      socketPath: '/old.sock',
      turnActive: false,
      updatedAt: '2026-08-23T11:00:00.000Z',
    });
    const session = appServer();
    const { controller, createAppServer } = createController({ store, sessions: [session] });

    await expect(controller.initialize()).rejects.toThrow('belongs to /different-repo');
    expect(createAppServer).not.toHaveBeenCalled();
  });

  it('revokes the exact generation on shutdown so prewarms and remote boxes cannot leak', async () => {
    const session = appServer();
    const cloudClient = cloud();
    const { controller } = createController({ sessions: [session], cloud: cloudClient });
    await controller.initialize();

    await controller.close();

    expect(cloudClient.revoke).toHaveBeenCalledWith({
      sessionId: 'session-1',
      generation: 1,
      idempotencyKey: 'session-1:1:shutdown-revoke',
    });
    expect(session.close).toHaveBeenCalled();
  });
});
