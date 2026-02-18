/**
 * Swarm Coordinator — pattern selection, agent topology, and workflow lifecycle.
 *
 * Orchestrates workflow runs: picks the right swarm pattern (or auto-selects),
 * resolves agent topology from the config, and drives the run through its
 * lifecycle states (pending → running → completed / failed / cancelled).
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AgentDefinition,
  RelayYamlConfig,
  SwarmPattern,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStepRow,
  WorkflowStepStatus,
} from './types.js';

// ── Database interface ──────────────────────────────────────────────────────

/** Minimal database client contract accepted by all services. */
export interface DbClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

// ── Topology types ──────────────────────────────────────────────────────────

/** Describes the communication graph for a set of agents. */
export interface AgentTopology {
  pattern: SwarmPattern;
  agents: AgentDefinition[];
  /** Agent name → names it can send messages to. */
  edges: Map<string, string[]>;
  /** Optional hub agent for hub-spoke / hierarchical. */
  hub?: string;
  /** Ordered pipeline stages (pipeline pattern only). */
  pipelineOrder?: string[];
}

// ── Pattern auto-selection ──────────────────────────────────────────────────

/**
 * Mapping used when auto-selecting a pattern from config heuristics.
 * The coordinator checks the config shape and picks the best match.
 */
const PATTERN_HEURISTICS: Array<{
  test: (config: RelayYamlConfig) => boolean;
  pattern: SwarmPattern;
}> = [
  {
    test: (c) =>
      Array.isArray(c.workflows) &&
      c.workflows.some((w) => w.steps.some((s) => s.dependsOn?.length)),
    pattern: 'dag',
  },
  {
    test: (c) => c.coordination?.consensusStrategy !== undefined,
    pattern: 'consensus',
  },
  {
    test: (c) =>
      Array.isArray(c.workflows) &&
      c.workflows.some((w) => {
        const names = w.steps.map((s) => s.agent);
        return new Set(names).size === names.length && names.length > 2;
      }),
    pattern: 'pipeline',
  },
  {
    test: (c) => c.agents.length > 3 && c.agents.some((a) => a.role === 'lead'),
    pattern: 'hierarchical',
  },
  {
    test: (c) => c.agents.some((a) => a.role === 'hub' || a.role === 'coordinator'),
    pattern: 'hub-spoke',
  },
  {
    // Default: many independent agents → fan-out
    test: () => true,
    pattern: 'fan-out',
  },
];

// ── Coordinator events ──────────────────────────────────────────────────────

export interface SwarmCoordinatorEvents {
  'run:created': (run: WorkflowRunRow) => void;
  'run:started': (run: WorkflowRunRow) => void;
  'run:completed': (run: WorkflowRunRow) => void;
  'run:failed': (run: WorkflowRunRow) => void;
  'run:cancelled': (run: WorkflowRunRow) => void;
  'step:started': (step: WorkflowStepRow) => void;
  'step:completed': (step: WorkflowStepRow) => void;
  'step:failed': (step: WorkflowStepRow) => void;
}

// ── Coordinator ─────────────────────────────────────────────────────────────

export class SwarmCoordinator extends EventEmitter {
  private db: DbClient;

  constructor(db: DbClient) {
    super();
    this.db = db;
  }

  // ── Pattern selection ───────────────────────────────────────────────────

  /**
   * Select the swarm pattern to use for a config. If the config already
   * specifies a pattern, it is returned as-is. Otherwise heuristics apply.
   */
  selectPattern(config: RelayYamlConfig): SwarmPattern {
    if (config.swarm.pattern) {
      return config.swarm.pattern;
    }
    for (const h of PATTERN_HEURISTICS) {
      if (h.test(config)) return h.pattern;
    }
    return 'fan-out';
  }

  // ── Topology resolution ─────────────────────────────────────────────────

  /**
   * Build the agent communication topology for a given config and pattern.
   */
  resolveTopology(config: RelayYamlConfig, pattern?: SwarmPattern): AgentTopology {
    const p = pattern ?? this.selectPattern(config);
    const agents = config.agents;
    const edges = new Map<string, string[]>();
    const names = agents.map((a) => a.name);

    switch (p) {
      case 'fan-out': {
        // Hub (first agent or role=lead) fans out to all others; no inter-worker edges.
        const hub = this.pickHub(agents);
        const others = names.filter((n) => n !== hub);
        edges.set(hub, others);
        for (const o of others) edges.set(o, [hub]);
        return { pattern: p, agents, edges, hub };
      }

      case 'pipeline': {
        // Linear chain following workflow step order or agent list order.
        const order = this.resolvePipelineOrder(config, names);
        for (let i = 0; i < order.length; i++) {
          edges.set(order[i], i < order.length - 1 ? [order[i + 1]] : []);
        }
        return { pattern: p, agents, edges, pipelineOrder: order };
      }

      case 'hub-spoke': {
        const hub = this.pickHub(agents);
        const spokes = names.filter((n) => n !== hub);
        edges.set(hub, spokes);
        for (const s of spokes) edges.set(s, [hub]);
        return { pattern: p, agents, edges, hub };
      }

      case 'consensus':
      case 'debate':
      case 'mesh': {
        // Full mesh — every agent can talk to every other.
        for (const n of names) {
          edges.set(n, names.filter((o) => o !== n));
        }
        return { pattern: p, agents, edges };
      }

      case 'handoff': {
        // Chain with explicit handoff: each agent passes to the next.
        const order = this.resolvePipelineOrder(config, names);
        for (let i = 0; i < order.length; i++) {
          edges.set(order[i], i < order.length - 1 ? [order[i + 1]] : []);
        }
        return { pattern: p, agents, edges, pipelineOrder: order };
      }

      case 'cascade': {
        // Primary tries first; on failure, falls through to next.
        for (let i = 0; i < names.length; i++) {
          edges.set(names[i], i < names.length - 1 ? [names[i + 1]] : []);
        }
        return { pattern: p, agents, edges, pipelineOrder: names };
      }

      case 'dag': {
        // Edges derived from workflow step dependencies.
        const stepEdges = this.resolveDAGEdges(config);
        for (const n of names) {
          if (!stepEdges.has(n)) stepEdges.set(n, []);
        }
        return { pattern: p, agents, edges: stepEdges };
      }

      case 'hierarchical': {
        const hub = this.pickHub(agents);
        const subordinates = names.filter((n) => n !== hub);
        edges.set(hub, subordinates);
        for (const s of subordinates) edges.set(s, [hub]);
        return { pattern: p, agents, edges, hub };
      }

      default: {
        // Fallback: full mesh.
        for (const n of names) {
          edges.set(n, names.filter((o) => o !== n));
        }
        return { pattern: p, agents, edges };
      }
    }
  }

  // ── Lifecycle: create run ───────────────────────────────────────────────

  async createRun(
    workspaceId: string,
    config: RelayYamlConfig,
  ): Promise<WorkflowRunRow> {
    const id = `run_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const pattern = this.selectPattern(config);
    const now = new Date().toISOString();

    const { rows } = await this.db.query<WorkflowRunRow>(
      `INSERT INTO workflow_runs (id, workspace_id, workflow_name, pattern, status, config, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6, $6)
       RETURNING *`,
      [id, workspaceId, config.name, pattern, JSON.stringify(config), now],
    );

    const run = rows[0];
    this.emit('run:created', run);
    return run;
  }

  // ── Lifecycle: start run ────────────────────────────────────────────────

  async startRun(runId: string): Promise<WorkflowRunRow> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<WorkflowRunRow>(
      `UPDATE workflow_runs SET status = 'running', started_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [runId, now],
    );

    if (rows.length === 0) {
      throw new Error(`Run ${runId} not found or not in pending state`);
    }

    const run = rows[0];
    this.emit('run:started', run);
    return run;
  }

  // ── Lifecycle: complete / fail / cancel ─────────────────────────────────

  async completeRun(
    runId: string,
    stateSnapshot?: Record<string, unknown>,
  ): Promise<WorkflowRunRow> {
    return this.transitionRun(runId, 'completed', undefined, stateSnapshot);
  }

  async failRun(runId: string, error: string): Promise<WorkflowRunRow> {
    return this.transitionRun(runId, 'failed', error);
  }

  async cancelRun(runId: string): Promise<WorkflowRunRow> {
    return this.transitionRun(runId, 'cancelled');
  }

  // ── Step management ─────────────────────────────────────────────────────

  async createSteps(
    runId: string,
    config: RelayYamlConfig,
  ): Promise<WorkflowStepRow[]> {
    const workflows = config.workflows ?? [];
    const created: WorkflowStepRow[] = [];

    for (const wf of workflows) {
      for (const step of wf.steps) {
        const id = `step_${Date.now()}_${randomBytes(4).toString('hex')}`;
        const now = new Date().toISOString();

        const { rows } = await this.db.query<WorkflowStepRow>(
          `INSERT INTO workflow_steps (id, run_id, step_name, agent_name, status, task, depends_on, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $7)
           RETURNING *`,
          [
            id,
            runId,
            step.name,
            step.agent,
            step.task,
            JSON.stringify(step.dependsOn ?? []),
            now,
          ],
        );

        created.push(rows[0]);
      }
    }

    return created;
  }

  async startStep(stepId: string): Promise<WorkflowStepRow> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<WorkflowStepRow>(
      `UPDATE workflow_steps SET status = 'running', started_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [stepId, now],
    );

    if (rows.length === 0) {
      throw new Error(`Step ${stepId} not found or not in pending state`);
    }

    const step = rows[0];
    this.emit('step:started', step);
    return step;
  }

  async completeStep(stepId: string, output?: string): Promise<WorkflowStepRow> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<WorkflowStepRow>(
      `UPDATE workflow_steps SET status = 'completed', output = $2, completed_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [stepId, output ?? null, now],
    );

    if (rows.length === 0) {
      throw new Error(`Step ${stepId} not found or not in running state`);
    }

    const step = rows[0];
    this.emit('step:completed', step);
    return step;
  }

  async failStep(stepId: string, error: string): Promise<WorkflowStepRow> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<WorkflowStepRow>(
      `UPDATE workflow_steps SET status = 'failed', error = $2, completed_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [stepId, error, now],
    );

    if (rows.length === 0) {
      throw new Error(`Step ${stepId} not found or not in running state`);
    }

    const step = rows[0];
    this.emit('step:failed', step);
    return step;
  }

  async skipStep(stepId: string): Promise<WorkflowStepRow> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<WorkflowStepRow>(
      `UPDATE workflow_steps SET status = 'skipped', completed_at = $2, updated_at = $2
       WHERE id = $1
       RETURNING *`,
      [stepId, now],
    );

    if (rows.length === 0) {
      throw new Error(`Step ${stepId} not found`);
    }

    return rows[0];
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  async getRun(runId: string): Promise<WorkflowRunRow | null> {
    const { rows } = await this.db.query<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE id = $1`,
      [runId],
    );
    return rows[0] ?? null;
  }

  async getSteps(runId: string): Promise<WorkflowStepRow[]> {
    const { rows } = await this.db.query<WorkflowStepRow>(
      `SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return rows;
  }

  async getReadySteps(runId: string): Promise<WorkflowStepRow[]> {
    const steps = await this.getSteps(runId);
    const completedNames = new Set(
      steps.filter((s) => s.status === 'completed').map((s) => s.stepName),
    );

    return steps.filter((s) => {
      if (s.status !== 'pending') return false;
      const deps: string[] = Array.isArray(s.dependsOn) ? s.dependsOn : [];
      return deps.every((d) => completedNames.has(d));
    });
  }

  async getRunsByWorkspace(
    workspaceId: string,
    status?: WorkflowRunStatus,
  ): Promise<WorkflowRunRow[]> {
    if (status) {
      const { rows } = await this.db.query<WorkflowRunRow>(
        `SELECT * FROM workflow_runs WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC`,
        [workspaceId, status],
      );
      return rows;
    }
    const { rows } = await this.db.query<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    );
    return rows;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async transitionRun(
    runId: string,
    status: WorkflowRunStatus,
    error?: string,
    stateSnapshot?: Record<string, unknown>,
  ): Promise<WorkflowRunRow> {
    const now = new Date().toISOString();
    const { rows } = await this.db.query<WorkflowRunRow>(
      `UPDATE workflow_runs
       SET status = $2, completed_at = $3, error = $4, state_snapshot = $5, updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [
        runId,
        status,
        now,
        error ?? null,
        stateSnapshot ? JSON.stringify(stateSnapshot) : null,
      ],
    );

    if (rows.length === 0) {
      throw new Error(`Run ${runId} not found`);
    }

    const run = rows[0];
    const eventName = `run:${status}` as keyof SwarmCoordinatorEvents;
    this.emit(eventName, run);
    return run;
  }

  private pickHub(agents: AgentDefinition[]): string {
    const lead = agents.find(
      (a) => a.role === 'lead' || a.role === 'hub' || a.role === 'coordinator',
    );
    return lead?.name ?? agents[0].name;
  }

  private resolvePipelineOrder(
    config: RelayYamlConfig,
    fallback: string[],
  ): string[] {
    const workflow = config.workflows?.[0];
    if (!workflow) return fallback;

    // Use step order — each step's agent in sequence, deduped.
    const seen = new Set<string>();
    const order: string[] = [];
    for (const step of workflow.steps) {
      if (!seen.has(step.agent)) {
        seen.add(step.agent);
        order.push(step.agent);
      }
    }
    return order.length > 0 ? order : fallback;
  }

  private resolveDAGEdges(config: RelayYamlConfig): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    const workflows = config.workflows ?? [];

    for (const wf of workflows) {
      // Build step-name → agent-name mapping.
      const stepAgent = new Map<string, string>();
      for (const step of wf.steps) {
        stepAgent.set(step.name, step.agent);
      }

      for (const step of wf.steps) {
        if (!step.dependsOn?.length) continue;
        for (const dep of step.dependsOn) {
          const fromAgent = stepAgent.get(dep);
          if (!fromAgent) continue;
          const existing = edges.get(fromAgent) ?? [];
          if (!existing.includes(step.agent)) {
            existing.push(step.agent);
          }
          edges.set(fromAgent, existing);
        }
      }
    }

    return edges;
  }
}
