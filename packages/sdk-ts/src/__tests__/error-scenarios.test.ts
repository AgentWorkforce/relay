/**
 * Error scenario tests across all swarm workflow services.
 *
 * Tests failure modes, edge cases, and error propagation in
 * StateStore, BarrierManager, SwarmCoordinator, and WorkflowRunner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../workflows/state.js';
import { BarrierManager } from '../workflows/barrier.js';
import { SwarmCoordinator } from '../workflows/coordinator.js';
import type { DbClient } from '../workflows/coordinator.js';
import type { BarrierRow } from '../workflows/barrier.js';
import type { StateEntry } from '../workflows/state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

// ── StateStore error scenarios ───────────────────────────────────────────────

describe('StateStore error scenarios', () => {
  let db: DbClient;
  let store: StateStore;

  beforeEach(() => {
    db = makeDb();
    store = new StateStore(db);
  });

  describe('consensus gating', () => {
    it('should reject writes when consensus gate returns false', async () => {
      store.setConsensusGate(async () => false);

      await expect(
        store.set('run_1', 'key', 'value', 'agent-1'),
      ).rejects.toThrow('rejected by consensus gate');
    });

    it('should emit state:gated event on rejection', async () => {
      const spy = vi.fn();
      store.on('state:gated', spy);
      store.setConsensusGate(async () => false);

      await store.set('run_1', 'key', 'value', 'agent-1').catch(() => {});

      expect(spy).toHaveBeenCalledWith('run_1', 'key', 'agent-1');
    });

    it('should allow writes when consensus gate returns true', async () => {
      const entry: StateEntry = {
        id: 'st_1',
        runId: 'run_1',
        namespace: 'default',
        key: 'key',
        value: 'value',
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [entry] });
      store.setConsensusGate(async () => true);

      const result = await store.set('run_1', 'key', 'value', 'agent-1');
      expect(result).toEqual(entry);
    });

    it('should clear consensus gate', async () => {
      store.setConsensusGate(async () => false);
      store.clearConsensusGate();

      const entry: StateEntry = {
        id: 'st_1',
        runId: 'run_1',
        namespace: 'default',
        key: 'key',
        value: 'value',
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [entry] });

      await expect(store.set('run_1', 'key', 'value', 'agent-1')).resolves.toBeDefined();
    });
  });

  describe('DB failures', () => {
    it('should propagate DB errors on set', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(new Error('connection lost'));
      await expect(store.set('run_1', 'key', 'v', 'agent')).rejects.toThrow('connection lost');
    });

    it('should propagate DB errors on get', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(new Error('timeout'));
      await expect(store.get('run_1', 'key')).rejects.toThrow('timeout');
    });

    it('should propagate DB errors on delete', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(new Error('disk full'));
      await expect(store.delete('run_1', 'key')).rejects.toThrow('disk full');
    });
  });

  describe('namespace isolation', () => {
    it('should use custom namespace when provided', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await store.get('run_1', 'key', { namespace: 'custom' });
      expect(db.query).toHaveBeenCalledWith(
        expect.any(String),
        ['run_1', 'custom', 'key'],
      );
    });

    it('should use default namespace when not provided', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await store.get('run_1', 'key');
      expect(db.query).toHaveBeenCalledWith(
        expect.any(String),
        ['run_1', 'default', 'key'],
      );
    });
  });

  describe('TTL', () => {
    it('should set expiresAt when ttlMs provided', async () => {
      const entry: StateEntry = {
        id: 'st_1',
        runId: 'run_1',
        namespace: 'default',
        key: 'key',
        value: 'v',
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [entry] });

      const result = await store.set('run_1', 'key', 'v', 'agent', { ttlMs: 5000 });
      expect(result.expiresAt).not.toBeNull();
    });
  });

  describe('event emission', () => {
    it('should emit state:set on successful write', async () => {
      const entry: StateEntry = {
        id: 'st_1',
        runId: 'run_1',
        namespace: 'default',
        key: 'key',
        value: 'v',
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [entry] });

      const spy = vi.fn();
      store.on('state:set', spy);

      await store.set('run_1', 'key', 'v', 'agent');
      expect(spy).toHaveBeenCalledWith(entry);
    });

    it('should emit state:deleted on successful delete', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ id: 'st_1' }] });

      const spy = vi.fn();
      store.on('state:deleted', spy);

      await store.delete('run_1', 'key');
      expect(spy).toHaveBeenCalledWith('run_1', 'key', 'default');
    });

    it('should not emit state:deleted when key not found', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });

      const spy = vi.fn();
      store.on('state:deleted', spy);

      await store.delete('run_1', 'key');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('snapshot', () => {
    it('should return empty object for no entries', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      const snapshot = await store.snapshot('run_1');
      expect(snapshot).toEqual({});
    });

    it('should build key-value map from entries', async () => {
      const entries: StateEntry[] = [
        { id: '1', runId: 'run_1', namespace: 'default', key: 'a', value: 1, expiresAt: null, createdAt: '', updatedAt: '' },
        { id: '2', runId: 'run_1', namespace: 'default', key: 'b', value: 'hello', expiresAt: null, createdAt: '', updatedAt: '' },
      ];
      vi.mocked(db.query).mockResolvedValueOnce({ rows: entries });

      const snapshot = await store.snapshot('run_1');
      expect(snapshot).toEqual({ a: 1, b: 'hello' });
    });
  });
});

// ── BarrierManager error scenarios ───────────────────────────────────────────

describe('BarrierManager error scenarios', () => {
  let db: DbClient;
  let manager: BarrierManager;

  beforeEach(() => {
    db = makeDb();
    manager = new BarrierManager(db);
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('barrier creation', () => {
    it('should create barrier and emit barrier:created', async () => {
      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'test-barrier',
        waitFor: ['agent-a', 'agent-b'],
        resolved: [],
        isSatisfied: false,
        timeoutMs: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [barrier] });

      const spy = vi.fn();
      manager.on('barrier:created', spy);

      const result = await manager.createBarrier('run_1', {
        name: 'test-barrier',
        waitFor: ['agent-a', 'agent-b'],
      });

      expect(result.barrierName).toBe('test-barrier');
      expect(spy).toHaveBeenCalledWith(barrier);
    });

    it('should create multiple barriers in batch', async () => {
      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'b1',
        waitFor: ['a'],
        resolved: [],
        isSatisfied: false,
        timeoutMs: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(db.query).mockResolvedValue({ rows: [barrier] });

      const results = await manager.createBarriers('run_1', [
        { name: 'b1', waitFor: ['a'] },
        { name: 'b2', waitFor: ['b'] },
      ]);

      expect(results).toHaveLength(2);
    });
  });

  describe('barrier resolution', () => {
    it('should resolve barrier and check satisfaction (all mode)', async () => {
      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'b1',
        waitFor: ['agent-a', 'agent-b'],
        resolved: ['agent-a'],
        isSatisfied: false,
        timeoutMs: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // First, create the barrier to set the mode
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [barrier] });
      await manager.createBarrier('run_1', {
        name: 'b1',
        waitFor: ['agent-a', 'agent-b'],
        mode: 'all',
      });

      // Now resolve with partial (not satisfied yet)
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [barrier] });
      const result = await manager.resolve('run_1', 'b1', 'agent-a');
      expect(result.satisfied).toBe(false);
    });

    it('should satisfy barrier in any mode with single resolution', async () => {
      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'b1',
        waitFor: ['agent-a', 'agent-b'],
        resolved: ['agent-a'],
        isSatisfied: false,
        timeoutMs: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Create barrier in "any" mode
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [barrier] });
      await manager.createBarrier('run_1', {
        name: 'b1',
        waitFor: ['agent-a', 'agent-b'],
        mode: 'any',
      });

      // Resolve — should satisfy immediately since mode is "any"
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [barrier] }) // resolve UPDATE
        .mockResolvedValueOnce({ rows: [{ ...barrier, isSatisfied: true }] }); // markSatisfied UPDATE

      const satisfiedSpy = vi.fn();
      manager.on('barrier:satisfied', satisfiedSpy);

      const result = await manager.resolve('run_1', 'b1', 'agent-a');
      expect(result.satisfied).toBe(true);
      expect(satisfiedSpy).toHaveBeenCalled();
    });

    it('should throw when barrier not found during resolve', async () => {
      // resolve UPDATE returns empty
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      // getBarrier also returns empty
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });

      await expect(
        manager.resolve('run_1', 'nonexistent', 'agent-a'),
      ).rejects.toThrow('not found');
    });

    it('should return existing state when barrier already satisfied', async () => {
      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'b1',
        waitFor: ['a'],
        resolved: ['a'],
        isSatisfied: true,
        timeoutMs: null,
        createdAt: '',
        updatedAt: '',
      };

      // resolve UPDATE returns empty (already satisfied, WHERE is_satisfied=FALSE doesn't match)
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      // getBarrier returns the already-satisfied barrier
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [barrier] });

      const result = await manager.resolve('run_1', 'b1', 'a');
      expect(result.satisfied).toBe(true);
    });
  });

  describe('barrier timeout', () => {
    it('should schedule timeout and emit barrier:timeout', async () => {
      vi.useFakeTimers();

      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'b1',
        waitFor: ['a'],
        resolved: [],
        isSatisfied: false,
        timeoutMs: 1000,
        createdAt: '',
        updatedAt: '',
      };

      vi.mocked(db.query).mockResolvedValue({ rows: [barrier] });

      const timeoutSpy = vi.fn();
      manager.on('barrier:timeout', timeoutSpy);

      await manager.createBarrier('run_1', {
        name: 'b1',
        waitFor: ['a'],
        timeoutMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(1100);

      expect(timeoutSpy).toHaveBeenCalledWith(barrier);

      vi.useRealTimers();
    });
  });

  describe('cleanup', () => {
    it('should clear all timeout timers', async () => {
      const barrier: BarrierRow = {
        id: 'bar_1',
        runId: 'run_1',
        barrierName: 'b1',
        waitFor: ['a'],
        resolved: [],
        isSatisfied: false,
        timeoutMs: 60000,
        createdAt: '',
        updatedAt: '',
      };
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [barrier] });

      await manager.createBarrier('run_1', {
        name: 'b1',
        waitFor: ['a'],
        timeoutMs: 60000,
      });

      expect(() => manager.cleanup()).not.toThrow();
    });
  });

  describe('queries', () => {
    it('getBarrier should return null for missing barrier', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      const result = await manager.getBarrier('run_1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('isSatisfied should return false when barrier does not exist', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      const result = await manager.isSatisfied('run_1', 'missing');
      expect(result).toBe(false);
    });

    it('getUnsatisfiedBarriers should query with is_satisfied = FALSE', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await manager.getUnsatisfiedBarriers('run_1');
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('is_satisfied = FALSE'),
        ['run_1'],
      );
    });
  });
});

// ── SwarmCoordinator error scenarios ─────────────────────────────────────────

describe('SwarmCoordinator error scenarios', () => {
  let db: DbClient;
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    db = makeDb();
    coordinator = new SwarmCoordinator(db);
  });

  describe('run lifecycle errors', () => {
    it('should throw when starting a non-pending run', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.startRun('run_1')).rejects.toThrow('not found or not in pending');
    });

    it('should throw when completing a non-existent run', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.completeRun('bad')).rejects.toThrow('not found');
    });

    it('should throw when failing a non-existent run', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.failRun('bad', 'error')).rejects.toThrow('not found');
    });

    it('should throw when cancelling a non-existent run', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.cancelRun('bad')).rejects.toThrow('not found');
    });
  });

  describe('step lifecycle errors', () => {
    it('should throw when starting a non-pending step', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.startStep('step_bad')).rejects.toThrow('not in pending state');
    });

    it('should throw when completing a non-running step', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.completeStep('step_bad')).rejects.toThrow('not in running state');
    });

    it('should throw when failing a non-running step', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.failStep('step_bad', 'err')).rejects.toThrow('not in running state');
    });

    it('should throw when skipping a non-existent step', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.skipStep('step_bad')).rejects.toThrow('not found');
    });
  });

  describe('DB propagation', () => {
    it('should propagate DB errors from createRun', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(new Error('connection refused'));
      await expect(coordinator.createRun('ws-1', {
        version: '1',
        name: 'test',
        swarm: { pattern: 'fan-out' },
        agents: [{ name: 'a', cli: 'claude' }],
      })).rejects.toThrow('connection refused');
    });

    it('should propagate DB errors from getSteps', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(new Error('query timeout'));
      await expect(coordinator.getSteps('run_1')).rejects.toThrow('query timeout');
    });
  });
});

// ── WorkflowRunner error scenarios ───────────────────────────────────────────

describe('WorkflowRunner error scenarios', () => {
  // Mock AgentRelay for runner tests
  const mockAgent = {
    name: 'test-agent',
    waitForExit: vi.fn().mockResolvedValue(0),
    release: vi.fn(),
  };

  vi.mock('@agent-relay/sdk-ts/relay', () => ({
    AgentRelay: vi.fn().mockImplementation(() => ({
      spawnPty: vi.fn().mockResolvedValue(mockAgent),
      human: vi.fn().mockReturnValue({ sendMessage: vi.fn() }),
      shutdown: vi.fn(),
    })),
  }));

  let WorkflowRunner: any;
  let db: any;
  let runner: any;

  beforeEach(async () => {
    const mod = await import('../workflows/runner.js');
    WorkflowRunner = mod.WorkflowRunner;

    const runs = new Map();
    const steps = new Map();

    db = {
      insertRun: vi.fn(async (run: any) => runs.set(run.id, { ...run })),
      updateRun: vi.fn(async (id: string, patch: any) => {
        const existing = runs.get(id);
        if (existing) runs.set(id, { ...existing, ...patch });
      }),
      getRun: vi.fn(async (id: string) => runs.get(id) ?? null),
      insertStep: vi.fn(async (step: any) => steps.set(step.id, { ...step })),
      updateStep: vi.fn(async (id: string, patch: any) => {
        const existing = steps.get(id);
        if (existing) steps.set(id, { ...existing, ...patch });
      }),
      getStepsByRunId: vi.fn(async (runId: string) => {
        return [...steps.values()].filter((s: any) => s.runId === runId);
      }),
    };

    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });
  });

  describe('validation errors', () => {
    it('should reject non-object config', () => {
      expect(() => runner.validateConfig('string')).toThrow('non-null object');
      expect(() => runner.validateConfig(42)).toThrow('non-null object');
      expect(() => runner.validateConfig(undefined)).toThrow('non-null object');
    });

    it('should reject config without swarm', () => {
      expect(() =>
        runner.validateConfig({ version: '1', name: 'x', agents: [{ name: 'a', cli: 'claude' }] }),
      ).toThrow('missing required field "swarm"');
    });

    it('should reject config with null swarm', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: null,
          agents: [{ name: 'a', cli: 'claude' }],
        }),
      ).toThrow('missing required field "swarm"');
    });

    it('should reject workflows with non-object steps', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', cli: 'claude' }],
          workflows: [{ name: 'wf', steps: ['not-an-object'] }],
        }),
      ).toThrow('each step must be an object');
    });

    it('should reject step missing required fields', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', cli: 'claude' }],
          workflows: [{ name: 'wf', steps: [{ name: 's1', agent: 'a' }] }],
        }),
      ).toThrow('each step must have "name", "agent", and "task"');
    });
  });

  describe('variable resolution errors', () => {
    it('should throw on unresolved variable in agent task', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { pattern: 'dag' as const },
        agents: [{ name: 'a', cli: 'claude' as const, task: 'Fix {{bug}}' }],
      };
      expect(() => runner.resolveVariables(config, {})).toThrow('Unresolved variable: {{bug}}');
    });

    it('should throw on unresolved variable in workflow step task', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { pattern: 'dag' as const },
        agents: [{ name: 'a', cli: 'claude' as const }],
        workflows: [{
          name: 'wf',
          steps: [{ name: 's1', agent: 'a', task: 'Deploy to {{env}}' }],
        }],
      };
      expect(() => runner.resolveVariables(config, {})).toThrow('Unresolved variable: {{env}}');
    });
  });

  describe('execution errors', () => {
    it('should fail run when workflow not found by name', async () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { pattern: 'dag' as const },
        agents: [{ name: 'a', cli: 'claude' as const }],
        workflows: [{ name: 'wf1', steps: [{ name: 's1', agent: 'a', task: 'x' }] }],
      };

      await expect(runner.execute(config, 'nonexistent')).rejects.toThrow('not found');
    });

    it('should fail run when config has no workflows', async () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { pattern: 'dag' as const },
        agents: [{ name: 'a', cli: 'claude' as const }],
      };

      await expect(runner.execute(config)).rejects.toThrow('No workflows defined');
    });
  });

  describe('resume errors', () => {
    it('should throw when resuming non-existent run', async () => {
      await expect(runner.resume('bad_id')).rejects.toThrow('not found');
    });
  });
});
