import { readFileSync } from 'node:fs';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import {
  bindPreviewTransport,
  type RelayTransport,
  type RelayTransportRequest,
  type RelayTransportWriteRequest,
  type WritebackResult,
} from '@relayfile/relay-helpers';
import { describe, expect, it, vi } from 'vitest';
import guardian, {
  CYCLE_STATE_PATH,
  ProgressStateConflictError,
  SLACK_WRITEBACK_POLL_MS,
  SLACK_WRITEBACK_TIMEOUT_MS,
  createHttpProgressStore,
  deliveredSlackTs,
  featurePostIdempotencyKey,
  resolveManifestPath,
  type ProgressState,
} from './agent.ts';

const persona = JSON.parse(readFileSync(new URL('./persona.json', import.meta.url), 'utf8')) as {
  inputs: { SLACK_CHANNEL: { default: string } };
};

const manifestFeatures = [
  {
    id: 'broker-up',
    name: 'Start Broker',
    cli: 'relay node up',
    description: 'Starts the local broker.',
    tier: 1,
  },
  {
    id: 'broker-down',
    name: 'Stop Broker',
    cli: 'relay node down',
    description: 'Stops the local broker.',
    tier: 2,
  },
  {
    id: 'broker-status',
    name: 'Broker Status',
    cli: 'relay node status',
    description: 'Shows broker status.',
    tier: 1,
  },
  ...Array.from({ length: 119 }, (_, index) => ({
    id: `feature-${index + 4}`,
    name: `Feature ${index + 4}`,
    cli: `relay feature-${index + 4}`,
    description: `Checks feature ${index + 4}.`,
    tier: 6,
  })),
];

const manifest = [
  "version: '1'",
  'categories:',
  '  core:',
  '    name: Core',
  '    criticality: critical',
  '    features:',
  ...manifestFeatures.flatMap((feature) => [
    `      - id: ${feature.id}`,
    `        name: ${feature.name}`,
    `        cli: ${feature.cli}`,
    `        description: ${feature.description}`,
    `        verify_tier: ${feature.tier}`,
  ]),
].join('\n');

const cycleStatePath = '/memory/workspace/relay-feature-guardian/cycle-state.json';

const storeFeatures = manifestFeatures.map((feature) => ({
  ...feature,
  desc: feature.description,
  criticality: 'critical' as const,
}));

const orderedManifestFeatures = [...manifestFeatures].sort((a, b) => a.tier - b.tier);

function progressState(checkedCount: number, generation = 1): ProgressState {
  const checkedIds = orderedManifestFeatures.slice(0, checkedCount).map((feature) => feature.id);
  return {
    kind: 'relay-feature-guardian:progress',
    version: 3,
    generation,
    checkedIds,
    cycleStartedAt: generation === 1 ? '2026-07-18T10:26:47.981Z' : '2026-07-18T11:26:47.981Z',
    totalFeatures: 122,
    ...(checkedCount > 0
      ? {
          lastPost: {
            featureId: checkedIds.at(-1) as string,
            ts: `1784370${checkedCount}.029509`,
          },
        }
      : {}),
  };
}

class RelayfileStateServer {
  content: string | null;
  revision = 1;
  failGetStatus = 0;
  hangMethod: 'GET' | 'PUT' | null = null;
  corruptReadBack = false;
  readonly requests: Array<{ method: string; ifMatch: string | null }> = [];

  constructor(seed: ProgressState | null) {
    this.content = seed ? `${JSON.stringify(seed)}\n` : null;
  }

  readonly fetch = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    this.requests.push({ method, ifMatch: headers.get('if-match') });
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    expect(url.searchParams.get('path')).toBe(CYCLE_STATE_PATH);
    expect(headers.get('authorization')).toBe('Bearer relayfile-token');
    expect(headers.get('x-correlation-id')).toMatch(/^guardian-state-/);

    if (this.hangMethod === method) return new Promise<Response>(() => undefined);
    if (method === 'GET') {
      if (this.failGetStatus) {
        return new Response(JSON.stringify({ error: 'read denied' }), { status: this.failGetStatus });
      }
      if (this.content === null) return new Response('{}', { status: 404 });
      const content = this.corruptReadBack ? `${JSON.stringify(progressState(1))}\n` : this.content;
      return new Response(
        JSON.stringify({
          path: CYCLE_STATE_PATH,
          revision: `rev-${this.revision}`,
          content,
          encoding: 'utf-8',
        }),
        { status: 200, headers: { ETag: `rev-${this.revision}` } }
      );
    }

    expect(method).toBe('PUT');
    const ifMatch = headers.get('if-match');
    const expected = this.content === null ? '0' : `rev-${this.revision}`;
    if (ifMatch !== expected) return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
    this.content = String(init.body);
    this.revision += 1;
    return new Response(JSON.stringify({ revision: `rev-${this.revision}` }), { status: 200 });
  }) as typeof fetch;

  state(): ProgressState {
    return JSON.parse(this.content ?? '{}') as ProgressState;
  }
}

class IdempotentSlackTransport implements RelayTransport {
  readonly attempts: RelayTransportWriteRequest[] = [];
  providerCreates = 0;
  private readonly results = new Map<string, WritebackResult>();

  async read<T = unknown>(_request: RelayTransportRequest): Promise<T> {
    return undefined as T;
  }

  async list<T = unknown>(_request: RelayTransportRequest): Promise<T[]> {
    return [];
  }

  async write(request: RelayTransportWriteRequest): Promise<WritebackResult> {
    this.attempts.push(request);
    const body = request.body as { idempotencyKey?: string };
    const key = body.idempotencyKey ?? `unkeyed:${this.attempts.length}`;
    const replay = this.results.get(key);
    if (replay) return replay;

    this.providerCreates += 1;
    const ts = `171000000${this.providerCreates}.000100`;
    const path = `${request.path}/message-${this.providerCreates}.json`;
    const result: WritebackResult = {
      path,
      absolutePath: path,
      receipt: { externalId: ts, ts },
    };
    this.results.set(key, result);
    return result;
  }
}

class DelayedSlackTransport extends IdempotentSlackTransport {
  constructor(private readonly delayMs: number) {
    super();
  }

  override async write(request: RelayTransportWriteRequest): Promise<WritebackResult> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const result = await super.write(request);
    return {
      ...result,
      receipt: { externalId: '   ', ts: ` ${deliveredSlackTs(result)} ` },
    };
  }
}

class ReceiptlessSlackTransport extends IdempotentSlackTransport {
  override async write(request: RelayTransportWriteRequest): Promise<WritebackResult> {
    this.attempts.push(request);
    return {
      path: '/slack/draft.json',
      absolutePath: '/slack/draft.json',
      receipt: { id: 'mountcmd-without-provider-ts' },
    };
  }
}

function guardianContext(failWriteCall: number): {
  ctx: WorkforceCtx;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  let writeCalls = 0;
  const ctx = {
    agent: { id: 'sim-agent' },
    deployment: { id: 'sim-deployment' },
    persona: {
      inputs: { SLACK_CHANNEL: 'C0AEKNLDNKW' },
      inputSpecs: {},
    },
    sandbox: {
      cwd: '/home/daytona/workspace',
      readFile: vi.fn(async () => manifest),
    },
    files: {
      read: vi.fn(async (path: string) => {
        const contents = files.get(path);
        if (contents === undefined) throw new Error(`ENOENT: ${path}`);
        return contents;
      }),
      write: vi.fn(async (path: string, contents: string) => {
        writeCalls += 1;
        if (writeCalls === failWriteCall) throw new Error('simulated exact-state write failure');
        files.set(path, contents);
      }),
    },
    credentials: {
      tryRequire: vi.fn(() => null),
    },
    llm: {
      complete: vi.fn(async () => 'Is this feature working as expected?'),
    },
    memory: {
      recall: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
    },
    log: vi.fn(),
  } as unknown as WorkforceCtx;
  return { ctx, files };
}

function exactStateContext(seed: string): {
  ctx: WorkforceCtx;
  files: Map<string, string>;
} {
  const files = new Map([[cycleStatePath, seed]]);
  const ctx = {
    agent: { id: 'sim-agent' },
    deployment: { id: 'sim-deployment' },
    persona: {
      inputs: { SLACK_CHANNEL: 'C0AEKNLDNKW' },
      inputSpecs: {},
    },
    sandbox: {
      cwd: '/home/daytona/workspace',
      readFile: vi.fn(async () => manifest),
    },
    files: {
      read: vi.fn(async (path: string) => {
        const contents = files.get(path);
        if (contents === undefined) throw new Error(`ENOENT: ${path}`);
        return contents;
      }),
      write: vi.fn(async (path: string, contents: string) => {
        files.set(path, contents);
      }),
    },
    credentials: {
      tryRequire: vi.fn(() => null),
    },
    llm: {
      complete: vi.fn(async () => 'Is this feature working as expected?'),
    },
    memory: {
      recall: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
    },
    log: vi.fn(),
  } as unknown as WorkforceCtx;
  return { ctx, files };
}

describe('relay-feature-guardian runtime paths', () => {
  it('reads the manifest from the cloned relay repository', () => {
    expect(resolveManifestPath('/home/daytona/workspace')).toBe(
      '/home/daytona/workspace/github/repos/AgentWorkforce/relay/.agentworkforce/features/manifest.yaml'
    );
  });

  it('defaults delivery to the relay feature-check channel', () => {
    expect(persona.inputs.SLACK_CHANNEL.default).toBe('C0AEKNLDNKW');
  });

  it('deduplicates an ambiguous post retry and advances after a saved receipt', async () => {
    const transport = new IdempotentSlackTransport();
    const restore = bindPreviewTransport(transport);
    const { ctx, files } = guardianContext(2);

    try {
      // Run 1: the provider delivers Start Broker, then the exact progress
      // checkpoint fails. Only the pre-post empty cycle remains.
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(1);
      expect(JSON.parse(files.get(cycleStatePath) ?? '{}').checkedIds).toEqual([]);

      // Run 2: the same feature uses the same deterministic key, so the
      // provider receipt is replayed rather than creating a duplicate post.
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(1);
      expect(transport.attempts).toHaveLength(2);
      const firstBody = transport.attempts[0].body as { idempotencyKey: string };
      const retryBody = transport.attempts[1].body as { idempotencyKey: string };
      expect(retryBody.idempotencyKey).toBe(firstBody.idempotencyKey);

      const completed = JSON.parse(files.get(cycleStatePath) ?? '{}') as {
        checkedIds: string[];
        lastPost?: { featureId: string; ts: string };
      };
      expect(completed.checkedIds).toEqual(['broker-up']);
      expect(completed.lastPost).toEqual({
        featureId: 'broker-up',
        ts: '1710000001.000100',
      });

      // Run 3: persisted progress selects the next feature in the cycle.
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(2);
      const advanced = JSON.parse(files.get(cycleStatePath) ?? '{}') as {
        checkedIds: string[];
      };
      expect(advanced.checkedIds).toEqual(['broker-up', 'broker-status']);
    } finally {
      restore();
    }
  });

  it('does not post when the initial cycle checkpoint has no receipt', async () => {
    const transport = new IdempotentSlackTransport();
    const restore = bindPreviewTransport(transport);
    const { ctx, files } = guardianContext(1);

    try {
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(0);
      expect(files.size).toBe(0);
      expect(ctx.log).toHaveBeenCalledWith(
        'error',
        'relay-feature-guardian.cycle-checkpoint-failed',
        expect.objectContaining({ err: expect.stringContaining('simulated exact-state write failure') })
      );
    } finally {
      restore();
    }
  });

  it('loads exact cycle state and advances 2/122 then 3/122 across fresh runs', async () => {
    const transport = new IdempotentSlackTransport();
    const restore = bindPreviewTransport(transport);
    const { ctx, files } = exactStateContext(
      JSON.stringify({
        kind: 'relay-feature-guardian:progress',
        version: 3,
        generation: 1,
        checkedIds: ['broker-up'],
        cycleStartedAt: '2026-07-18T10:26:47.981Z',
        totalFeatures: 122,
        lastPost: { featureId: 'broker-up', ts: '1784370419.029509' },
      })
    );

    try {
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.attempts).toHaveLength(1);
      expect((transport.attempts[0].body as { text: string }).text).toContain(
        'relay feature check · 2/122 · 120 remaining in cycle'
      );
      expect(JSON.parse(files.get(cycleStatePath) ?? '{}').checkedIds).toEqual([
        'broker-up',
        'broker-status',
      ]);

      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.attempts).toHaveLength(2);
      expect((transport.attempts[1].body as { text: string }).text).toContain(
        'relay feature check · 3/122 · 119 remaining in cycle'
      );
      expect(JSON.parse(files.get(cycleStatePath) ?? '{}').checkedIds).toEqual([
        'broker-up',
        'broker-status',
        'broker-down',
      ]);
      expect(ctx.memory.recall).not.toHaveBeenCalled();
      expect(ctx.memory.save).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('reconciles the manifest total without losing exact progress or lastPost', async () => {
    const transport = new IdempotentSlackTransport();
    const restore = bindPreviewTransport(transport);
    const staleTotal = { ...progressState(1), totalFeatures: 121 };
    const { ctx, files } = exactStateContext(JSON.stringify(staleTotal));
    try {
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      const state = JSON.parse(files.get(CYCLE_STATE_PATH) ?? '{}') as ProgressState;
      expect(state.totalFeatures).toBe(122);
      expect(state.checkedIds).toEqual(['broker-up', 'broker-status']);
      expect(state.lastPost?.featureId).toBe('broker-status');
    } finally {
      restore();
    }
  });

  it('fails closed outside invoke simulation when Relayfile credentials are absent', async () => {
    const transport = new IdempotentSlackTransport();
    const restore = bindPreviewTransport(transport);
    const { ctx } = exactStateContext(JSON.stringify(progressState(1)));
    (ctx.agent as { id: string }).id = 'deployed-agent';
    (ctx.deployment as { id: string }).id = 'deployed-run';
    try {
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.attempts).toHaveLength(0);
      expect(ctx.log).toHaveBeenCalledWith(
        'error',
        'relay-feature-guardian.progress-load-failed',
        expect.objectContaining({ err: expect.stringContaining('exact Relayfile credentials') })
      );
    } finally {
      restore();
    }
  });

  it('scopes provider idempotency to a feature within one cycle', () => {
    expect(featurePostIdempotencyKey('cycle-a', 'start-broker')).toBe(
      featurePostIdempotencyKey('cycle-a', 'start-broker')
    );
    expect(featurePostIdempotencyKey('cycle-a', 'start-broker')).not.toBe(
      featurePostIdempotencyKey('cycle-b', 'start-broker')
    );
  });

  it('requires a delivered Slack ts instead of a draft receipt id', () => {
    expect(deliveredSlackTs(undefined)).toBe('');
    expect(deliveredSlackTs(null)).toBe('');
    expect(
      deliveredSlackTs({
        path: '/draft.json',
        absolutePath: '/draft.json',
        receipt: { id: 'mountcmd-draft', created: 'mountcmd-draft' },
      })
    ).toBe('');
    expect(
      deliveredSlackTs({
        path: '/delivered.json',
        absolutePath: '/delivered.json',
        receipt: { externalId: '1710000001.000100' },
      })
    ).toBe('1710000001.000100');
    expect(
      deliveredSlackTs({
        path: '/delivered-via-ts.json',
        absolutePath: '/delivered-via-ts.json',
        receipt: { externalId: '   ', ts: '1710000002.000200' },
      })
    ).toBe('1710000002.000200');
    expect(
      deliveredSlackTs({
        path: '/invalid-external-id.json',
        absolutePath: '/invalid-external-id.json',
        receipt: { externalId: 'mountcmd-not-a-ts', ts: '1710000003.000300' },
      })
    ).toBe('1710000003.000300');
  });
});

describe('relay-feature-guardian exact HTTP state', () => {
  const credentials = {
    url: 'https://relayfile.test',
    token: 'relayfile-token',
    workspaceId: 'rw_guardian',
  };

  it('bootstraps create-only and updates with the exact loaded revision', async () => {
    const server = new RelayfileStateServer(null);
    const store = createHttpProgressStore(credentials, { fetchImpl: server.fetch });

    expect(await store.load(storeFeatures)).toBeNull();
    const initial = await store.save(progressState(0), null, storeFeatures);
    const completed = await store.save(progressState(1), initial, storeFeatures);

    expect(completed.state.checkedIds).toEqual(['broker-up']);
    expect(server.requests.filter((request) => request.method === 'PUT')).toEqual([
      { method: 'PUT', ifMatch: '0' },
      { method: 'PUT', ifMatch: initial.revision },
    ]);
  });

  it('rejects a stale writer after newer runs checkpoint positions 2 and 3', async () => {
    const server = new RelayfileStateServer(progressState(1));
    const store = createHttpProgressStore(credentials, { fetchImpl: server.fetch });
    const staleA = await store.load(storeFeatures);
    const runB = await store.load(storeFeatures);
    expect(staleA).not.toBeNull();
    expect(runB).not.toBeNull();

    const position2 = await store.save(progressState(2), runB, storeFeatures);
    const runC = await store.load(storeFeatures);
    const position3 = await store.save(progressState(3), runC, storeFeatures);
    await expect(store.save(progressState(2), staleA, storeFeatures)).rejects.toBeInstanceOf(
      ProgressStateConflictError
    );

    expect(position2.state.lastPost?.featureId).toBe('broker-status');
    expect(position3.state.lastPost?.featureId).toBe('broker-down');
    expect(server.state()).toEqual(progressState(3));
  });

  it('does not let an old completed generation overwrite its CAS reset', async () => {
    const server = new RelayfileStateServer(progressState(122));
    const store = createHttpProgressStore(credentials, { fetchImpl: server.fetch });
    const completedGeneration = await store.load(storeFeatures);
    expect(completedGeneration).not.toBeNull();

    const reset = await store.save(progressState(0, 2), completedGeneration, storeFeatures);
    await expect(store.save(progressState(122), completedGeneration, storeFeatures)).rejects.toBeInstanceOf(
      ProgressStateConflictError
    );

    expect(reset.state.generation).toBe(2);
    expect(server.state()).toEqual(progressState(0, 2));
  });

  it('treats only 404 as absent and fails closed on authorization errors', async () => {
    const absent = new RelayfileStateServer(null);
    const absentStore = createHttpProgressStore(credentials, { fetchImpl: absent.fetch });
    expect(await absentStore.load(storeFeatures)).toBeNull();

    const forbidden = new RelayfileStateServer(progressState(1));
    forbidden.failGetStatus = 403;
    const forbiddenStore = createHttpProgressStore(credentials, { fetchImpl: forbidden.fetch });
    await expect(forbiddenStore.load(storeFeatures)).rejects.toThrow('HTTP 403');
  });

  it('bounds a hung GET and a hung PUT with one state transaction deadline', async () => {
    vi.useFakeTimers();
    try {
      const hungGet = new RelayfileStateServer(progressState(1));
      hungGet.hangMethod = 'GET';
      const getStore = createHttpProgressStore(credentials, {
        fetchImpl: hungGet.fetch,
        timeoutMs: 25,
      });
      const getResult = getStore.load(storeFeatures);
      const getRejection = expect(getResult).rejects.toThrow('cycle state load timed out after 25ms');
      await vi.advanceTimersByTimeAsync(26);
      await getRejection;

      const hungPut = new RelayfileStateServer(null);
      hungPut.hangMethod = 'PUT';
      const putStore = createHttpProgressStore(credentials, {
        fetchImpl: hungPut.fetch,
        timeoutMs: 25,
      });
      const putResult = putStore.save(progressState(0), null, storeFeatures);
      const putRejection = expect(putResult).rejects.toThrow('cycle state save timed out after 25ms');
      await vi.advanceTimersByTimeAsync(26);
      await putRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the exact GET read-back does not match the PUT', async () => {
    const server = new RelayfileStateServer(null);
    server.corruptReadBack = true;
    const store = createHttpProgressStore(credentials, { fetchImpl: server.fetch });
    await expect(store.save(progressState(0), null, storeFeatures)).rejects.toThrow(
      'read-back did not match'
    );
  });

  it.each([
    ['duplicate ids', { ...progressState(2), checkedIds: ['broker-up', 'broker-up'] }],
    ['unknown id', { ...progressState(1), checkedIds: ['not-a-feature'] }],
    ['invalid ts', { ...progressState(1), lastPost: { featureId: 'broker-up', ts: 'not-a-slack-ts' } }],
    ['invalid cycle time', { ...progressState(1), cycleStartedAt: 'yesterday' }],
  ])('rejects bounded v3 state with %s', async (_label, invalid) => {
    const server = new RelayfileStateServer(null);
    server.content = `${JSON.stringify(invalid)}\n`;
    const store = createHttpProgressStore(credentials, { fetchImpl: server.fetch });
    await expect(store.load(storeFeatures)).rejects.toThrow(/cycle state/);
  });
});

describe('relay-feature-guardian delayed Slack receipts', () => {
  it('waits beyond the old 3s window and checkpoints only a real trimmed ts', async () => {
    expect(SLACK_WRITEBACK_TIMEOUT_MS).toBe(15_000);
    expect(SLACK_WRITEBACK_POLL_MS).toBe(250);
    vi.useFakeTimers();
    const transport = new DelayedSlackTransport(3_500);
    const restore = bindPreviewTransport(transport);
    const { ctx, files } = exactStateContext(JSON.stringify(progressState(1)));
    try {
      const run = guardian.handler(ctx, { type: 'cron.tick' } as never);
      await vi.advanceTimersByTimeAsync(3_001);
      expect(JSON.parse(files.get(CYCLE_STATE_PATH) ?? '{}').checkedIds).toEqual(['broker-up']);
      await vi.advanceTimersByTimeAsync(500);
      await run;

      const state = JSON.parse(files.get(CYCLE_STATE_PATH) ?? '{}') as ProgressState;
      expect(state.checkedIds).toEqual(['broker-up', 'broker-status']);
      expect(state.lastPost?.ts).toBe('1710000001.000100');
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('never advances on a receipt-shaped draft without provider ts', async () => {
    const transport = new ReceiptlessSlackTransport();
    const restore = bindPreviewTransport(transport);
    const { ctx, files } = exactStateContext(JSON.stringify(progressState(1)));
    try {
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(JSON.parse(files.get(CYCLE_STATE_PATH) ?? '{}').checkedIds).toEqual(['broker-up']);
      expect(ctx.log).toHaveBeenCalledWith('error', 'relay-feature-guardian.post-failed', {
        channel: 'C0AEKNLDNKW',
        feature: 'broker-status',
      });
    } finally {
      restore();
    }
  });
});
