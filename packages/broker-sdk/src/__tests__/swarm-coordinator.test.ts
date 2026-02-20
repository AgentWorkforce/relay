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

    // ── Auto-selection heuristic tests ──────────────────────────────────

    it('should auto-select map-reduce when mapper and reducer roles present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'mapper', cli: 'claude', role: 'mapper' },
          { name: 'reducer', cli: 'claude', role: 'reducer' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('map-reduce');
    });

    it('should auto-select red-team when attacker and defender roles present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'attacker', cli: 'claude', role: 'attacker' },
          { name: 'defender', cli: 'claude', role: 'defender' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('red-team');
    });

    it('should auto-select reflection when critic role present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'producer', cli: 'claude' },
          { name: 'critic', cli: 'claude', role: 'critic' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('reflection');
    });

    it('should auto-select escalation when tier-N roles present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 't1', cli: 'claude', role: 'tier-1' },
          { name: 't2', cli: 'claude', role: 'tier-2' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('escalation');
    });

    it('should auto-select auction when auctioneer role present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'auctioneer', cli: 'claude', role: 'auctioneer' },
          { name: 'bidder', cli: 'claude' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('auction');
    });

    it('should auto-select supervisor when supervisor role present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'supervisor', cli: 'claude', role: 'supervisor' },
          { name: 'worker', cli: 'claude' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('supervisor');
    });

    it('should auto-select verifier when verifier role present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'producer', cli: 'claude' },
          { name: 'verifier', cli: 'claude', role: 'verifier' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('verifier');
    });

    it('should auto-select swarm when hive-mind role present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'hive', cli: 'claude', role: 'hive-mind' },
          { name: 'drone', cli: 'claude' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('swarm');
    });

    it('should auto-select circuit-breaker when fallback role present', () => {
      const config = makeConfig({
        swarm: { pattern: '' as any },
        agents: [
          { name: 'primary', cli: 'claude', role: 'primary' },
          { name: 'fallback', cli: 'claude', role: 'fallback' },
        ],
      });
      expect(coordinator.selectPattern(config)).toBe('circuit-breaker');
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

    // ── Additional pattern tests ────────────────────────────────────────

    it('should build map-reduce topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'map-reduce' },
        agents: [
          { name: 'coordinator', cli: 'claude', role: 'lead' },
          { name: 'mapper-1', cli: 'claude', role: 'mapper' },
          { name: 'mapper-2', cli: 'claude', role: 'mapper' },
          { name: 'reducer', cli: 'claude', role: 'reducer' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('map-reduce');
      expect(topology.hub).toBe('coordinator');
      expect(topology.edges.get('coordinator')).toContain('mapper-1');
      expect(topology.edges.get('mapper-1')).toContain('reducer');
      expect(topology.edges.get('reducer')).toContain('coordinator');
    });

    it('should build scatter-gather topology', () => {
      const config = makeConfig({ swarm: { pattern: 'scatter-gather' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('scatter-gather');
      expect(topology.hub).toBe('leader');
      expect(topology.edges.get('leader')).toContain('worker-1');
      expect(topology.edges.get('worker-1')).toEqual(['leader']);
    });

    it('should build supervisor topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'supervisor' },
        agents: [
          { name: 'supervisor', cli: 'claude', role: 'supervisor' },
          { name: 'worker-1', cli: 'claude' },
          { name: 'worker-2', cli: 'codex' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('supervisor');
      expect(topology.hub).toBe('supervisor');
      expect(topology.edges.get('supervisor')).toContain('worker-1');
      expect(topology.edges.get('worker-1')).toEqual(['supervisor']);
    });

    it('should build reflection topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'reflection' },
        agents: [
          { name: 'producer', cli: 'claude' },
          { name: 'critic', cli: 'claude', role: 'critic' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('reflection');
      expect(topology.edges.get('producer')).toContain('critic');
      expect(topology.edges.get('critic')).toContain('producer');
    });

    it('should build red-team topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'red-team' },
        agents: [
          { name: 'attacker', cli: 'claude', role: 'attacker' },
          { name: 'defender', cli: 'claude', role: 'defender' },
          { name: 'judge', cli: 'claude', role: 'judge' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('red-team');
      expect(topology.edges.get('attacker')).toContain('defender');
      expect(topology.edges.get('defender')).toContain('attacker');
      expect(topology.edges.get('attacker')).toContain('judge');
    });

    it('should build verifier topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'verifier' },
        agents: [
          { name: 'producer', cli: 'claude' },
          { name: 'verifier', cli: 'claude', role: 'verifier' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('verifier');
      expect(topology.edges.get('producer')).toContain('verifier');
      expect(topology.edges.get('verifier')).toContain('producer');
    });

    it('should build auction topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'auction' },
        agents: [
          { name: 'auctioneer', cli: 'claude', role: 'auctioneer' },
          { name: 'bidder-1', cli: 'claude' },
          { name: 'bidder-2', cli: 'codex' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('auction');
      expect(topology.hub).toBe('auctioneer');
      expect(topology.edges.get('auctioneer')).toContain('bidder-1');
      expect(topology.edges.get('bidder-1')).toEqual(['auctioneer']);
    });

    it('should build escalation topology', () => {
      const config = makeConfig({
        swarm: { pattern: 'escalation' },
        agents: [
          { name: 'tier1', cli: 'claude', role: 'tier-1' },
          { name: 'tier2', cli: 'claude', role: 'tier-2' },
          { name: 'tier3', cli: 'claude', role: 'tier-3' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('escalation');
      expect(topology.pipelineOrder).toEqual(['tier1', 'tier2', 'tier3']);
      expect(topology.edges.get('tier1')).toContain('tier2');
      expect(topology.edges.get('tier2')).toContain('tier3');
    });

    it('should build saga topology', () => {
      const config = makeConfig({ swarm: { pattern: 'saga' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('saga');
      expect(topology.hub).toBe('leader');
      expect(topology.edges.get('leader')).toContain('worker-1');
      expect(topology.edges.get('worker-1')).toEqual(['leader']);
    });

    it('should build circuit-breaker topology', () => {
      const config = makeConfig({ swarm: { pattern: 'circuit-breaker' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('circuit-breaker');
      expect(topology.pipelineOrder).toEqual(['leader', 'worker-1', 'worker-2']);
      expect(topology.edges.get('leader')).toEqual(['worker-1']);
      expect(topology.edges.get('worker-2')).toEqual([]);
    });

    it('should build blackboard topology', () => {
      const config = makeConfig({ swarm: { pattern: 'blackboard' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('blackboard');
      // Full mesh for blackboard
      expect(topology.edges.get('leader')).toContain('worker-1');
      expect(topology.edges.get('worker-1')).toContain('leader');
    });

    it('should build swarm topology with neighbor communication', () => {
      const config = makeConfig({ swarm: { pattern: 'swarm' } });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('swarm');
      // Middle agent should have two neighbors
      expect(topology.edges.get('worker-1')).toContain('leader');
      expect(topology.edges.get('worker-1')).toContain('worker-2');
    });

    // ── Edge case tests ─────────────────────────────────────────────────

    it('should handle map-reduce with no reducers (fallback to coordinator)', () => {
      const config = makeConfig({
        swarm: { pattern: 'map-reduce' },
        agents: [
          { name: 'coordinator', cli: 'claude', role: 'lead' },
          { name: 'mapper-1', cli: 'claude', role: 'mapper' },
          { name: 'mapper-2', cli: 'claude', role: 'mapper' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('map-reduce');
      // Mappers should fallback to coordinator when no reducers
      expect(topology.edges.get('mapper-1')).toContain('coordinator');
    });

    it('should handle verifier with no verifiers (empty edges)', () => {
      const config = makeConfig({
        swarm: { pattern: 'verifier' },
        agents: [
          { name: 'producer-1', cli: 'claude' },
          { name: 'producer-2', cli: 'claude' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('verifier');
      // Producers have no one to send to
      expect(topology.edges.get('producer-1')).toEqual([]);
    });

    it('should handle escalation with no tier roles (use agent order)', () => {
      const config = makeConfig({
        swarm: { pattern: 'escalation' },
        agents: [
          { name: 'agent-1', cli: 'claude' },
          { name: 'agent-2', cli: 'claude' },
          { name: 'agent-3', cli: 'claude' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('escalation');
      expect(topology.pipelineOrder).toEqual(['agent-1', 'agent-2', 'agent-3']);
    });

    it('should handle reflection with no critic (fallback to mesh)', () => {
      const config = makeConfig({
        swarm: { pattern: 'reflection' },
        agents: [
          { name: 'agent-1', cli: 'claude' },
          { name: 'agent-2', cli: 'claude' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('reflection');
      // Falls back to full mesh when no critic
      expect(topology.edges.get('agent-1')).toContain('agent-2');
      expect(topology.edges.get('agent-2')).toContain('agent-1');
    });

    it('should handle swarm with hive-mind role', () => {
      const config = makeConfig({
        swarm: { pattern: 'swarm' },
        agents: [
          { name: 'hive', cli: 'claude', role: 'hive-mind' },
          { name: 'drone-1', cli: 'claude' },
          { name: 'drone-2', cli: 'claude' },
          { name: 'drone-3', cli: 'claude' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('swarm');
      expect(topology.hub).toBe('hive');
      // All drones should connect to hive mind
      expect(topology.edges.get('drone-1')).toContain('hive');
      expect(topology.edges.get('drone-2')).toContain('hive');
    });

    it('should exclude non-interactive agents from message edges', () => {
      const config = makeConfig({
        swarm: { pattern: 'fan-out' },
        agents: [
          { name: 'leader', cli: 'claude', role: 'lead' },
          { name: 'worker-1', cli: 'codex', interactive: false },
          { name: 'worker-2', cli: 'claude' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('fan-out');
      // leader should only message worker-2 (not worker-1 which is non-interactive)
      expect(topology.edges.get('leader')).toEqual(['worker-2']);
      // worker-1 should have empty edges (non-interactive)
      expect(topology.edges.get('worker-1')).toEqual([]);
      // worker-2 should only message leader
      expect(topology.edges.get('worker-2')).toEqual(['leader']);
      // All agents should still be in the topology
      expect(topology.agents).toHaveLength(3);
    });

    it('should exclude non-interactive agents from DAG topology edges', () => {
      const config = makeConfig({
        swarm: { pattern: 'dag' },
        agents: [
          { name: 'leader', cli: 'claude', role: 'lead' },
          { name: 'worker-1', cli: 'codex', interactive: false },
          { name: 'worker-2', cli: 'claude' },
        ],
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'worker-1', task: 'x' },
              { name: 's2', agent: 'worker-2', task: 'y', dependsOn: ['s1'] },
              { name: 's3', agent: 'leader', task: 'z', dependsOn: ['s2'] },
            ],
          },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('dag');
      // worker-1 is non-interactive — should have empty edges even though s2 depends on s1
      expect(topology.edges.get('worker-1')).toEqual([]);
      // worker-2 should NOT have worker-1 as a target (non-interactive)
      const worker2Targets = topology.edges.get('worker-2') ?? [];
      expect(worker2Targets).not.toContain('worker-1');
      // worker-2 should still point to leader
      expect(worker2Targets).toContain('leader');
    });

    it('should handle all non-interactive agents gracefully', () => {
      const config = makeConfig({
        swarm: { pattern: 'fan-out' },
        agents: [
          { name: 'leader', cli: 'claude', role: 'lead' },
          { name: 'worker-1', cli: 'codex', interactive: false },
          { name: 'worker-2', cli: 'codex', interactive: false },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      // leader is the only interactive agent, so it fans out to no one
      expect(topology.edges.get('leader')).toEqual([]);
      expect(topology.edges.get('worker-1')).toEqual([]);
      expect(topology.edges.get('worker-2')).toEqual([]);
    });

    it('should handle red-team with multiple attackers and defenders', () => {
      const config = makeConfig({
        swarm: { pattern: 'red-team' },
        agents: [
          { name: 'attacker-1', cli: 'claude', role: 'attacker' },
          { name: 'attacker-2', cli: 'claude', role: 'attacker' },
          { name: 'defender-1', cli: 'claude', role: 'defender' },
          { name: 'defender-2', cli: 'claude', role: 'defender' },
        ],
      });
      const topology = coordinator.resolveTopology(config);
      expect(topology.pattern).toBe('red-team');
      // Attackers should reach all defenders
      expect(topology.edges.get('attacker-1')).toContain('defender-1');
      expect(topology.edges.get('attacker-1')).toContain('defender-2');
      // Defenders should reach all attackers
      expect(topology.edges.get('defender-1')).toContain('attacker-1');
      expect(topology.edges.get('defender-1')).toContain('attacker-2');
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
