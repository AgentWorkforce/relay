import { stringify as stringifyYaml } from 'yaml';

import type { AgentRelayOptions } from '../relay.js';
import type {
  AgentCli,
  AgentDefinition,
  AgentPreset,
  Barrier,
  CoordinationConfig,
  DryRunReport,
  ErrorHandlingConfig,
  IdleNudgeConfig,
  RelayYamlConfig,
  StateConfig,
  SwarmPattern,
  TrajectoryConfig,
  VerificationCheck,
  WorkflowDefinition,
  WorkflowExecuteOptions,
  WorkflowRunRow,
  WorkflowStep,
} from './types.js';
import { WorkflowRunner, type WorkflowEventListener, type VariableContext, type StepExecutor } from './runner.js';
import { formatDryRunReport } from './dry-run-format.js';

// ── Option types for the builder API ────────────────────────────────────────

export interface AgentOptions {
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** Seconds of silence before considering the agent idle (for idle nudging). */
  idleThresholdSecs?: number;
  /** When false, the agent runs as a non-interactive subprocess (no PTY, no relay messaging).
   *  Default: true. */
  interactive?: boolean;
  /** Agent preset: 'lead' (interactive PTY), 'worker' | 'reviewer' | 'analyst' (non-interactive subprocess). */
  preset?: AgentPreset;
}

/** Options for agent steps (default). */
export interface AgentStepOptions {
  agent: string;
  task: string;
  dependsOn?: string[];
  verification?: VerificationCheck;
  timeoutMs?: number;
  retries?: number;
}

/** Options for deterministic (shell command) steps. */
export interface DeterministicStepOptions {
  type: 'deterministic';
  command: string;
  /** Capture stdout as step output for downstream steps. Default: true. */
  captureOutput?: boolean;
  /** Fail if command exit code is non-zero. Default: true. */
  failOnError?: boolean;
  dependsOn?: string[];
  verification?: VerificationCheck;
  timeoutMs?: number;
}

/** Options for worktree steps (create/checkout git worktrees). */
export interface WorktreeStepOptions {
  type: 'worktree';
  branch: string;
  baseBranch?: string;
  path?: string;
  createBranch?: boolean;
  dependsOn?: string[];
  timeoutMs?: number;
}

export type StepOptions = AgentStepOptions | DeterministicStepOptions | WorktreeStepOptions;

export interface ErrorOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  notifyChannel?: string;
}

export interface WorkflowRunOptions {
  /** Run a specific workflow by name (default: first). */
  workflow?: string;
  /** Template variable substitutions. */
  vars?: VariableContext;
  /** Working directory (default: process.cwd()). */
  cwd?: string;
  /** AgentRelay options (all optional). */
  relay?: AgentRelayOptions;
  /** Progress callback. */
  onEvent?: WorkflowEventListener;
  /** Validate and print execution plan without spawning agents. */
  dryRun?: boolean;
  /** External step executor (e.g. Daytona sandbox backend). */
  executor?: StepExecutor;
  /** Start from a specific step, skipping all predecessors. */
  startFrom?: string;
  /** Previous run ID whose cached outputs are used with startFrom. */
  previousRunId?: string;
}

// ── WorkflowBuilder ─────────────────────────────────────────────────────────

/**
 * Fluent builder for constructing workflow configurations programmatically.
 *
 * @example
 * ```typescript
 * import { workflow } from "@agent-relay/sdk/workflows";
 *
 * const result = await workflow("my-workflow")
 *   .pattern("dag")
 *   .agent("worker", { cli: "claude", role: "Backend engineer" })
 *   .step("build", { agent: "worker", task: "Build the project" })
 *   .step("test", { agent: "worker", task: "Run tests", dependsOn: ["build"] })
 *   .run();
 * ```
 */
export class WorkflowBuilder {
  private _name: string;
  private _description?: string;
  private _pattern: SwarmPattern = 'dag';
  private _maxConcurrency?: number;
  private _timeoutMs?: number;
  private _channel?: string;
  private _idleNudge?: IdleNudgeConfig;
  private _agents: AgentDefinition[] = [];
  private _steps: WorkflowStep[] = [];
  private _errorHandling?: ErrorHandlingConfig;
  private _coordination?: CoordinationConfig;
  private _state?: StateConfig;
  private _trajectories?: TrajectoryConfig | false;
  private _startFrom?: string;
  private _previousRunId?: string;

  constructor(name: string) {
    this._name = name;
  }

  /** Set workflow description. */
  description(desc: string): this {
    this._description = desc;
    return this;
  }

  /** Set swarm pattern (default: "dag"). */
  pattern(p: SwarmPattern): this {
    this._pattern = p;
    return this;
  }

  /** Set maximum concurrent agents. */
  maxConcurrency(n: number): this {
    this._maxConcurrency = n;
    return this;
  }

  /** Set global timeout in milliseconds. */
  timeout(ms: number): this {
    this._timeoutMs = ms;
    return this;
  }

  /** Set the relay channel for agent communication. */
  channel(ch: string): this {
    this._channel = ch;
    return this;
  }

  /** Configure idle agent detection and nudging for interactive agents. */
  idleNudge(config: IdleNudgeConfig): this {
    this._idleNudge = config;
    return this;
  }

  /** Set workflow coordination settings (barriers, voting threshold, consensus strategy). */
  coordination(config: CoordinationConfig): this {
    this._coordination = config;
    return this;
  }

  /** Configure shared workflow state backend settings. */
  state(config: StateConfig): this {
    this._state = config;
    return this;
  }

  /** Configure trajectory recording, or pass `false` to disable it. */
  trajectories(config: TrajectoryConfig | false): this {
    this._trajectories = config;
    return this;
  }

  /** Start execution from a specific step, skipping all predecessor steps. */
  startFrom(stepName: string): this {
    this._startFrom = stepName;
    return this;
  }

  /** Set the previous run ID whose cached step outputs should be used with startFrom. */
  previousRunId(id: string): this {
    this._previousRunId = id;
    return this;
  }

  /** Add an agent definition. */
  agent(name: string, options: AgentOptions): this {
    const def: AgentDefinition = {
      name,
      cli: options.cli,
    };

    if (options.role !== undefined) def.role = options.role;
    if (options.task !== undefined) def.task = options.task;
    if (options.channels !== undefined) def.channels = options.channels;
    if (options.preset !== undefined) def.preset = options.preset;
    if (options.interactive !== undefined) def.interactive = options.interactive;

    if (
      options.model !== undefined ||
      options.maxTokens !== undefined ||
      options.timeoutMs !== undefined ||
      options.retries !== undefined ||
      options.idleThresholdSecs !== undefined
    ) {
      def.constraints = {};
      if (options.model !== undefined) def.constraints.model = options.model;
      if (options.maxTokens !== undefined) def.constraints.maxTokens = options.maxTokens;
      if (options.timeoutMs !== undefined) def.constraints.timeoutMs = options.timeoutMs;
      if (options.retries !== undefined) def.constraints.retries = options.retries;
      if (options.idleThresholdSecs !== undefined)
        def.constraints.idleThresholdSecs = options.idleThresholdSecs;
    }

    this._agents.push(def);
    return this;
  }

  /** Add a workflow step (agent or deterministic). */
  step(name: string, options: StepOptions): this {
    const step: WorkflowStep = { name };

    if ('type' in options && options.type === 'deterministic') {
      if (!options.command) {
        throw new Error('deterministic steps must have a command');
      }
      if ('agent' in options || 'task' in options) {
        throw new Error('deterministic steps must not have agent or task');
      }
      step.type = 'deterministic';
      step.command = options.command;
      if (options.captureOutput !== undefined) step.captureOutput = options.captureOutput;
      if (options.failOnError !== undefined) step.failOnError = options.failOnError;
      if (options.dependsOn !== undefined) step.dependsOn = options.dependsOn;
      if (options.verification !== undefined) step.verification = options.verification;
      if (options.timeoutMs !== undefined) step.timeoutMs = options.timeoutMs;
    } else if ('type' in options && options.type === 'worktree') {
      if ('agent' in options || 'task' in options) {
        throw new Error('worktree steps must not have agent or task');
      }
      step.type = 'worktree';
      step.branch = options.branch;
      if (options.baseBranch !== undefined) step.baseBranch = options.baseBranch;
      if (options.path !== undefined) step.path = options.path;
      if (options.createBranch !== undefined) step.createBranch = options.createBranch;
      if (options.dependsOn !== undefined) step.dependsOn = options.dependsOn;
      if (options.timeoutMs !== undefined) step.timeoutMs = options.timeoutMs;
    } else {
      // Agent step
      const agentOpts = options as AgentStepOptions;
      if (!agentOpts.agent || !agentOpts.task) {
        throw new Error('Agent steps must have both agent and task');
      }
      step.agent = agentOpts.agent;
      step.task = agentOpts.task;
      if (agentOpts.dependsOn !== undefined) step.dependsOn = agentOpts.dependsOn;
      if (agentOpts.verification !== undefined) step.verification = agentOpts.verification;
      if (agentOpts.timeoutMs !== undefined) step.timeoutMs = agentOpts.timeoutMs;
      if (agentOpts.retries !== undefined) step.retries = agentOpts.retries;
    }

    this._steps.push(step);
    return this;
  }

  /** Set error handling strategy. */
  onError(strategy: 'fail-fast' | 'continue' | 'retry', options?: ErrorOptions): this {
    this._errorHandling = { strategy };
    if (options?.maxRetries !== undefined) this._errorHandling.maxRetries = options.maxRetries;
    if (options?.retryDelayMs !== undefined) this._errorHandling.retryDelayMs = options.retryDelayMs;
    if (options?.notifyChannel !== undefined) this._errorHandling.notifyChannel = options.notifyChannel;
    return this;
  }

  /** Build and return the RelayYamlConfig object. */
  toConfig(): RelayYamlConfig {
    const hasAgentSteps = this._steps.some((s) => s.type !== 'deterministic' && s.type !== 'worktree');
    if (hasAgentSteps && this._agents.length === 0) {
      throw new Error('Workflow must have at least one agent when using agent steps');
    }
    if (this._steps.length === 0) {
      throw new Error('Workflow must have at least one step');
    }

    const wfDef: WorkflowDefinition = {
      name: `${this._name}-workflow`,
      steps: [...this._steps],
    };

    const config: RelayYamlConfig = {
      version: '1.0',
      name: this._name,
      swarm: {
        pattern: this._pattern,
      },
      agents: [...this._agents],
      workflows: [wfDef],
    };

    if (this._description !== undefined) config.description = this._description;
    if (this._maxConcurrency !== undefined) config.swarm.maxConcurrency = this._maxConcurrency;
    if (this._timeoutMs !== undefined) config.swarm.timeoutMs = this._timeoutMs;
    if (this._channel !== undefined) config.swarm.channel = this._channel;
    if (this._idleNudge !== undefined) config.swarm.idleNudge = this._idleNudge;
    if (this._errorHandling !== undefined) config.errorHandling = this._errorHandling;
    if (this._coordination !== undefined) config.coordination = this._coordination;
    if (this._state !== undefined) config.state = this._state;
    if (this._trajectories !== undefined) config.trajectories = this._trajectories;

    return config;
  }

  /** Serialize the config to a YAML string. */
  toYaml(): string {
    return stringifyYaml(this.toConfig());
  }

  /** Build the config and execute it with the WorkflowRunner. */
  async run(options: WorkflowRunOptions & { dryRun: true }): Promise<DryRunReport>;
  async run(options?: WorkflowRunOptions): Promise<WorkflowRunRow>;
  async run(options: WorkflowRunOptions = {}): Promise<WorkflowRunRow | DryRunReport> {
    const config = this.toConfig();

    const runner = new WorkflowRunner({
      cwd: options.cwd,
      relay: options.relay,
      executor: options.executor,
    });

    // Auto-detect DRY_RUN env var so existing scripts get dry-run for free
    const isDryRun = options.dryRun ?? !!process.env.DRY_RUN;

    if (isDryRun) {
      const report = runner.dryRun(config, options.workflow, options.vars);
      console.log(formatDryRunReport(report));
      return report;
    }

    if (options.onEvent) {
      runner.on(options.onEvent);
    }

    const startFrom = this._startFrom ?? options.startFrom;
    const previousRunId = this._previousRunId ?? options.previousRunId;
    const executeOptions: WorkflowExecuteOptions | undefined = startFrom
      ? { startFrom, previousRunId }
      : undefined;

    return runner.execute(config, options.workflow, options.vars, executeOptions);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Create a new workflow builder.
 *
 * @example
 * ```typescript
 * const result = await workflow("my-task")
 *   .pattern("fan-out")
 *   .agent("worker", { cli: "claude" })
 *   .step("do-work", { agent: "worker", task: "Build the feature" })
 *   .run();
 * ```
 */
export function workflow(name: string): WorkflowBuilder {
  return new WorkflowBuilder(name);
}
