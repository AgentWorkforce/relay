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
  // ── Dependency-based patterns (highest priority) ──────────────────────
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

  // ── Specific role-based patterns (check before generic hub patterns) ──
  {
    // Map-reduce: requires BOTH mapper AND reducer roles
    test: (c) => c.agents.some((a) => a.role === 'mapper') && c.agents.some((a) => a.role === 'reducer'),
    pattern: 'map-reduce',
  },
  {
    // Red-team: requires BOTH attacker/red-team AND defender/blue-team
    test: (c) => c.agents.some((a) => a.role === 'attacker' || a.role === 'red-team') &&
                 c.agents.some((a) => a.role === 'defender' || a.role === 'blue-team'),
    pattern: 'red-team',
  },
  {
    // Reflection: requires critic role (not just reviewer, which is too common)
    test: (c) => c.agents.some((a) => a.role === 'critic'),
    pattern: 'reflection',
  },
  {
    // Escalation: has tier-N roles
    test: (c) => c.agents.some((a) => a.role?.startsWith('tier-')),
    pattern: 'escalation',
  },
  {
    // Auction: has auctioneer role
    test: (c) => c.agents.some((a) => a.role === 'auctioneer'),
    pattern: 'auction',
  },
  {
    // Saga: has saga-orchestrator or compensate-handler roles
    test: (c) => c.agents.some((a) => a.role === 'saga-orchestrator' || a.role === 'compensate-handler'),
    pattern: 'saga',
  },
  {
    // Circuit-breaker: has fallback or backup roles
    test: (c) => c.agents.some((a) => a.role === 'fallback' || a.role === 'backup' || a.role === 'primary'),
    pattern: 'circuit-breaker',
  },
  {
    // Blackboard: has blackboard or shared-workspace role
    test: (c) => c.agents.some((a) => a.role === 'blackboard' || a.role === 'shared-workspace'),
    pattern: 'blackboard',
  },
  {
    // Swarm: has hive-mind or swarm-agent roles
    test: (c) => c.agents.some((a) => a.role === 'hive-mind' || a.role === 'swarm-agent'),
    pattern: 'swarm',
  },
  {
    // Verifier: has verifier role
    test: (c) => c.agents.some((a) => a.role === 'verifier'),
    pattern: 'verifier',
  },
  {
    // Supervisor: has supervisor role
    test: (c) => c.agents.some((a) => a.role === 'supervisor'),
    pattern: 'supervisor',
  },

  // ── Generic hub-based patterns ────────────────────────────────────────
  {
    test: (c) => c.agents.length > 3 && c.agents.some((a) => a.role === 'lead'),
    pattern: 'hierarchical',
  },
  {
    test: (c) => c.agents.some((a) => a.role === 'hub' || a.role === 'coordinator'),
    pattern: 'hub-spoke',
  },

  // ── Structural patterns ───────────────────────────────────────────────
  {
    test: (c) =>
      Array.isArray(c.workflows) &&
      c.workflows.some((w) => {
        const names = w.steps.map((s) => s.agent);
        return new Set(names).size === names.length && names.length > 2;
      }),
    pattern: 'pipeline',
  },

  // ── Default fallback ──────────────────────────────────────────────────
  {
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

      // ── Additional patterns ────────────────────────────────────────────

      case 'map-reduce': {
        // Mappers fan out from coordinator, all feed into reducer(s)
        const coordinator = this.pickHub(agents);
        const mappers = agents.filter((a) => a.role === 'mapper').map((a) => a.name);
        const reducers = agents.filter((a) => a.role === 'reducer').map((a) => a.name);
        const others = names.filter((n) => n !== coordinator && !mappers.includes(n) && !reducers.includes(n));

        // Coordinator → mappers
        edges.set(coordinator, [...mappers, ...others]);
        // Mappers → reducers
        for (const m of mappers) edges.set(m, reducers.length > 0 ? reducers : [coordinator]);
        // Reducers → coordinator
        for (const r of reducers) edges.set(r, [coordinator]);
        // Others → coordinator
        for (const o of others) edges.set(o, [coordinator]);

        return { pattern: p, agents, edges, hub: coordinator };
      }

      case 'scatter-gather': {
        // Hub scatters to all workers, gathers responses back
        const hub = this.pickHub(agents);
        const workers = names.filter((n) => n !== hub);
        edges.set(hub, workers);
        for (const w of workers) edges.set(w, [hub]);
        return { pattern: p, agents, edges, hub };
      }

      case 'supervisor': {
        // Supervisor monitors all workers; workers report to supervisor
        const supervisor = agents.find((a) => a.role === 'supervisor')?.name ?? this.pickHub(agents);
        const workers = names.filter((n) => n !== supervisor);
        edges.set(supervisor, workers);
        for (const w of workers) edges.set(w, [supervisor]);
        return { pattern: p, agents, edges, hub: supervisor };
      }

      case 'reflection': {
        // Agent produces output, critic reviews and sends feedback
        // Linear: producer → critic → producer (loop-capable)
        const critic = agents.find((a) => a.role === 'critic' || a.role === 'reviewer')?.name;
        const producers = names.filter((n) => n !== critic);
        if (critic) {
          for (const prod of producers) {
            edges.set(prod, [critic]);
          }
          edges.set(critic, producers);
        } else {
          // Fallback: self-reflection via mesh
          for (const n of names) edges.set(n, names.filter((o) => o !== n));
        }
        return { pattern: p, agents, edges };
      }

      case 'red-team': {
        // Attacker ↔ Defender adversarial communication
        const attackers = agents.filter((a) => a.role === 'attacker' || a.role === 'red-team').map((a) => a.name);
        const defenders = agents.filter((a) => a.role === 'defender' || a.role === 'blue-team').map((a) => a.name);
        const judges = names.filter((n) => !attackers.includes(n) && !defenders.includes(n));

        // Attackers → defenders and judges
        for (const a of attackers) edges.set(a, [...defenders, ...judges]);
        // Defenders → attackers and judges
        for (const d of defenders) edges.set(d, [...attackers, ...judges]);
        // Judges receive from both, can communicate with all
        for (const j of judges) edges.set(j, [...attackers, ...defenders]);

        return { pattern: p, agents, edges };
      }

      case 'verifier': {
        // Producer → Verifier chain; verifier can reject back to producer
        const verifiers = agents.filter((a) => a.role === 'verifier').map((a) => a.name);
        const producers = names.filter((n) => !verifiers.includes(n));

        for (const prod of producers) edges.set(prod, verifiers.length > 0 ? verifiers : []);
        for (const v of verifiers) edges.set(v, producers); // Can send rejections back

        return { pattern: p, agents, edges };
      }

      case 'auction': {
        // Auctioneer broadcasts tasks; bidders respond to auctioneer only
        const auctioneer = agents.find((a) => a.role === 'auctioneer')?.name ?? this.pickHub(agents);
        const bidders = names.filter((n) => n !== auctioneer);
        edges.set(auctioneer, bidders);
        for (const b of bidders) edges.set(b, [auctioneer]);
        return { pattern: p, agents, edges, hub: auctioneer };
      }

      case 'escalation': {
        // Tiered chain: each level can escalate to the next
        // Uses agent order or tier role numbers
        const order = this.resolveEscalationOrder(agents);
        for (let i = 0; i < order.length; i++) {
          // Each tier can escalate up and report down
          const canEscalateTo = i < order.length - 1 ? [order[i + 1]] : [];
          const canReportTo = i > 0 ? [order[i - 1]] : [];
          edges.set(order[i], [...canEscalateTo, ...canReportTo]);
        }
        return { pattern: p, agents, edges, pipelineOrder: order };
      }

      case 'saga': {
        // Orchestrator coordinates saga steps; each step can trigger compensate
        const orchestrator = agents.find((a) => a.role === 'saga-orchestrator')?.name ?? this.pickHub(agents);
        const participants = names.filter((n) => n !== orchestrator);
        // Orchestrator → all participants (for commands)
        edges.set(orchestrator, participants);
        // Participants → orchestrator (for completion/failure signals)
        for (const part of participants) edges.set(part, [orchestrator]);
        return { pattern: p, agents, edges, hub: orchestrator };
      }

      case 'circuit-breaker': {
        // Primary agent with fallback chain
        const order = names; // First agent is primary, rest are fallbacks
        for (let i = 0; i < order.length; i++) {
          // Each can trigger next fallback
          edges.set(order[i], i < order.length - 1 ? [order[i + 1]] : []);
        }
        return { pattern: p, agents, edges, pipelineOrder: order };
      }

      case 'blackboard': {
        // All agents can read/write to shared blackboard (full mesh)
        // Plus optional moderator
        const moderator = agents.find((a) => a.role === 'moderator')?.name;
        for (const n of names) {
          edges.set(n, names.filter((o) => o !== n));
        }
        return { pattern: p, agents, edges, hub: moderator };
      }

      case 'swarm': {
        // Emergent swarm: agents communicate with nearest neighbors
        // For simplicity, partial mesh based on agent index proximity
        const hiveMind = agents.find((a) => a.role === 'hive-mind')?.name;
        for (let i = 0; i < names.length; i++) {
          const neighbors: string[] = [];
          if (i > 0) neighbors.push(names[i - 1]);
          if (i < names.length - 1) neighbors.push(names[i + 1]);
          // Also connect to hive mind if present (avoid duplicates if already adjacent)
          if (hiveMind && hiveMind !== names[i] && !neighbors.includes(hiveMind)) neighbors.push(hiveMind);
          edges.set(names[i], neighbors);
        }
        return { pattern: p, agents, edges, hub: hiveMind };
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

  private resolveEscalationOrder(agents: AgentDefinition[]): string[] {
    // Sort by tier role (e.g., "tier-1", "tier-2") or by agent order
    const tiered = agents.filter((a) => a.role?.startsWith('tier-'));
    if (tiered.length > 0) {
      return tiered
        .sort((a, b) => {
          const tierA = parseInt(a.role?.replace('tier-', '') ?? '0', 10);
          const tierB = parseInt(b.role?.replace('tier-', '') ?? '0', 10);
          return tierA - tierB;
        })
        .map((a) => a.name);
    }
    // Fallback: use agent order
    return agents.map((a) => a.name);
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
