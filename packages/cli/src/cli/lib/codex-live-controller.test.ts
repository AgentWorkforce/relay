import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LiveTeleportCloudClient, LiveTeleportLifecycleStatus } from '@agent-relay/cloud';

import {
  CodexLiveController,
  FileCodexControllerStateStore,
  type CodexControllerState,
  type CodexControllerStateStore,
  type CodexPersistedMountResumeProvider,
  type CodexWorkspaceSealHandle,
  type CodexWorkspaceSealProvider,
} from './codex-live-controller.js';
import type { CodexAppServerSession, CodexTurnResult } from './codex-app-server.js';
import { CodexAppServerTurnTerminalError } from './codex-app-server.js';

const source = {
  kind: 'relayfile-checkpoint-seal' as const,
  receipt: {
    sealId: 'seal-1',
    sealToken: 'opaque',
    workspaceId: 'workspace-1',
    root: '/',
    sessionId: 'session-1',
    generation: 1,
    digest: `sha256:${'a'.repeat(64)}`,
    workspaceRevision: 'rev_10',
    eventCursor: 'evt_10',
  },
};

function sealHandle(overrides: Partial<CodexWorkspaceSealHandle> = {}): CodexWorkspaceSealHandle {
  return {
    source,
    restore: {
      lifecycleId: 'session-1:1:operation-1',
      resumeId: 'resume-1',
      workspaceId: 'workspace-1',
      localRoot: '/repo',
    },
    resumeLocal: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}
const verification = {
  version: 1 as const,
  kind: 'relayfile-destination-verification' as const,
  verificationId: 'verify-1',
  workspaceId: 'workspace-1',
  localRoot: '/workspace',
  remoteRoot: '/' as const,
  sessionId: 'session-1',
  generation: 1,
  status: 'converged' as const,
  observed: {
    digest: `sha256:${'a'.repeat(64)}`,
    workspaceRevision: 'rev_10',
    eventCursor: 'evt_10',
  },
  health: {
    pendingWriteback: 0 as const,
    conflicts: 0 as const,
    outboxPending: 0 as const,
    outboxNeedsAttention: false as const,
  },
  verifiedAt: '2026-08-23T11:59:00.000Z',
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
  const turn = {
    id: turnId,
    status: 'completed',
    itemsView: 'full',
    items: [{ id: `answer-${turnId}`, type: 'agentMessage', text: `answer for ${turnId}` }],
  };
  return {
    turnId,
    response: { turn },
    completed: { method: 'turn/completed', params: { threadId: 'thread-1', turn } },
  };
}

function completedOutcome(
  turnId: string,
  answer = `answer for ${turnId}`,
  clientUserMessageId = 'client-persisted-1'
) {
  const turn = {
    id: turnId,
    status: 'completed',
    itemsView: 'full',
    items: [
      { id: `user-${turnId}`, type: 'userMessage', clientId: clientUserMessageId, text: 'prompt' },
      { id: `answer-${turnId}`, type: 'agentMessage', text: answer },
    ],
  };
  return {
    status: 'completed' as const,
    turnId,
    result: {
      turnId,
      response: { turn },
      completed: { method: 'turn/completed', params: { threadId: 'thread-1', turn } },
      reconciled: true as const,
    },
  };
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

function fileStore(filePath: string, initial: CodexControllerState) {
  const durable = new FileCodexControllerStateStore(filePath);
  durable.write(initial);
  return {
    value: structuredClone(initial) as CodexControllerState | null,
    read() {
      this.value = durable.read();
      return this.value ? structuredClone(this.value) : null;
    },
    write(state: CodexControllerState) {
      durable.write(state);
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
    turnOutcome: vi.fn(async () => ({ status: 'absent' as const })),
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
      sessionId: input.sessionId,
      prewarmId: `prewarm-${input.generation}`,
      generation: input.generation,
      status: 'ready' as const,
      expiresAt: '2026-08-23T12:30:00.000Z',
    })),
    status: vi.fn(async (input) => ({
      ...lifecycle(input, 'active'),
      leaseExpiresAt: '2026-08-23T13:00:00.000Z',
    })),
    acquire: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      generation: input.generation,
      environmentId: `environment-${input.generation}`,
      connectPath: `/api/v1/live-teleports/connect/${input.sessionId}/${input.generation}`,
      execServerUrl: `wss://cloud.agentrelay.test/api/v1/live-teleports/connect/${input.sessionId}/${input.generation}`,
      workspaceCwd: '/workspace',
      connectExpiresAt: '2026-08-23T12:05:00.000Z',
      leaseExpiresAt: '2026-08-23T13:00:00.000Z',
      verification: { ...verification, generation: input.generation, sessionId: input.sessionId },
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
    now?: () => Date;
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
  const checkpointAndSeal = vi.fn(
    options.checkpointAndSeal ??
      (async (input) =>
        sealHandle({
          restore: {
            lifecycleId: input.lifecycleId,
            resumeId: 'resume-1',
            workspaceId: 'workspace-1',
            localRoot: '/repo',
          },
        }))
  );
  const resumePersistedLocalMount = vi.fn(options.resumePersistedLocalMount ?? (async () => undefined));
  let operation = 0;
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
      now: options.now ?? (() => new Date('2026-08-23T12:00:00.000Z')),
      sessionId: () => 'session-1',
      operationId: () => `operation-${++operation}`,
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
    source: { kind: source.kind },
    mountRestore: {
      lifecycleId: 'session-1:7:operation-7',
      resumeId: 'resume-7',
      workspaceId: 'workspace-1',
      localRoot: '/repo',
    },
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
      connectExpiresAt: '2026-08-23T12:05:00.000Z',
      leaseExpiresAt: '2026-08-23T13:00:00.000Z',
      attached: true,
      verification: { ...verification, generation: 7 },
    },
    updatedAt: '2026-08-23T11:00:00.000Z',
    ...overrides,
  };
}

function persistedRemoteForFile(overrides: Partial<CodexControllerState> = {}): CodexControllerState {
  const persisted = persistedRemote(overrides);
  if (persisted.remote) {
    const remote = persisted.remote as typeof persisted.remote & Record<string, unknown>;
    delete remote.connectPath;
    delete remote.execServerUrl;
  }
  return persisted;
}

function persistedLocal(overrides: Partial<CodexControllerState> = {}): CodexControllerState {
  return {
    version: 1,
    sessionId: 'session-1',
    threadId: 'thread-1',
    workspaceRoot: '/repo',
    generation: 3,
    phase: 'local',
    cloudLifecycle: 'none',
    controllerPid: 99,
    socketPath: '/old.sock',
    turnActive: false,
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

  it('does not block local initialization on a stalled background prewarm', async () => {
    const pendingPrewarm = deferred<{
      sessionId: string;
      prewarmId: string;
      generation: number;
      status: 'ready';
      expiresAt: string;
    }>();
    const cloudClient = cloud({ prewarm: vi.fn(() => pendingPrewarm.promise) });
    const { controller } = createController({ cloud: cloudClient });

    await expect(controller.initialize()).resolves.toMatchObject({ phase: 'local' });
    pendingPrewarm.resolve({
      sessionId: 'session-1',
      prewarmId: 'prewarm-1',
      generation: 1,
      status: 'ready',
      expiresAt: '2026-08-23T12:30:00.000Z',
    });
    await vi.waitFor(() => expect(controller.status().prewarmStatus).toBe('ready'));
  });

  it('retains durable Cloud ownership intent when a prewarm response is lost', async () => {
    const cloudClient = cloud({
      prewarm: vi.fn(async () => Promise.reject(new Error('response lost'))),
    });
    const { controller, store } = createController({ cloud: cloudClient });

    await controller.initialize();
    await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('failed'));

    expect(store.value).toMatchObject({ cloudLifecycle: 'prewarm_requested' });
  });

  it('cleans up a failed no-row prewarm through Cloud idempotent terminal revoke', async () => {
    const cloudClient = cloud({
      prewarm: vi.fn(async () => Promise.reject(new Error('feature disabled'))),
    });
    const { controller, store } = createController({ cloud: cloudClient });
    await controller.initialize();
    await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('failed'));

    await controller.close();

    expect(cloudClient.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'session-1:1:revoke' })
    );
    expect(cloudClient.status).not.toHaveBeenCalled();
    expect(store.value).toMatchObject({ cloudLifecycle: 'none', generation: 2 });
  });

  it('advances prewarm identity after graceful fence before close → initialize → teleport', async () => {
    const store = memoryStore();
    const cloudClient = cloud();
    const first = createController({ store, cloud: cloudClient, sessions: [appServer()] });
    await first.controller.initialize();
    await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));

    await first.controller.close();

    expect(store.value).toMatchObject({ generation: 2, cloudLifecycle: 'none', phase: 'local' });
    expect(cloudClient.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1, idempotencyKey: 'session-1:1:revoke' })
    );

    const resumed = appServer();
    const second = createController({ store, cloud: cloudClient, sessions: [resumed] });
    await second.controller.initialize();
    second.controller.requestTeleport({ requestId: 'request-generation-2', expectedGeneration: 2 });
    await second.controller.runTurn('fresh identity');

    expect(cloudClient.prewarm).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2, idempotencyKey: 'session-1:2:prewarm' })
    );
    expect(cloudClient.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2, idempotencyKey: 'session-1:2:acquire' })
    );
    expect(resumed.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'fresh identity',
        execution: expect.objectContaining({ kind: 'remote' }),
      })
    );
  });

  it('atomically finalizes a pending teleport when close consumes its prewarm generation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-controller-close-pending-'));
    const fileStore = new FileCodexControllerStateStore(path.join(directory, 'state.json'));
    const store = {
      value: null as CodexControllerState | null,
      read() {
        this.value = fileStore.read();
        return this.value;
      },
      write(state: CodexControllerState) {
        fileStore.write(state);
        this.value = structuredClone(state);
      },
    };
    try {
      const cloudClient = cloud();
      const first = createController({ store, cloud: cloudClient, sessions: [appServer()] });
      await first.controller.initialize();
      await vi.waitFor(() => expect(fileStore.read()?.prewarmStatus).toBe('ready'));
      first.controller.requestTeleport({ requestId: 'request-consumed-on-close', expectedGeneration: 1 });

      await first.controller.close();

      expect(fileStore.read()).toMatchObject({
        generation: 2,
        phase: 'local',
        cloudLifecycle: 'none',
        lastRequestId: 'request-consumed-on-close',
      });
      expect(fileStore.read()?.pending).toBeUndefined();

      const second = createController({ store, cloud: cloudClient, sessions: [appServer()] });
      await expect(second.controller.initialize()).resolves.toMatchObject({
        generation: 2,
        phase: 'local',
      });
      await vi.waitFor(() => expect(fileStore.read()?.prewarmStatus).toBe('ready'));
      await second.controller.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists checkpoint lifecycle intent before Relayfile can stop the mount', async () => {
    const checkpoint = deferred<CodexWorkspaceSealHandle>();
    let lifecycleId = '';
    const { controller, store } = createController({
      checkpointAndSeal: async (input) => {
        lifecycleId = input.lifecycleId;
        return checkpoint.promise;
      },
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    const running = controller.runTurn('boundary turn');
    await vi.waitFor(() => expect(lifecycleId).not.toBe(''));
    expect(store.value?.mountRestore).toEqual({ lifecycleId, localRoot: '/repo' });
    expect(store.value?.source).toBeUndefined();
    checkpoint.resolve(
      sealHandle({
        restore: {
          lifecycleId,
          resumeId: 'resume-1',
          workspaceId: 'workspace-1',
          localRoot: '/repo',
        },
      })
    );
    await running;
  });

  it('waits for aborted checkpoint cleanup to settle before starting local recovery', async () => {
    const cleanup = deferred<CodexWorkspaceSealHandle>();
    const aborted = deferred<void>();
    const original = appServer();
    const replacement = appServer();
    const { controller } = createController({
      sessions: [original, replacement],
      lifecycleDeadlineMs: 5,
      checkpointAndSeal: async (input) => {
        input.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        return cleanup.promise;
      },
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    const running = controller.runTurn('deadline');
    await aborted.promise;
    expect(original.close).not.toHaveBeenCalled();

    cleanup.reject(Object.assign(new Error('checkpoint aborted and source ready'), { name: 'AbortError' }));
    await expect(running).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(original.close).toHaveBeenCalled();
    expect(replacement.resumeThread).toHaveBeenCalled();
    expect(replacement.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'deadline', execution: { kind: 'local', workspaceRoot: '/repo' } })
    );
  });

  it('fences without inverse effects when checkpoint ignores abort and never settles', async () => {
    const original = appServer();
    const sealed = sealHandle();
    const { controller } = createController({
      sessions: [original],
      lifecycleDeadlineMs: 5,
      checkpointAndSeal: async () => new Promise<CodexWorkspaceSealHandle>(() => undefined),
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('unknown checkpoint')).rejects.toThrow('lifecycle outcome is unknown');

    expect(original.close).not.toHaveBeenCalled();
    expect(sealed.resumeLocal).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({
      phase: 'fenced',
      lastError: 'LIFECYCLE_EFFECT_OUTCOME_UNKNOWN',
    });
    await expect(controller.runTurn('must remain blocked')).rejects.toThrow('controller is fenced');
  });

  it('fences without resuming the source when Cloud acquire never settles', async () => {
    const original = appServer();
    const sealed = sealHandle();
    const cloudClient = cloud({
      acquire: vi.fn(async () => new Promise<never>(() => undefined)),
    });
    const { controller } = createController({
      sessions: [original],
      cloud: cloudClient,
      lifecycleDeadlineMs: 5,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('unknown acquire')).rejects.toThrow('lifecycle outcome is unknown');

    expect(sealed.resumeLocal).not.toHaveBeenCalled();
    expect(original.close).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'fenced' });
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
      clientUserMessageId: 'operation-1',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
    expect(original.runTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      text: 'remote turn',
      clientUserMessageId: 'operation-3',
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
    const { controller, store } = createController({ sessions: [original] });
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
    expect(store.value?.source).toEqual({ kind: 'relayfile-checkpoint-seal' });
    expect(JSON.stringify(store.value)).not.toMatch(/opaque|ticket=|wss:\/\//);

    await controller.runTurn('subsequent remote turn');
    expect(original.runTurn).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      text: 'subsequent remote turn',
      clientUserMessageId: 'operation-3',
      execution: { kind: 'remote' },
    });
  });

  it.each(['failed', 'interrupted'] as const)(
    'surfaces a normal turn/completed %s terminal and keeps it recorded',
    async (terminalStatus) => {
      const completed = {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-terminal', status: terminalStatus, items: [] },
        },
      };
      const original = appServer({
        runTurn: vi.fn(async () => {
          throw new CodexAppServerTurnTerminalError(terminalStatus, 'turn-terminal', completed);
        }),
      });
      const { controller, store } = createController({ sessions: [original] });
      await controller.initialize();

      await expect(controller.runTurn('terminal prompt')).rejects.toMatchObject({
        name: 'CodexTurnRecordedError',
        status: terminalStatus,
      });

      expect(store.value?.inFlightTurn).toBeUndefined();
      expect(controller.status()).toMatchObject({
        phase: 'local',
        lastError: `TURN_${terminalStatus.toUpperCase()}`,
      });
    }
  );

  it('admits an acquired lease at the exact 40-minute turn horizon', async () => {
    const cloudClient = cloud({
      acquire: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        generation: input.generation,
        environmentId: 'environment-boundary',
        connectPath: '/api/v1/live-teleports/connect/boundary',
        execServerUrl: 'wss://cloud.agentrelay.test/api/v1/live-teleports/connect/boundary',
        workspaceCwd: '/workspace',
        connectExpiresAt: '2026-08-23T12:05:00.000Z',
        leaseExpiresAt: '2026-08-23T12:40:00.000Z',
        verification: { ...verification, generation: input.generation },
      })),
    });
    const original = appServer();
    const { controller } = createController({ cloud: cloudClient, sessions: [original] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-boundary', expectedGeneration: 1 });

    await expect(controller.runTurn('boundary lease')).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(original.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ execution: expect.objectContaining({ kind: 'remote' }) })
    );
  });

  it('fences a short acquired lease and transparently submits the same prompt locally', async () => {
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud({
      acquire: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        generation: input.generation,
        environmentId: 'environment-short',
        connectPath: '/api/v1/live-teleports/connect/short',
        execServerUrl: 'wss://cloud.agentrelay.test/api/v1/live-teleports/connect/short',
        workspaceCwd: '/workspace',
        connectExpiresAt: '2026-08-23T12:05:00.000Z',
        leaseExpiresAt: '2026-08-23T12:39:59.999Z',
        verification: { ...verification, generation: input.generation },
      })),
    });
    const { controller } = createController({
      cloud: cloudClient,
      sessions: [original, replacement],
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-short', expectedGeneration: 1 });

    await expect(controller.runTurn('preserve this prompt')).resolves.toMatchObject({ turnId: 'turn-1' });
    expect(cloudClient.revoke).toHaveBeenCalled();
    expect(replacement.runTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'preserve this prompt',
      clientUserMessageId: 'operation-2',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
  });

  it('persists a newer active lease only after same-generation 40-minute preflight renewal', async () => {
    let now = new Date('2026-08-23T12:00:00.000Z');
    const original = appServer();
    const cloudClient = cloud({
      status: vi.fn(async (input) => ({
        ...lifecycle(input, 'active'),
        leaseExpiresAt: '2026-08-23T13:10:00.000Z',
      })),
    });
    const { controller, store } = createController({
      cloud: cloudClient,
      sessions: [original],
      now: () => now,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-renew', expectedGeneration: 1 });
    await controller.runTurn('first remote');

    now = new Date('2026-08-23T12:20:00.000Z');
    await controller.runTurn('after renewal');

    expect(store.value?.remote?.leaseExpiresAt).toBe('2026-08-23T13:10:00.000Z');
    expect(original.runTurn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing', undefined],
    ['short', '2026-08-23T12:59:59.999Z'],
  ])('recovers locally when active status has a %s next-turn lease', async (_name, leaseExpiresAt) => {
    let now = new Date('2026-08-23T12:00:00.000Z');
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud({
      status: vi.fn(async (input) => ({
        ...lifecycle(input, 'active'),
        ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
      })),
    });
    const { controller } = createController({
      cloud: cloudClient,
      sessions: [original, replacement],
      now: () => now,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: `request-${_name}`, expectedGeneration: 1 });
    await controller.runTurn('first remote');

    now = new Date('2026-08-23T12:20:00.000Z');
    await controller.runTurn('must recover locally');

    expect(replacement.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'must recover locally',
        execution: { kind: 'local', workspaceRoot: '/repo' },
      })
    );
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
  });

  it('never revives a locally expired lease from a later active status', async () => {
    let now = new Date('2026-08-23T12:00:00.000Z');
    const original = appServer();
    const replacement = appServer();
    const status = vi.fn(async (input) => ({
      ...lifecycle(input, 'active'),
      leaseExpiresAt: '2026-08-23T14:00:00.000Z',
    }));
    const cloudClient = cloud({ status });
    const { controller } = createController({
      cloud: cloudClient,
      sessions: [original, replacement],
      now: () => now,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-expired', expectedGeneration: 1 });
    await controller.runTurn('first remote');

    now = new Date('2026-08-23T13:00:00.001Z');
    await controller.runTurn('expired locally');

    expect(status).not.toHaveBeenCalled();
    expect(replacement.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'expired locally',
        execution: expect.objectContaining({ kind: 'local' }),
      })
    );
  });

  it.each(['failed', 'interrupted'] as const)(
    'durably preserves a live remote %s reconciliation across two crashes without replay',
    async (status) => {
      const original = appServer({ runTurn: vi.fn(async () => Promise.reject(new Error('remote died'))) });
      const replacement = appServer({
        turnOutcome: vi.fn(async () => ({ status, turnId: `turn-remote-${status}` })),
      });
      const cloudClient = cloud();
      const sealed = sealHandle();
      const { controller, store } = createController({
        sessions: [original, replacement],
        cloud: cloudClient,
        checkpointAndSeal: async () => sealed,
      });
      await controller.initialize();
      controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

      await expect(controller.runTurn('do not replay me')).rejects.toMatchObject({
        status,
        requiresRecoveryAcknowledgment: true,
      });

      expect(cloudClient.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'session-1:1:revoke' })
      );
      expect(original.close).toHaveBeenCalled();
      expect(sealed.resumeLocal).toHaveBeenCalled();
      expect(replacement.initialize).toHaveBeenCalled();
      expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
      expect(replacement.runTurn).not.toHaveBeenCalled();
      expect(store.value?.inFlightTurn).toBeUndefined();
      expect(store.value?.recoveredOutcome).toMatchObject({
        sessionId: 'session-1',
        threadId: 'thread-1',
        generation: 2,
        clientUserMessageId: 'operation-2',
        turnId: `turn-remote-${status}`,
        status,
      });
      expect(controller.status()).toMatchObject({ generation: 2, phase: 'local', execution: 'local' });

      const prewarmCallsAfterRecovery = vi.mocked(cloudClient.prewarm).mock.calls.length;
      const restartedOnce = appServer();
      const second = createController({ store, cloud: cloudClient, sessions: [restartedOnce] });
      await second.controller.initialize();
      expect(restartedOnce.turnOutcome).not.toHaveBeenCalled();
      expect(restartedOnce.runTurn).not.toHaveBeenCalled();
      expect(second.controller.takeRecoveredTerminal()).toMatchObject({ status });
      expect(vi.mocked(cloudClient.prewarm)).toHaveBeenCalledTimes(prewarmCallsAfterRecovery);

      const restartedTwice = appServer();
      const third = createController({ store, cloud: cloudClient, sessions: [restartedTwice] });
      await third.controller.initialize();
      expect(restartedTwice.turnOutcome).not.toHaveBeenCalled();
      expect(restartedTwice.runTurn).not.toHaveBeenCalled();
      expect(third.controller.takeRecoveredTerminal()).toMatchObject({ status });
      third.controller.acknowledgeRecoveredOutcome();
      expect(store.value?.recoveredOutcome).toBeUndefined();
      expect(third.controller.takeRecoveredTerminal()).toBeUndefined();
    }
  );

  it('reconciles a completed remote turn after notification loss without replaying it', async () => {
    const original = appServer({
      runTurn: vi.fn(async () => Promise.reject(new Error('notification lost'))),
    });
    const replacement = appServer({
      turnOutcome: vi.fn(async () =>
        completedOutcome('turn-remote-1', 'recovered exact answer', 'operation-2')
      ),
    });
    const cloudClient = cloud();
    const { controller, store } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('exactly once')).resolves.toMatchObject({
      turnId: 'turn-remote-1',
      response: {
        turn: {
          items: expect.arrayContaining([
            expect.objectContaining({ type: 'agentMessage', text: 'recovered exact answer' }),
          ]),
        },
      },
      completed: {
        params: {
          turn: expect.objectContaining({ id: 'turn-remote-1', status: 'completed' }),
        },
      },
    });
    expect(replacement.runTurn).not.toHaveBeenCalled();
    expect(store.value?.inFlightTurn).toBeUndefined();
    expect(store.value?.recoveredOutcome).toMatchObject({
      sessionId: 'session-1',
      threadId: 'thread-1',
      generation: 2,
      clientUserMessageId: 'operation-2',
      turnId: 'turn-remote-1',
      status: 'completed',
    });
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });

    const prewarmCallsAfterRecovery = vi.mocked(cloudClient.prewarm).mock.calls.length;
    const restartedOnce = appServer();
    const second = createController({ store, cloud: cloudClient, sessions: [restartedOnce] });
    await second.controller.initialize();
    expect(restartedOnce.turnOutcome).not.toHaveBeenCalled();
    expect(restartedOnce.runTurn).not.toHaveBeenCalled();
    expect(second.controller.takeRecoveredTurn()).toMatchObject({
      turnId: 'turn-remote-1',
      response: {
        turn: {
          items: expect.arrayContaining([
            expect.objectContaining({ type: 'agentMessage', text: 'recovered exact answer' }),
          ]),
        },
      },
    });
    expect(vi.mocked(cloudClient.prewarm)).toHaveBeenCalledTimes(prewarmCallsAfterRecovery);

    const restartedTwice = appServer();
    const third = createController({ store, cloud: cloudClient, sessions: [restartedTwice] });
    await third.controller.initialize();
    expect(restartedTwice.turnOutcome).not.toHaveBeenCalled();
    expect(restartedTwice.runTurn).not.toHaveBeenCalled();
    expect(third.controller.takeRecoveredTurn()).toMatchObject({ turnId: 'turn-remote-1' });
    third.controller.acknowledgeRecoveredOutcome();
    expect(store.value?.recoveredOutcome).toBeUndefined();
    expect(third.controller.takeRecoveredTurn()).toBeUndefined();
  });

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'keeps a file-backed %s delivery fenced across restart, resume failure, close failure, and restart',
    async (status) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `relay-controller-delivery-${status}-`));
      const statePath = path.join(directory, 'state.json');
      try {
        const clientUserMessageId = `client-file-${status}`;
        const store = fileStore(
          statePath,
          persistedRemoteForFile({
            inFlightTurn: { clientUserMessageId, execution: 'remote' },
          })
        );
        const outcome =
          status === 'completed'
            ? completedOutcome('turn-file-completed', 'file-backed answer', clientUserMessageId)
            : { status, turnId: `turn-file-${status}` };
        const reconciler = appServer({ turnOutcome: vi.fn(async () => outcome) });
        const first = createController({ store, sessions: [reconciler] });

        await expect(first.controller.initialize()).resolves.toMatchObject({
          phase: 'local',
          generation: 8,
        });
        await first.controller.close();

        const durableAfterReconcile = new FileCodexControllerStateStore(statePath).read();
        expect(durableAfterReconcile).toMatchObject({
          phase: 'local',
          generation: 8,
          recoveredOutcome: {
            generation: 8,
            clientUserMessageId,
            status,
          },
        });
        expect(durableAfterReconcile?.pending).toBeUndefined();
        expect(durableAfterReconcile?.remote).toBeUndefined();

        const resumeFailure = appServer({
          resumeThread: vi.fn(async () => Promise.reject(new Error('resume unavailable'))),
        });
        const second = createController({ store, sessions: [resumeFailure] });
        await expect(second.controller.initialize()).rejects.toThrow('CODEX_THREAD_RESUME_FAILED_ON_RESTART');

        const durableAfterResumeFailure = new FileCodexControllerStateStore(statePath).read();
        expect(durableAfterResumeFailure).toMatchObject({
          phase: 'recovery_failed',
          generation: 8,
          recoveredOutcome: { clientUserMessageId, status },
        });

        const closeError = new Error('close unavailable');
        const closeFailure = appServer({ close: vi.fn(async () => Promise.reject(closeError)) });
        const third = createController({ store, sessions: [closeFailure] });
        await expect(third.controller.initialize()).resolves.toMatchObject({
          phase: 'local',
          generation: 8,
        });

        expect(() =>
          third.controller.requestTeleport({ requestId: 'must-not-queue', expectedGeneration: 8 })
        ).toThrow('awaiting durable output acknowledgment');
        await expect(third.controller.runTurn('must not execute')).rejects.toThrow(
          'awaiting durable output acknowledgment'
        );
        await expect(third.controller.rollback()).rejects.toThrow('awaiting durable output acknowledgment');
        expect(closeFailure.runTurn).not.toHaveBeenCalled();
        expect(closeFailure.addEnvironment).not.toHaveBeenCalled();
        expect(store.value?.pending).toBeUndefined();
        expect(store.value?.generation).toBe(8);

        await expect(third.controller.close()).rejects.toBe(closeError);
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          phase: 'recovery_failed',
          generation: 8,
          recoveredOutcome: { clientUserMessageId, status },
        });

        const finalSession = appServer();
        const fourth = createController({ store, sessions: [finalSession] });
        await expect(fourth.controller.initialize()).resolves.toMatchObject({
          phase: 'local',
          generation: 8,
        });
        if (status === 'completed') {
          expect(fourth.controller.takeRecoveredTurn()).toMatchObject({
            turnId: 'turn-file-completed',
          });
        } else {
          expect(fourth.controller.takeRecoveredTerminal()).toMatchObject({ status });
        }
        fourth.controller.acknowledgeRecoveredOutcome();
        expect(new FileCodexControllerStateStore(statePath).read()?.recoveredOutcome).toBeUndefined();
        await fourth.controller.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(
    (['ready', 'failed', 'in-flight'] as const).flatMap((prewarmState) =>
      (['completed', 'failed', 'interrupted'] as const).map(
        (outcomeStatus) => [prewarmState, outcomeStatus] as const
      )
    )
  )(
    'keeps a file-backed local %s prewarm independent from an unacknowledged %s outcome',
    async (prewarmState, outcomeStatus) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `relay-controller-local-${prewarmState}-${outcomeStatus}-`)
      );
      const statePath = path.join(directory, 'state.json');
      const pendingPrewarm = deferred<{
        sessionId: string;
        prewarmId: string;
        generation: number;
        status: 'ready';
        expiresAt: string;
      }>();
      let prewarmCalls = 0;
      const prewarm = vi.fn(async (input: Parameters<LiveTeleportCloudClient['prewarm']>[0]) => {
        prewarmCalls += 1;
        if (prewarmCalls === 1) {
          if (prewarmState === 'failed') throw new Error('first prewarm failed ambiguously');
          if (prewarmState === 'in-flight') return pendingPrewarm.promise;
        }
        return {
          sessionId: input.sessionId,
          prewarmId: `prewarm-${input.generation}`,
          generation: input.generation,
          status: 'ready' as const,
          expiresAt: '2026-08-23T12:30:00.000Z',
        };
      });
      const cloudClient = cloud({ prewarm });
      const store = fileStore(statePath, persistedLocal({ generation: 1 }));
      const outcome =
        outcomeStatus === 'completed'
          ? completedOutcome('turn-local-recovered', 'file-backed local answer', 'operation-1')
          : { status: outcomeStatus, turnId: `turn-local-${outcomeStatus}` };
      const local = appServer({
        runTurn: vi.fn(async () => Promise.reject(new Error('terminal notification lost'))),
        turnOutcome: vi.fn(async () => outcome),
      });

      try {
        const first = createController({ store, cloud: cloudClient, sessions: [local] });
        await first.controller.initialize();
        if (prewarmState === 'ready') {
          await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));
        } else if (prewarmState === 'failed') {
          await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('failed'));
        }

        if (outcomeStatus === 'completed') {
          await expect(first.controller.runTurn('do not replay local')).resolves.toMatchObject({
            turnId: 'turn-local-recovered',
          });
        } else {
          await expect(first.controller.runTurn('do not replay local')).rejects.toMatchObject({
            status: outcomeStatus,
            requiresRecoveryAcknowledgment: true,
          });
        }
        expect(local.runTurn).toHaveBeenCalledTimes(1);
        expect(local.turnOutcome).toHaveBeenCalledTimes(1);

        const durableBeforeRestart = new FileCodexControllerStateStore(statePath).read();
        expect(durableBeforeRestart).toMatchObject({
          generation: 1,
          phase: 'local',
          cloudLifecycle: prewarmState === 'ready' ? 'prewarmed' : 'prewarm_requested',
          recoveredOutcome: {
            generation: 1,
            clientUserMessageId: 'operation-1',
            status: outcomeStatus,
          },
        });
        if (prewarmState === 'in-flight') {
          expect(durableBeforeRestart?.prewarmStatus).toBeUndefined();
        }

        const closeError = new Error('close unavailable after durable recovery');
        const afterCrash = appServer({ close: vi.fn(async () => Promise.reject(closeError)) });
        const second = createController({ store, cloud: cloudClient, sessions: [afterCrash] });
        await expect(second.controller.initialize()).resolves.toMatchObject({
          generation: 2,
          phase: 'local',
        });
        expect(cloudClient.revoke).toHaveBeenCalledWith(
          expect.objectContaining({ generation: 1, idempotencyKey: 'session-1:1:revoke' })
        );
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          generation: 2,
          cloudLifecycle: 'none',
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });
        expect(new FileCodexControllerStateStore(statePath).read()?.prewarmId).toBeUndefined();
        expect(new FileCodexControllerStateStore(statePath).read()?.prewarmStatus).toBeUndefined();

        await expect(second.controller.close()).rejects.toBe(closeError);
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          phase: 'recovery_failed',
          generation: 2,
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });

        const resumeFailure = appServer({
          resumeThread: vi.fn(async () => Promise.reject(new Error('resume unavailable'))),
        });
        const third = createController({ store, cloud: cloudClient, sessions: [resumeFailure] });
        await expect(third.controller.initialize()).rejects.toThrow('CODEX_THREAD_RESUME_FAILED_ON_RESTART');
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          phase: 'recovery_failed',
          generation: 2,
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });

        const finalSession = appServer();
        const fourth = createController({ store, cloud: cloudClient, sessions: [finalSession] });
        await fourth.controller.initialize();
        expect(finalSession.runTurn).not.toHaveBeenCalled();
        if (outcomeStatus === 'completed') {
          expect(fourth.controller.takeRecoveredTurn()).toMatchObject({
            turnId: 'turn-local-recovered',
          });
        } else {
          expect(fourth.controller.takeRecoveredTerminal()).toMatchObject({ status: outcomeStatus });
        }
        fourth.controller.acknowledgeRecoveredOutcome();
        await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));
        expect(prewarm).toHaveBeenLastCalledWith(
          expect.objectContaining({ generation: 2, idempotencyKey: 'session-1:2:prewarm' })
        );
        await fourth.controller.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('keeps late background prewarm completion from invalidating or erasing recovered output', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-controller-late-prewarm-'));
    const statePath = path.join(directory, 'state.json');
    const pendingPrewarm = deferred<{
      sessionId: string;
      prewarmId: string;
      generation: number;
      status: 'ready';
      expiresAt: string;
    }>();
    const prewarm = vi.fn(() => pendingPrewarm.promise);
    const cloudClient = cloud({ prewarm });
    const store = fileStore(statePath, persistedLocal({ generation: 1 }));
    const local = appServer({
      runTurn: vi.fn(async () => Promise.reject(new Error('terminal notification lost'))),
      turnOutcome: vi.fn(async () =>
        completedOutcome('turn-local-late-prewarm', 'exact recovered answer', 'operation-1')
      ),
    });

    try {
      const { controller } = createController({ store, cloud: cloudClient, sessions: [local] });
      await controller.initialize();
      await controller.runTurn('do not replay local');
      expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
        cloudLifecycle: 'prewarm_requested',
        recoveredOutcome: { turnId: 'turn-local-late-prewarm', status: 'completed' },
      });

      pendingPrewarm.resolve({
        sessionId: 'session-1',
        prewarmId: 'prewarm-1',
        generation: 1,
        status: 'ready',
        expiresAt: '2026-08-23T12:30:00.000Z',
      });
      await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));
      expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
        cloudLifecycle: 'prewarmed',
        prewarmId: 'prewarm-1',
        recoveredOutcome: { turnId: 'turn-local-late-prewarm', status: 'completed' },
      });

      controller.acknowledgeRecoveredOutcome();
      expect(prewarm).toHaveBeenCalledTimes(1);
      expect(new FileCodexControllerStateStore(statePath).read()?.recoveredOutcome).toBeUndefined();
      await controller.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains a turn-boundary teleport queued while recovered local output awaits acknowledgment', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-controller-recovered-pending-'));
    const statePath = path.join(directory, 'state.json');
    const lostTerminal = deferred<CodexTurnResult>();
    const local = appServer({
      runTurn: vi
        .fn()
        .mockImplementationOnce(() => lostTerminal.promise)
        .mockResolvedValue(turnResult()),
      turnOutcome: vi.fn(async () =>
        completedOutcome('turn-before-queued-teleport', 'durable exact answer', 'operation-1')
      ),
    });
    const store = fileStore(statePath, persistedLocal({ generation: 1 }));
    const cloudClient = cloud();

    try {
      const { controller } = createController({ store, cloud: cloudClient, sessions: [local] });
      await controller.initialize();
      await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));

      const running = controller.runTurn('turn before queued teleport');
      await vi.waitFor(() => expect(local.runTurn).toHaveBeenCalledTimes(1));
      controller.requestTeleport({ requestId: 'queued-during-turn', expectedGeneration: 1 });
      lostTerminal.reject(new Error('terminal notification lost'));
      await expect(running).resolves.toMatchObject({ turnId: 'turn-before-queued-teleport' });

      expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
        phase: 'teleport_pending',
        pending: { requestId: 'queued-during-turn', expectedGeneration: 1 },
        recoveredOutcome: { turnId: 'turn-before-queued-teleport', status: 'completed' },
      });
      await expect(controller.runTurn('must wait for durable output')).rejects.toThrow(
        'awaiting durable output acknowledgment'
      );

      controller.acknowledgeRecoveredOutcome();
      await expect(controller.runTurn('first turn after acknowledgment')).resolves.toMatchObject({
        turnId: 'turn-1',
      });
      expect(cloudClient.acquire).toHaveBeenCalledTimes(1);
      expect(cloudClient.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 1, idempotencyKey: 'session-1:1:acquire' })
      );
      expect(local.runTurn).toHaveBeenCalledTimes(2);
      await controller.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(
    (['ready', 'failed', 'in-flight'] as const).flatMap((prewarmState) =>
      (['completed', 'failed', 'interrupted'] as const).map(
        (outcomeStatus) => [prewarmState, outcomeStatus] as const
      )
    )
  )(
    'rebases a queued teleport after a crash with %s prewarm and %s recovery evidence',
    async (prewarmState, outcomeStatus) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `relay-controller-pending-restart-${prewarmState}-${outcomeStatus}-`)
      );
      const statePath = path.join(directory, 'state.json');
      const neverSettledPrewarm = deferred<{
        sessionId: string;
        prewarmId: string;
        generation: number;
        status: 'ready';
        expiresAt: string;
      }>();
      let prewarmCalls = 0;
      const prewarm = vi.fn(async (input: Parameters<LiveTeleportCloudClient['prewarm']>[0]) => {
        prewarmCalls += 1;
        if (prewarmCalls === 1) {
          if (prewarmState === 'failed') throw new Error('first prewarm failed ambiguously');
          if (prewarmState === 'in-flight') return neverSettledPrewarm.promise;
        }
        return {
          sessionId: input.sessionId,
          prewarmId: `prewarm-${input.generation}`,
          generation: input.generation,
          status: 'ready' as const,
          expiresAt: '2026-08-23T12:30:00.000Z',
        };
      });
      const cloudClient = cloud({ prewarm });
      const store = fileStore(statePath, persistedLocal({ generation: 1 }));
      const lostTerminal = deferred<CodexTurnResult>();
      const outcome =
        outcomeStatus === 'completed'
          ? completedOutcome('turn-before-crash', 'durable answer before crash', 'operation-1')
          : { status: outcomeStatus, turnId: `turn-before-crash-${outcomeStatus}` };
      const firstSession = appServer({
        runTurn: vi.fn(() => lostTerminal.promise),
        turnOutcome: vi.fn(async () => outcome),
      });

      try {
        const first = createController({ store, cloud: cloudClient, sessions: [firstSession] });
        await first.controller.initialize();
        if (prewarmState === 'ready') {
          await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));
        } else if (prewarmState === 'failed') {
          await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('failed'));
        } else {
          expect(store.value).toMatchObject({ cloudLifecycle: 'prewarm_requested' });
          expect(store.value?.prewarmStatus).toBeUndefined();
        }

        const running = first.controller.runTurn('turn before process crash');
        await vi.waitFor(() => expect(firstSession.runTurn).toHaveBeenCalledTimes(1));
        first.controller.requestTeleport({ requestId: 'queued-before-crash', expectedGeneration: 1 });
        lostTerminal.reject(new Error('terminal notification lost before process crash'));
        if (outcomeStatus === 'completed') {
          await expect(running).resolves.toMatchObject({ turnId: 'turn-before-crash' });
        } else {
          await expect(running).rejects.toMatchObject({
            status: outcomeStatus,
            requiresRecoveryAcknowledgment: true,
          });
        }
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          generation: 1,
          phase: 'teleport_pending',
          pending: { requestId: 'queued-before-crash', expectedGeneration: 1 },
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });

        // Simulate a new process whose first restart cannot resume the Codex
        // thread after the old Cloud identity has been fenced.
        const resumeFailure = appServer({
          resumeThread: vi.fn(async () => Promise.reject(new Error('resume unavailable'))),
        });
        const second = createController({ store, cloud: cloudClient, sessions: [resumeFailure] });
        await expect(second.controller.initialize()).rejects.toThrow('CODEX_THREAD_RESUME_FAILED_ON_RESTART');
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          generation: 1,
          phase: 'recovery_failed',
          pending: { requestId: 'queued-before-crash', expectedGeneration: 1 },
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });
        expect(prewarm).toHaveBeenCalledTimes(1);
        expect(cloudClient.acquire).not.toHaveBeenCalled();

        // A later restart succeeds and atomically moves both the controller and
        // accepted request onto generation 2. A close failure must not erase it.
        const closeError = new Error('close unavailable after restart');
        const closeFailure = appServer({ close: vi.fn(async () => Promise.reject(closeError)) });
        const third = createController({ store, cloud: cloudClient, sessions: [closeFailure] });
        await expect(third.controller.initialize()).resolves.toMatchObject({
          generation: 2,
          phase: 'teleport_pending',
          pending: { requestId: 'queued-before-crash', expectedGeneration: 2 },
        });
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          generation: 2,
          pending: { requestId: 'queued-before-crash', expectedGeneration: 2 },
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });
        expect(prewarm).toHaveBeenCalledTimes(1);
        expect(cloudClient.acquire).not.toHaveBeenCalled();
        await expect(third.controller.close()).rejects.toBe(closeError);
        expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
          phase: 'recovery_failed',
          generation: 2,
          pending: { requestId: 'queued-before-crash', expectedGeneration: 2 },
          recoveredOutcome: { generation: 1, status: outcomeStatus },
        });

        const finalSession = appServer();
        const fourth = createController({ store, cloud: cloudClient, sessions: [finalSession] });
        await expect(fourth.controller.initialize()).resolves.toMatchObject({
          generation: 2,
          phase: 'teleport_pending',
        });
        expect(prewarm).toHaveBeenCalledTimes(1);
        expect(cloudClient.acquire).not.toHaveBeenCalled();

        if (outcomeStatus === 'completed') {
          expect(fourth.controller.takeRecoveredTurn()).toMatchObject({ turnId: 'turn-before-crash' });
        } else {
          expect(fourth.controller.takeRecoveredTerminal()).toMatchObject({ status: outcomeStatus });
        }
        fourth.controller.acknowledgeRecoveredOutcome();
        await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));
        expect(prewarm).toHaveBeenCalledTimes(2);
        expect(prewarm).toHaveBeenLastCalledWith(
          expect.objectContaining({ generation: 2, idempotencyKey: 'session-1:2:prewarm' })
        );

        await expect(fourth.controller.runTurn('first acknowledged Cloud turn')).resolves.toMatchObject({
          turnId: 'turn-1',
        });
        expect(cloudClient.acquire).toHaveBeenCalledTimes(1);
        expect(cloudClient.acquire).toHaveBeenCalledWith(
          expect.objectContaining({ generation: 2, idempotencyKey: 'session-1:2:acquire' })
        );
        await fourth.controller.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('retains the consumed generation fence if restart crashes after terminal revoke', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-controller-terminal-fence-'));
    const statePath = path.join(directory, 'state.json');
    const recovered = completedOutcome(
      'turn-before-terminal-fence',
      'durable answer before terminal fence',
      'client-before-terminal-fence'
    );
    const store = fileStore(
      statePath,
      persistedLocal({
        generation: 3,
        cloudLifecycle: 'prewarmed',
        prewarmId: 'prewarm-3',
        prewarmStatus: 'ready',
        recoveredOutcome: {
          sessionId: 'session-1',
          threadId: 'thread-1',
          generation: 3,
          clientUserMessageId: 'client-before-terminal-fence',
          turnId: recovered.turnId,
          status: 'completed',
          result: recovered.result,
        },
      })
    );
    const cloudClient = cloud();
    const startFailure = appServer({
      initialize: vi.fn(async () => Promise.reject(new Error('process crashed after revoke'))),
    });

    try {
      const first = createController({ store, cloud: cloudClient, sessions: [startFailure] });
      await expect(first.controller.initialize()).rejects.toThrow('process crashed after revoke');
      expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
        generation: 3,
        phase: 'rolling_back',
        cloudLifecycle: 'cleanup_requested',
        recoveredOutcome: { generation: 3, turnId: recovered.turnId },
      });

      const resumed = appServer();
      const second = createController({ store, cloud: cloudClient, sessions: [resumed] });
      await expect(second.controller.initialize()).resolves.toMatchObject({
        generation: 4,
        phase: 'local',
        cloudLifecycle: 'none',
      });
      expect(cloudClient.revoke).toHaveBeenCalledTimes(2);
      expect(cloudClient.revoke).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ generation: 3, idempotencyKey: 'session-1:3:revoke' })
      );
      expect(new FileCodexControllerStateStore(statePath).read()).toMatchObject({
        generation: 4,
        recoveredOutcome: { generation: 3, turnId: recovered.turnId },
      });
      expect(new FileCodexControllerStateStore(statePath).read()?.prewarmId).toBeUndefined();
      expect(new FileCodexControllerStateStore(statePath).read()?.prewarmStatus).toBeUndefined();

      expect(second.controller.takeRecoveredTurn()).toMatchObject({ turnId: recovered.turnId });
      second.controller.acknowledgeRecoveredOutcome();
      await vi.waitFor(() => expect(store.value?.prewarmStatus).toBe('ready'));
      expect(cloudClient.prewarm).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 4, idempotencyKey: 'session-1:4:prewarm' })
      );
      await second.controller.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails outcome-uncertain when an accepted remote turn cannot be found after fencing', async () => {
    const original = appServer({ runTurn: vi.fn(async () => Promise.reject(new Error('transport lost'))) });
    const replacement = appServer({ turnOutcome: vi.fn(async () => ({ status: 'absent' as const })) });
    const { controller } = createController({ sessions: [original, replacement] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('ambiguous')).rejects.toThrow('outcome is uncertain');
    expect(replacement.runTurn).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'outcome_uncertain', execution: 'fenced' });
  });

  it('fails outcome-uncertain instead of claiming completion when history lost the exact answer', async () => {
    const original = appServer({
      runTurn: vi.fn(async () => Promise.reject(new Error('notification lost'))),
    });
    const replacement = appServer({
      turnOutcome: vi.fn(async () => {
        throw new Error('completed history omitted assistant answer');
      }),
    });
    const { controller } = createController({ sessions: [original, replacement] });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-missing-answer', expectedGeneration: 1 });

    await expect(controller.runTurn('need exact answer')).rejects.toThrow('outcome is uncertain');
    expect(controller.status()).toMatchObject({
      phase: 'outcome_uncertain',
      lastError: 'TURN_RECONCILIATION_UNAVAILABLE',
    });
  });

  it('recovers an expired later-turn lease before submitting the next prompt locally', async () => {
    const original = appServer();
    const replacement = appServer();
    const cloudClient = cloud({ status: vi.fn(async (input) => lifecycle(input, 'expired')) });
    const { controller } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('first remote');

    await controller.runTurn('after lease expiry');

    expect(replacement.runTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'after lease expiry',
      clientUserMessageId: 'operation-3',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
  });

  it('fails fenced and never resumes locally when first-turn revoke is unconfirmed', async () => {
    const original = appServer({ runTurn: vi.fn(async () => Promise.reject(new Error('remote died'))) });
    const replacement = appServer();
    const sealed = sealHandle();
    const cloudClient = cloud({
      revoke: vi.fn(async () => Promise.reject(new Error('revoke timeout'))),
      status: vi.fn(async (input) => lifecycle(input, 'ready')),
    });
    const { controller, createAppServer } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });

    await expect(controller.runTurn('must not run locally')).rejects.toThrow('CLOUD_FENCE_UNCONFIRMED');

    expect(original.close).toHaveBeenCalled();
    expect(createAppServer).toHaveBeenCalledTimes(1);
    expect(sealed.resumeLocal).not.toHaveBeenCalled();
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

    await expect(controller.runTurn('local only')).resolves.toMatchObject({ turnId: 'turn-1' });

    expect(cloudClient.acquire).not.toHaveBeenCalled();
    expect(cloudClient.revoke).toHaveBeenCalled();
    expect(replacement.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'local only', execution: { kind: 'local', workspaceRoot: '/repo' } })
    );
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
  });

  it('does not persist a seal whose restore identity targets another local root', async () => {
    const sealed = sealHandle({
      restore: {
        lifecycleId: 'session-1:1:operation-1',
        resumeId: 'resume-1',
        workspaceId: 'workspace-1',
        localRoot: '/other',
      },
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

    await expect(controller.runTurn('must stay on this mount')).resolves.toMatchObject({ turnId: 'turn-1' });

    expect(cloudClient.acquire).not.toHaveBeenCalled();
    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(replacement.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'must stay on this mount',
        execution: { kind: 'local', workspaceRoot: '/repo' },
      })
    );
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

    await expect(controller.runTurn('local after abort')).resolves.toMatchObject({ turnId: 'turn-1' });

    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(controller.status()).toMatchObject({ phase: 'local', generation: 2 });
    expect(replacement.runTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'local after abort',
      clientUserMessageId: 'operation-2',
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

    await expect(controller.runTurn('must stay fenced')).rejects.toThrow(
      'RELAYFILE_RESUME_FAILED_AFTER_FENCE'
    );

    expect(createAppServer).toHaveBeenCalledTimes(1);
    expect(replacement.resumeThread).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'recovery_failed', execution: 'fenced' });
  });

  it('polls warming lifecycle status to ready before acquisition', async () => {
    const cloudClient = cloud({
      prewarm: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        prewarmId: `prewarm-${input.generation}`,
        generation: input.generation,
        status: 'warming' as const,
        expiresAt: '2026-08-23T12:30:00.000Z',
        retryAfterMs: 1,
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
        sessionId: input.sessionId,
        prewarmId: `prewarm-${input.generation}`,
        generation: input.generation,
        status: 'warming' as const,
        expiresAt: '2026-08-23T12:30:00.000Z',
        retryAfterMs: 1,
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

    await expect(controller.runTurn('bounded')).resolves.toMatchObject({ turnId: 'turn-1' });

    expect(cloudClient.acquire).not.toHaveBeenCalled();
    expect(replacement.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'bounded', execution: { kind: 'local', workspaceRoot: '/repo' } })
    );
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
    const cloudClient = cloud();
    const { controller } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote');

    const status = await controller.rollback();

    expect(original.close).toHaveBeenCalled();
    expect(sealed.resumeLocal).toHaveBeenCalled();
    expect(vi.mocked(cloudClient.revoke).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sealed.resumeLocal).mock.invocationCallOrder[0]!
    );
    expect(replacement.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(status).toMatchObject({ phase: 'local', generation: 2, execution: 'local' });
  });

  it('does not resume a consumed checkpoint while Cloud handback is cleanup_pending', async () => {
    const handback = deferred<LiveTeleportLifecycleStatus>();
    const original = appServer();
    const replacement = appServer();
    const sealed = sealHandle();
    const cloudClient = cloud({
      revoke: vi.fn(async (input) => lifecycle(input, 'cleanup_pending')),
      status: vi.fn(() => handback.promise),
    });
    const { controller } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote');

    const rollingBack = controller.rollback();
    await vi.waitFor(() => expect(cloudClient.status).toHaveBeenCalled());
    expect(sealed.resumeLocal).not.toHaveBeenCalled();

    handback.resolve(lifecycle({ sessionId: 'session-1', generation: 1 }, 'revoked'));
    await rollingBack;
    expect(sealed.resumeLocal).toHaveBeenCalledOnce();
  });

  it('keeps the source sealed when revoke ignores abort and never settles', async () => {
    const original = appServer();
    const replacement = appServer();
    const sealed = sealHandle();
    const cloudClient = cloud({ revoke: vi.fn(async () => new Promise<never>(() => undefined)) });
    const { controller } = createController({
      sessions: [original, replacement],
      cloud: cloudClient,
      lifecycleDeadlineMs: 5,
      checkpointAndSeal: async () => sealed,
    });
    await controller.initialize();
    controller.requestTeleport({ requestId: 'request-1', expectedGeneration: 1 });
    await controller.runTurn('remote');

    await expect(controller.rollback()).rejects.toThrow('CLOUD_FENCE_UNCONFIRMED');

    expect(sealed.resumeLocal).not.toHaveBeenCalled();
    expect(replacement.resumeThread).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ phase: 'fenced' });
  });

  it('restarts a clean local session without trying to revoke or poll Cloud', async () => {
    const store = memoryStore(persistedLocal());
    const resumed = appServer();
    const cloudClient = cloud();
    const { controller } = createController({ store, sessions: [resumed], cloud: cloudClient });

    await expect(controller.initialize()).resolves.toMatchObject({ phase: 'local', generation: 3 });

    expect(cloudClient.revoke).not.toHaveBeenCalled();
    expect(cloudClient.status).not.toHaveBeenCalled();
    expect(resumed.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
  });

  it('fences a persisted prewarm request whose response may have been lost', async () => {
    const store = memoryStore(persistedLocal({ cloudLifecycle: 'prewarm_requested' }));
    const resumed = appServer();
    const cloudClient = cloud();
    const { controller } = createController({ store, sessions: [resumed], cloud: cloudClient });

    await expect(controller.initialize()).resolves.toMatchObject({ phase: 'local', generation: 4 });

    expect(cloudClient.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', generation: 3, idempotencyKey: 'session-1:3:revoke' })
    );
    expect(resumed.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
  });

  it('persists fenced on restart and never constructs a local app-server after unconfirmed revoke', async () => {
    const persisted = persistedRemote();
    persisted.remote!.leaseExpiresAt = '2026-08-23T11:00:00.000Z';
    const store = memoryStore(persisted);
    const cloudClient = cloud({
      revoke: vi.fn(async () => Promise.reject(new Error('timeout'))),
      status: vi.fn(async (input) => lifecycle(input, 'ready')),
    });
    const { controller, createAppServer } = createController({ store, cloud: cloudClient });

    await expect(controller.initialize()).rejects.toThrow('CLOUD_FENCE_UNCONFIRMED_ON_RESTART');

    expect(createAppServer).not.toHaveBeenCalled();
    expect(store.value).toMatchObject({ phase: 'fenced', generation: 7 });
  });

  it('resumes locally only after Cloud authoritatively confirms the persisted lease expired', async () => {
    const expired = persistedRemote({
      remote: { ...persistedRemote().remote!, leaseExpiresAt: '2026-08-23T11:59:59.000Z' },
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
    expect(resumePersistedLocalMount).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'relayfile-checkpoint-seal' } })
    );
    expect(resumed.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-1', cwd: '/repo' });
    expect(store.value?.source).toBeUndefined();
    expect(store.value?.mountRestore).toBeUndefined();
  });

  it('reconciles a persisted completed turn before reopening local execution after restart', async () => {
    const store = memoryStore(
      persistedRemote({
        inFlightTurn: { clientUserMessageId: 'client-persisted-1', execution: 'remote' },
      })
    );
    const resumed = appServer({
      turnOutcome: vi.fn(async () => completedOutcome('turn-persisted-1')),
    });
    const { controller } = createController({ store, sessions: [resumed] });

    await expect(controller.initialize()).resolves.toMatchObject({ phase: 'local', generation: 8 });
    expect(resumed.turnOutcome).toHaveBeenCalledWith({
      threadId: 'thread-1',
      clientUserMessageId: 'client-persisted-1',
    });
    expect(store.value?.inFlightTurn).toBeUndefined();
    expect(controller.takeRecoveredTurn()).toMatchObject({
      reconciled: true,
      response: {
        turn: {
          items: expect.arrayContaining([
            expect.objectContaining({ type: 'agentMessage', text: 'answer for turn-persisted-1' }),
          ]),
        },
      },
    });
    expect(controller.takeRecoveredTurn()).toBeUndefined();
    expect(store.value?.recoveredOutcome).toMatchObject({
      sessionId: 'session-1',
      threadId: 'thread-1',
      generation: 8,
      clientUserMessageId: 'client-persisted-1',
      turnId: 'turn-persisted-1',
      status: 'completed',
    });

    const restartedOnce = appServer();
    const second = createController({ store, sessions: [restartedOnce] });
    await second.controller.initialize();
    expect(restartedOnce.turnOutcome).not.toHaveBeenCalled();
    expect(second.controller.takeRecoveredTurn()).toMatchObject({
      completed: {
        params: {
          turn: {
            items: expect.arrayContaining([expect.objectContaining({ text: 'answer for turn-persisted-1' })]),
          },
        },
      },
    });

    const restartedTwice = appServer();
    const third = createController({ store, sessions: [restartedTwice] });
    await third.controller.initialize();
    expect(restartedTwice.turnOutcome).not.toHaveBeenCalled();
    expect(third.controller.takeRecoveredTurn()).toMatchObject({ turnId: 'turn-persisted-1' });
    third.controller.acknowledgeRecoveredOutcome();
    expect(store.value?.recoveredOutcome).toBeUndefined();
  });

  it.each(['failed', 'interrupted'] as const)(
    'preserves a persisted crash-reconciled %s terminal for one-shot CLI failure',
    async (status) => {
      const store = memoryStore(
        persistedRemote({
          inFlightTurn: { clientUserMessageId: `client-persisted-${status}`, execution: 'remote' },
        })
      );
      const resumed = appServer({
        turnOutcome: vi.fn(async () => ({ status, turnId: `turn-persisted-${status}` })),
      });
      const cloudClient = cloud();
      const { controller } = createController({ store, sessions: [resumed], cloud: cloudClient });

      await expect(controller.initialize()).resolves.toMatchObject({ phase: 'local', generation: 8 });
      expect(resumed.runTurn).not.toHaveBeenCalled();
      expect(cloudClient.prewarm).not.toHaveBeenCalled();
      expect(store.value?.inFlightTurn).toBeUndefined();
      expect(controller.takeRecoveredTerminal()).toMatchObject({
        name: 'CodexTurnRecordedError',
        status,
        recordedTerminal: true,
      });
      expect(controller.takeRecoveredTerminal()).toBeUndefined();
      expect(controller.takeRecoveredTurn()).toBeUndefined();
      expect(store.value?.recoveredOutcome).toMatchObject({
        sessionId: 'session-1',
        threadId: 'thread-1',
        generation: 8,
        clientUserMessageId: `client-persisted-${status}`,
        turnId: `turn-persisted-${status}`,
        status,
      });

      const restartedOnce = appServer();
      const second = createController({ store, cloud: cloudClient, sessions: [restartedOnce] });
      await second.controller.initialize();
      expect(restartedOnce.turnOutcome).not.toHaveBeenCalled();
      expect(second.controller.takeRecoveredTerminal()).toMatchObject({ status });

      const restartedTwice = appServer();
      const third = createController({ store, cloud: cloudClient, sessions: [restartedTwice] });
      await third.controller.initialize();
      expect(restartedTwice.turnOutcome).not.toHaveBeenCalled();
      expect(third.controller.takeRecoveredTerminal()).toMatchObject({ status });
      third.controller.acknowledgeRecoveredOutcome();
      expect(store.value?.recoveredOutcome).toBeUndefined();
    }
  );

  it('keeps restart recovery outcome-uncertain when completed history cannot return the exact answer', async () => {
    const store = memoryStore(
      persistedRemote({
        inFlightTurn: { clientUserMessageId: 'client-persisted-missing', execution: 'remote' },
      })
    );
    const resumed = appServer({
      turnOutcome: vi.fn(async () => {
        throw new Error('completed history omitted assistant answer');
      }),
    });
    const { controller } = createController({ store, sessions: [resumed] });

    await expect(controller.initialize()).rejects.toThrow('outcome is uncertain');
    expect(store.value).toMatchObject({
      phase: 'outcome_uncertain',
      generation: 7,
      lastError: 'TURN_RECONCILIATION_UNAVAILABLE',
      inFlightTurn: { clientUserMessageId: 'client-persisted-missing' },
    });
    expect(controller.takeRecoveredTurn()).toBeUndefined();
  });

  it('fails recovery if the same thread cannot be resumed after a confirmed fence', async () => {
    const store = memoryStore(persistedRemote());
    const resumed = appServer({ resumeThread: vi.fn(async () => Promise.reject(new Error('gone'))) });
    const { controller } = createController({ store, sessions: [resumed] });

    await expect(controller.initialize()).rejects.toThrow('CODEX_THREAD_RESUME_FAILED_ON_RESTART');

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

  it('cancels and fences a racing prewarm without a late state mutation', async () => {
    const prewarmStarted = deferred<void>();
    const cloudClient = cloud({
      prewarm: vi.fn(
        (input) =>
          new Promise((_, reject) => {
            prewarmStarted.resolve();
            input.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true }
            );
          })
      ),
    });
    const { controller, store } = createController({ cloud: cloudClient });
    await controller.initialize();
    await prewarmStarted.promise;

    await controller.close();
    await Promise.resolve();

    expect(cloudClient.revoke).toHaveBeenCalled();
    expect(store.value).toMatchObject({ cloudLifecycle: 'none' });
    expect(store.value?.prewarmStatus).toBeUndefined();
  });

  it('bounds shutdown when prewarm ignores abort, then fences the ambiguous request', async () => {
    const original = appServer();
    const cloudClient = cloud({
      prewarm: vi.fn(async () => new Promise<never>(() => undefined)),
    });
    const { controller } = createController({
      sessions: [original],
      cloud: cloudClient,
      lifecycleDeadlineMs: 5,
    });
    await controller.initialize();

    await controller.close();

    expect(cloudClient.revoke).toHaveBeenCalled();
    expect(original.close).toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ cloudLifecycle: 'none' });
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

describe('FileCodexControllerStateStore', () => {
  it.each([
    ['foreign version', { ...persistedLocal(), version: 2 }],
    ['negative generation', { ...persistedLocal(), generation: -1 }],
    ['invalid pid', { ...persistedLocal(), controllerPid: 0 }],
    ['malformed phase', { ...persistedLocal(), phase: 'teleported' }],
    ['malformed pending', { ...persistedLocal(), pending: { requestId: '', expectedGeneration: 3 } }],
    ['secret-bearing source', { ...persistedLocal(), source: { ...source } }],
    [
      'cross-root restore',
      {
        ...persistedLocal(),
        mountRestore: { lifecycleId: 'lifecycle-3', resumeId: 'resume-3', localRoot: '/other' },
      },
    ],
    ['partial remote', { ...persistedLocal(), remote: { sessionId: 'session-1', generation: 3 } }],
    [
      'cross-generation remote',
      {
        ...persistedRemote(),
        remote: { ...persistedRemote().remote!, generation: 8 },
      },
    ],
    [
      'cross-root destination verification',
      {
        ...persistedRemote(),
        remote: {
          ...persistedRemote().remote!,
          verification: {
            ...persistedRemote().remote!.verification,
            localRoot: '/different-workspace',
          },
        },
      },
    ],
    [
      'malformed in-flight turn',
      { ...persistedLocal(), inFlightTurn: { clientUserMessageId: '', execution: 'remote' } },
    ],
    [
      'cross-session recovered outcome',
      {
        ...persistedLocal(),
        recoveredOutcome: {
          sessionId: 'other-session',
          threadId: 'thread-1',
          generation: 3,
          clientUserMessageId: 'client-recovered',
          turnId: 'turn-recovered',
          status: 'completed',
          result: completedOutcome('turn-recovered').result,
        },
      },
    ],
    [
      'future-generation recovered outcome',
      {
        ...persistedLocal(),
        recoveredOutcome: {
          sessionId: 'session-1',
          threadId: 'thread-1',
          generation: 4,
          clientUserMessageId: 'client-future',
          turnId: 'turn-future',
          status: 'failed',
        },
      },
    ],
    [
      'two-generations-stale recovered outcome',
      {
        ...persistedLocal(),
        recoveredOutcome: {
          sessionId: 'session-1',
          threadId: 'thread-1',
          generation: 1,
          clientUserMessageId: 'client-stale',
          turnId: 'turn-stale',
          status: 'interrupted',
        },
      },
    ],
  ])('rejects %s instead of adopting malformed controller state', (_name, value) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-controller-state-'));
    const file = path.join(directory, 'state.json');
    try {
      fs.writeFileSync(file, JSON.stringify(value));
      expect(() => new FileCodexControllerStateStore(file).read()).toThrow(
        'invalid or from an unsupported version'
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
