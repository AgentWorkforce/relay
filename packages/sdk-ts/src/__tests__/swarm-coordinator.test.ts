/**
 * SwarmCoordinator integration tests.
 *
 * Tests pattern selection, topology resolution, run lifecycle,
 * and step management with a mocked DbClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwarmCoordinator } from '../workflows/coordinator.js';
import type { DbClient } from '../workflows/coordinator.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../workflows/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

function makeConfig(overrides: Partial<RelayYamlConfig> = {}): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-workflow',
    swarm: { pattern: 'fan-out' },
    agents: [
      { name: 'leader', cli: 'claude', role: 'lead' },
      { name: 'worker-1', cli: 'claude' },
      { name: 'worker-2', cli: 'codex' },
    ],
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  const now = new Date().toISOString();
  return {
    id: 'run_test_1',
    workspaceId: 'ws-1',
    workflowName: 'test-workflow',
    pattern: 'fan-out',
    status: 'pending',
    config: makeConfig(),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStepRow(overrides: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  const now = new Date().toISOString();
  return {
    id: 'step_test_1',
    runId: 'run_test_1',
    stepName: 'step-1',
    agentName: 'worker-1',
    status: 'pending',
    task: 'Do something',
    dependsOn: [],
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SwarmCoordinator', () => {
  let db: DbClient;
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    coordinator = new SwarmCoordinator(db);
  });

  // ── Pattern selection ──────────────────────────────────────────────────

  describe('selectPattern', () => {
    it('should return explicit pattern from config', () => {
      expect(coordinator.selectPattern(makeConfig({ swarm: { pattern: 'pipeline' } }))).toBe('pipeline');
    });

    it('should auto-select dag when steps have dependencies', () => {
      const config = makeConfig({
        swarm: { pattern: undefined as unknown as string } as any,
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'worker-1', task: 'x' },
              { name: 's2', agent: 'worker-2', task: 'y', dependsOn: ['s1'] },
            ],
          },
        ],
      });
      // With pattern set explicitly, it returns it; with undefined it falls through heuristics
      // Since config.swarm.pattern is undefined (truthy check fails), heuristics kick in
      config.swarm.pattern = '' as any;
      const pattern = coordinator.selectPattern(config);
      expect(pattern).toBe('dag');
    });

    it('should auto-select consensus when consensusStrategy is set', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        coordination: { consensusStrategy: 'majority' },
      });
      expect(coordinator.selectPattern(config)).toBe('consensus');
    });
  });

  // ── Topology resolution ────────────────────────────────────────────────

  describe('resolveTopology', () => {
    it('should build fan-out topology with hub', () => {
      const topology = coordinator.resolveTopology(makeConfig());
      expect(topology.pattern).toBe('fan-out');
      expect(topology.hub).toBe('leader');
      expect(topology.edges.get('leader')).toEqual(['worker-1', 'worker-2']);
      expect(topology.edges.get('worker-1')).toEqual(['leader']);
    });

    it('should build pipeline topology in step order', () => {
      const config = makeConfig({
        swarm: { pattern: 'pipeline' },
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'worker-1', task: 'step 1' },
              { name: 's2', agent: 'worker-2', task: 'step 2' },
              { name: 's3', agent: 'leader', task: 'step 3' },
            ],
          },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('pipeline');
      expect(topology.pipelineOrder).toEqual(['worker-1', 'worker-2', 'leader']);
      expect(topology.edges.get('worker-1')).toEqual(['worker-2']);
      expect(topology.edges.get('leader')).toEqual([]);
    });

    it('should build hub-spoke topology', () => {
      const config = makeConfig({ swarm: { pattern: 'hub-spoke' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.hub).toBe('leader');
      expect(topology.edges.get('leader')).toContain('worker-1');
      expect(topology.edges.get('worker-1')).toEqual(['leader']);
    });

    it('should build mesh topology for consensus', () => {
      const config = makeConfig({ swarm: { pattern: 'consensus' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.edges.get('leader')).toContain('worker-1');
      expect(topology.edges.get('leader')).toContain('worker-2');
      expect(topology.edges.get('worker-1')).toContain('leader');
    });

    it('should build DAG topology from step dependencies', () => {
      const config = makeConfig({
        swarm: { pattern: 'dag' },
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'worker-1', task: 'x' },
              { name: 's2', agent: 'worker-2', task: 'y', dependsOn: ['s1'] },
            ],
          },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('dag');
      expect(topology.edges.get('worker-1')).toContain('worker-2');
    });

    it('should build hierarchical topology', () => {
      const config = makeConfig({ swarm: { pattern: 'hierarchical' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.hub).toBe('leader');
      expect(topology.edges.get('leader')).toContain('worker-1');
    });

    it('should build cascade topology', () => {
      const config = makeConfig({ swarm: { pattern: 'cascade' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pipelineOrder).toEqual(['leader', 'worker-1', 'worker-2']);
    });
  });

  // ── Run lifecycle ──────────────────────────────────────────────────────

  describe('createRun', () => {
    it('should insert a run and emit run:created', async () => {
      const run = makeRunRow();
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [run] });

      const spy = vi.fn();
      coordinator.on('run:created', spy);

      const result = await coordinator.createRun('ws-1', makeConfig());
      expect(result).toEqual(run);
      expect(spy).toHaveBeenCalledWith(run);
      expect(db.query).toHaveBeenCalledOnce();
    });
  });

  describe('startRun', () => {
    it('should transition pending run to running', async () => {
      const run = makeRunRow({ status: 'running' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [run] });

      const spy = vi.fn();
      coordinator.on('run:started', spy);

      const result = await coordinator.startRun('run_test_1');
      expect(result.status).toBe('running');
      expect(spy).toHaveBeenCalledWith(run);
    });

    it('should throw when run not found', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.startRun('nonexistent')).rejects.toThrow('not found or not in pending state');
    });
  });

  describe('completeRun', () => {
    it('should transition run to completed and emit event', async () => {
      const run = makeRunRow({ status: 'completed' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [run] });

      const spy = vi.fn();
      coordinator.on('run:completed', spy);

      const result = await coordinator.completeRun('run_test_1', { result: 'ok' });
      expect(result.status).toBe('completed');
      expect(spy).toHaveBeenCalledWith(run);
    });

    it('should throw when run not found', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.completeRun('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('failRun', () => {
    it('should transition run to failed with error', async () => {
      const run = makeRunRow({ status: 'failed', error: 'boom' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [run] });

      const spy = vi.fn();
      coordinator.on('run:failed', spy);

      await coordinator.failRun('run_test_1', 'boom');
      expect(spy).toHaveBeenCalledWith(run);
    });
  });

  describe('cancelRun', () => {
    it('should transition run to cancelled', async () => {
      const run = makeRunRow({ status: 'cancelled' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [run] });

      const spy = vi.fn();
      coordinator.on('run:cancelled', spy);

      const result = await coordinator.cancelRun('run_test_1');
      expect(result.status).toBe('cancelled');
    });
  });

  // ── Step management ────────────────────────────────────────────────────

  describe('createSteps', () => {
    it('should create steps from workflow config', async () => {
      const step = makeStepRow();
      vi.mocked(db.query).mockResolvedValue({ rows: [step] });

      const config = makeConfig({
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'worker-1', task: 'x' },
              { name: 's2', agent: 'worker-2', task: 'y' },
            ],
          },
        ],
      });

      const steps = await coordinator.createSteps('run_1', config);
      expect(steps).toHaveLength(2);
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('startStep', () => {
    it('should transition step to running and emit event', async () => {
      const step = makeStepRow({ status: 'running' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [step] });

      const spy = vi.fn();
      coordinator.on('step:started', spy);

      const result = await coordinator.startStep('step_1');
      expect(result.status).toBe('running');
      expect(spy).toHaveBeenCalledWith(step);
    });

    it('should throw for non-pending step', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await expect(coordinator.startStep('bad')).rejects.toThrow('not found or not in pending state');
    });
  });

  describe('completeStep', () => {
    it('should transition step to completed with output', async () => {
      const step = makeStepRow({ status: 'completed', output: 'result data' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [step] });

      const spy = vi.fn();
      coordinator.on('step:completed', spy);

      const result = await coordinator.completeStep('step_1', 'result data');
      expect(result.output).toBe('result data');
      expect(spy).toHaveBeenCalledWith(step);
    });
  });

  describe('failStep', () => {
    it('should transition step to failed with error', async () => {
      const step = makeStepRow({ status: 'failed', error: 'timeout' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [step] });

      const spy = vi.fn();
      coordinator.on('step:failed', spy);

      const result = await coordinator.failStep('step_1', 'timeout');
      expect(result.error).toBe('timeout');
    });
  });

  describe('skipStep', () => {
    it('should mark step as skipped', async () => {
      const step = makeStepRow({ status: 'skipped' });
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [step] });

      const result = await coordinator.skipStep('step_1');
      expect(result.status).toBe('skipped');
    });
  });

  // ── Queries ────────────────────────────────────────────────────────────

  describe('getRun', () => {
    it('should return run or null', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      expect(await coordinator.getRun('nonexistent')).toBeNull();

      const run = makeRunRow();
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [run] });
      expect(await coordinator.getRun('run_test_1')).toEqual(run);
    });
  });

  describe('getReadySteps', () => {
    it('should return pending steps with all dependencies completed', async () => {
      const steps: WorkflowStepRow[] = [
        makeStepRow({ id: 's1', stepName: 'step-1', status: 'completed', dependsOn: [] }),
        makeStepRow({ id: 's2', stepName: 'step-2', status: 'pending', dependsOn: ['step-1'] }),
        makeStepRow({ id: 's3', stepName: 'step-3', status: 'pending', dependsOn: ['step-2'] }),
      ];
      vi.mocked(db.query).mockResolvedValueOnce({ rows: steps });

      const ready = await coordinator.getReadySteps('run_test_1');
      expect(ready).toHaveLength(1);
      expect(ready[0].stepName).toBe('step-2');
    });

    it('should return all pending steps with no dependencies', async () => {
      const steps: WorkflowStepRow[] = [
        makeStepRow({ id: 's1', stepName: 'a', status: 'pending', dependsOn: [] }),
        makeStepRow({ id: 's2', stepName: 'b', status: 'pending', dependsOn: [] }),
      ];
      vi.mocked(db.query).mockResolvedValueOnce({ rows: steps });

      const ready = await coordinator.getReadySteps('run_test_1');
      expect(ready).toHaveLength(2);
    });
  });

  describe('getRunsByWorkspace', () => {
    it('should query by workspace with optional status filter', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await coordinator.getRunsByWorkspace('ws-1', 'running');
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('status = $2'),
        ['ws-1', 'running'],
      );
    });

    it('should query without status filter', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] });
      await coordinator.getRunsByWorkspace('ws-1');
      expect(db.query).toHaveBeenCalledWith(
        expect.not.stringContaining('status ='),
        ['ws-1'],
      );
    });
  });
});
