import { readFileSync } from 'node:fs';
import type { MemoryItem, WorkforceCtx } from '@agentworkforce/runtime';
import {
  bindPreviewTransport,
  type RelayTransport,
  type RelayTransportRequest,
  type RelayTransportWriteRequest,
  type WritebackResult,
} from '@relayfile/relay-helpers';
import { describe, expect, it, vi } from 'vitest';
import guardian, { deliveredSlackTs, featurePostIdempotencyKey, resolveManifestPath } from './agent.ts';

const persona = JSON.parse(readFileSync(new URL('./persona.json', import.meta.url), 'utf8')) as {
  inputs: { SLACK_CHANNEL: { default: string } };
};

const manifest = `
version: '1'
categories:
  core:
    name: Core
    criticality: critical
    features:
      - id: start-broker
        name: Start Broker
        cli: relay node up
        description: Starts the local broker.
        verify_tier: 1
      - id: stop-broker
        name: Stop Broker
        cli: relay node down
        description: Stops the local broker.
        verify_tier: 1
`;

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

function guardianContext(failSaveCall: number): {
  ctx: WorkforceCtx;
  memoryItems: MemoryItem[];
} {
  const memoryItems: MemoryItem[] = [];
  let saveCalls = 0;
  const ctx = {
    persona: {
      inputs: { SLACK_CHANNEL: 'C0AEKNLDNKW' },
      inputSpecs: {},
    },
    sandbox: {
      cwd: '/home/daytona/workspace',
      readFile: vi.fn(async () => manifest),
    },
    llm: {
      complete: vi.fn(async () => 'Is this feature working as expected?'),
    },
    memory: {
      recall: vi.fn(async () => [...memoryItems]),
      save: vi.fn(async (content: string, options?: { tags?: string[]; scope?: string }) => {
        saveCalls += 1;
        if (saveCalls === failSaveCall) return undefined;
        const id = `memory-${saveCalls}`;
        memoryItems.push({
          id,
          content,
          tags: options?.tags ?? [],
          scope: 'workspace',
          createdAt: new Date(Date.UTC(2026, 6, 18, 0, 0, saveCalls)).toISOString(),
        });
        return { id };
      }),
    },
    log: vi.fn(),
  } as unknown as WorkforceCtx;
  return { ctx, memoryItems };
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
    const { ctx, memoryItems } = guardianContext(2);

    try {
      // Run 1: the provider delivers Start Broker, then the progress save
      // silently returns undefined. Only the pre-post cycle checkpoint remains.
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(1);
      expect(memoryItems).toHaveLength(1);
      expect(JSON.parse(memoryItems[0].content).checkedIds).toEqual([]);

      // Run 2: the same feature uses the same deterministic key, so the
      // provider receipt is replayed rather than creating a duplicate post.
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(1);
      expect(transport.attempts).toHaveLength(2);
      const firstBody = transport.attempts[0].body as { idempotencyKey: string };
      const retryBody = transport.attempts[1].body as { idempotencyKey: string };
      expect(retryBody.idempotencyKey).toBe(firstBody.idempotencyKey);

      const completed = JSON.parse(memoryItems.at(-1)?.content ?? '{}') as {
        checkedIds: string[];
        lastPost?: { featureId: string; ts: string };
      };
      expect(completed.checkedIds).toEqual(['start-broker']);
      expect(completed.lastPost).toEqual({
        featureId: 'start-broker',
        ts: '1710000001.000100',
      });

      // Run 3: persisted progress selects the next feature in the cycle.
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(2);
      const advanced = JSON.parse(memoryItems.at(-1)?.content ?? '{}') as {
        checkedIds: string[];
      };
      expect(advanced.checkedIds).toEqual(['start-broker', 'stop-broker']);
    } finally {
      restore();
    }
  });

  it('does not post when the initial cycle checkpoint has no receipt', async () => {
    const transport = new IdempotentSlackTransport();
    const restore = bindPreviewTransport(transport);
    const { ctx, memoryItems } = guardianContext(1);

    try {
      await guardian.handler(ctx, { type: 'cron.tick' } as never);
      expect(transport.providerCreates).toBe(0);
      expect(memoryItems).toEqual([]);
      expect(ctx.log).toHaveBeenCalledWith('error', 'relay-feature-guardian.cycle-checkpoint-failed', {
        feature: 'start-broker',
      });
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
  });
});
