/**
 * WorkflowRunner — parses relay.yaml, validates config, resolves templates,
 * executes steps (sequential/parallel/DAG), runs verification checks,
 * persists state to DB, and supports pause/resume/abort with retries.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { InMemoryWorkflowDb } from './memory-db.js';
import type {
  AgentCli,
  AgentDefinition,
  ErrorHandlingConfig,
  RelayYamlConfig,
  SwarmPattern,
  VerificationCheck,
  WorkflowDefinition,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRow,
  WorkflowStepStatus,
} from './types.js';
import { WorkflowTrajectory, type StepOutcome } from './trajectory.js';

// ── AgentRelay SDK imports ──────────────────────────────────────────────────

// Import from sub-paths to avoid pulling in the full @relaycast/sdk dependency.
import { AgentRelay } from '../relay.js';
import type { Agent, AgentRelayOptions } from '../relay.js';
import { RelaycastApi } from '../relaycast.js';

// ── DB adapter interface ────────────────────────────────────────────────────

/** Minimal DB adapter so the runner is not coupled to a specific driver. */
export interface WorkflowDb {
  insertRun(run: WorkflowRunRow): Promise<void>;
  updateRun(id: string, patch: Partial<WorkflowRunRow>): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRow | null>;

  insertStep(step: WorkflowStepRow): Promise<void>;
  updateStep(id: string, patch: Partial<WorkflowStepRow>): Promise<void>;
  getStepsByRunId(runId: string): Promise<WorkflowStepRow[]>;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: 'run:started'; runId: string }
  | { type: 'run:completed'; runId: string }
  | { type: 'run:failed'; runId: string; error: string }
  | { type: 'run:cancelled'; runId: string }
  | { type: 'step:started'; runId: string; stepName: string }
  | { type: 'step:completed'; runId: string; stepName: string; output?: string }
  | { type: 'step:failed'; runId: string; stepName: string; error: string }
  | { type: 'step:skipped'; runId: string; stepName: string }
  | { type: 'step:retrying'; runId: string; stepName: string; attempt: number };

export type WorkflowEventListener = (event: WorkflowEvent) => void;

// ── Runner options ──────────────────────────────────────────────────────────

export interface WorkflowRunnerOptions {
  db?: WorkflowDb;
  workspaceId?: string;
  relay?: AgentRelayOptions;
  cwd?: string;
  summaryDir?: string;
}

// ── Variable context for template resolution ────────────────────────────────

export interface VariableContext {
  [key: string]: string | number | boolean | undefined;
}

// ── Internal step state ─────────────────────────────────────────────────────

interface StepState {
  row: WorkflowStepRow;
  agent?: Agent;
}

// ── WorkflowRunner ──────────────────────────────────────────────────────────

export class WorkflowRunner {
  private readonly db: WorkflowDb;
  private readonly workspaceId: string;
  private readonly relayOptions: AgentRelayOptions;
  private readonly cwd: string;
  private readonly summaryDir: string;

  private relay?: AgentRelay;
  private relaycastApi?: RelaycastApi;
  private channel?: string;
  private trajectory?: WorkflowTrajectory;
  private abortController?: AbortController;
  private paused = false;
  private pauseResolver?: () => void;
  private listeners: WorkflowEventListener[] = [];

  constructor(options: WorkflowRunnerOptions = {}) {
    this.db = options.db ?? new InMemoryWorkflowDb();
    this.workspaceId = options.workspaceId ?? 'local';
    this.relayOptions = options.relay ?? {};
    this.cwd = options.cwd ?? process.cwd();
    this.summaryDir = options.summaryDir ?? path.join(this.cwd, '.relay', 'summaries');
  }

  // ── Relaycast auto-provisioning ────────────────────────────────────────

  /**
   * Ensure a Relaycast workspace API key is available for the broker.
   * Resolution order:
   *   1. RELAY_API_KEY environment variable
   *   2. Cached credentials at ~/.agent-relay/relaycast.json
   *   3. Auto-create a new workspace via the Relaycast API
   */
  private async ensureRelaycastApiKey(channel: string): Promise<void> {
    if (process.env.RELAY_API_KEY) return;

    // Check cached credentials
    const cachePath = path.join(homedir(), '.agent-relay', 'relaycast.json');
    if (existsSync(cachePath)) {
      try {
        const raw = await readFile(cachePath, 'utf-8');
        const creds = JSON.parse(raw);
        if (creds.api_key) {
          process.env.RELAY_API_KEY = creds.api_key;
          return;
        }
      } catch {
        // Cache corrupt — fall through to auto-create
      }
    }

    // Auto-create a Relaycast workspace with a unique name
    const workspaceName = `relay-${channel}-${randomBytes(4).toString('hex')}`;
    const baseUrl = process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
    const res = await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: workspaceName }),
    });

    if (!res.ok) {
      throw new Error(
        `Failed to auto-create Relaycast workspace: ${res.status} ${await res.text()}`,
      );
    }

    const body = (await res.json()) as Record<string, any>;
    const data = (body.data ?? body) as Record<string, any>;
    const apiKey = data.api_key as string;
    const workspaceId = (data.workspace_id ?? data.id) as string;

    if (!apiKey) {
      throw new Error('Relaycast workspace response missing api_key');
    }

    // Cache credentials for future runs
    const cacheDir = path.dirname(cachePath);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(
      cachePath,
      JSON.stringify({
        workspace_id: workspaceId,
        api_key: apiKey,
        agent_id: '',
        agent_name: null,
        updated_at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    process.env.RELAY_API_KEY = apiKey;
  }

  // ── Event subscription ──────────────────────────────────────────────────

  on(listener: WorkflowEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: WorkflowEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Parsing & validation ────────────────────────────────────────────────

  /** Parse a relay.yaml file from disk. */
  async parseYamlFile(filePath: string): Promise<RelayYamlConfig> {
    const absPath = path.resolve(this.cwd, filePath);
    const raw = await readFile(absPath, 'utf-8');
    return this.parseYamlString(raw, absPath);
  }

  /** Parse a relay.yaml string. */
  parseYamlString(raw: string, source = '<string>'): RelayYamlConfig {
    const parsed = parseYaml(raw);
    this.validateConfig(parsed, source);
    return parsed as RelayYamlConfig;
  }

  /** Validate a config object against the RelayYamlConfig shape. */
  validateConfig(config: unknown, source = '<config>'): asserts config is RelayYamlConfig {
    if (typeof config !== 'object' || config === null) {
      throw new Error(`${source}: config must be a non-null object`);
    }

    const c = config as Record<string, unknown>;

    if (typeof c.version !== 'string') {
      throw new Error(`${source}: missing required field "version"`);
    }
    if (typeof c.name !== 'string') {
      throw new Error(`${source}: missing required field "name"`);
    }
    if (typeof c.swarm !== 'object' || c.swarm === null) {
      throw new Error(`${source}: missing required field "swarm"`);
    }
    const swarm = c.swarm as Record<string, unknown>;
    if (typeof swarm.pattern !== 'string') {
      throw new Error(`${source}: missing required field "swarm.pattern"`);
    }
    if (!Array.isArray(c.agents) || c.agents.length === 0) {
      throw new Error(`${source}: "agents" must be a non-empty array`);
    }

    for (const agent of c.agents) {
      if (typeof agent !== 'object' || agent === null) {
        throw new Error(`${source}: each agent must be an object`);
      }
      const a = agent as Record<string, unknown>;
      if (typeof a.name !== 'string') {
        throw new Error(`${source}: each agent must have a string "name"`);
      }
      if (typeof a.cli !== 'string') {
        throw new Error(`${source}: each agent must have a string "cli"`);
      }
    }

    if (c.workflows !== undefined) {
      if (!Array.isArray(c.workflows)) {
        throw new Error(`${source}: "workflows" must be an array`);
      }
      for (const wf of c.workflows) {
        this.validateWorkflow(wf, source);
      }
    }
  }

  private validateWorkflow(wf: unknown, source: string): void {
    if (typeof wf !== 'object' || wf === null) {
      throw new Error(`${source}: each workflow must be an object`);
    }
    const w = wf as Record<string, unknown>;
    if (typeof w.name !== 'string') {
      throw new Error(`${source}: each workflow must have a string "name"`);
    }
    if (!Array.isArray(w.steps) || w.steps.length === 0) {
      throw new Error(`${source}: workflow "${w.name}" must have a non-empty "steps" array`);
    }
    for (const step of w.steps) {
      if (typeof step !== 'object' || step === null) {
        throw new Error(`${source}: each step must be an object`);
      }
      const s = step as Record<string, unknown>;
      if (typeof s.name !== 'string' || typeof s.agent !== 'string' || typeof s.task !== 'string') {
        throw new Error(`${source}: each step must have "name", "agent", and "task" string fields`);
      }
    }

    // Validate DAG: check for unknown dependencies and cycles
    const stepNames = new Set((w.steps as WorkflowStep[]).map((s) => s.name));
    for (const step of w.steps as WorkflowStep[]) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!stepNames.has(dep)) {
            throw new Error(`${source}: step "${step.name}" depends on unknown step "${dep}"`);
          }
        }
      }
    }
    this.detectCycles(w.steps as WorkflowStep[], source, w.name as string);
  }

  private detectCycles(steps: WorkflowStep[], source: string, workflowName: string): void {
    const adj = new Map<string, string[]>();
    for (const step of steps) {
      adj.set(step.name, step.dependsOn ?? []);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string): void => {
      if (inStack.has(node)) {
        throw new Error(`${source}: workflow "${workflowName}" contains a dependency cycle involving "${node}"`);
      }
      if (visited.has(node)) return;
      inStack.add(node);
      for (const dep of adj.get(node) ?? []) {
        dfs(dep);
      }
      inStack.delete(node);
      visited.add(node);
    };

    for (const step of steps) {
      dfs(step.name);
    }
  }

  // ── Template variable resolution ────────────────────────────────────────

  /** Resolve {{variable}} placeholders in all task strings. */
  resolveVariables(config: RelayYamlConfig, vars: VariableContext): RelayYamlConfig {
    const resolved = structuredClone(config);

    for (const agent of resolved.agents) {
      if (agent.task) {
        agent.task = this.interpolate(agent.task, vars);
      }
    }

    if (resolved.workflows) {
      for (const wf of resolved.workflows) {
        for (const step of wf.steps) {
          step.task = this.interpolate(step.task, vars);
        }
      }
    }

    return resolved;
  }

  private interpolate(template: string, vars: VariableContext): string {
    return template.replace(/\{\{([\w][\w.\-]*)\}\}/g, (_match, key: string) => {
      // Skip step-output placeholders — they are resolved at execution time by interpolateStepTask()
      if (key.startsWith('steps.')) {
        return _match;
      }

      // Resolve dot-path variables like steps.plan.output
      const value = this.resolveDotPath(key, vars);
      if (value === undefined) {
        throw new Error(`Unresolved variable: {{${key}}}`);
      }
      return String(value);
    });
  }

  private resolveDotPath(key: string, vars: VariableContext): string | number | boolean | undefined {
    // Simple key — direct lookup
    if (!key.includes('.')) {
      return vars[key];
    }

    // Dot-path — walk into nested context
    const parts = key.split('.');
    let current: unknown = vars;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    if (current === undefined || current === null) {
      return undefined;
    }
    if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
      return current;
    }
    return String(current);
  }

  /** Build a nested context from completed step outputs for {{steps.X.output}} resolution. */
  private buildStepOutputContext(stepStates: Map<string, StepState>): VariableContext {
    const steps: Record<string, { output: string }> = {};
    for (const [name, state] of stepStates) {
      if (state.row.status === 'completed' && state.row.output !== undefined) {
        steps[name] = { output: state.row.output };
      }
    }
    return { steps } as unknown as VariableContext;
  }

  /** Interpolate step-output variables, silently skipping unresolved ones (they may be user vars). */
  private interpolateStepTask(template: string, context: VariableContext): string {
    return template.replace(/\{\{(steps\.[\w\-]+\.output)\}\}/g, (_match, key: string) => {
      const value = this.resolveDotPath(key, context);
      if (value === undefined) {
        // Leave unresolved — may not be an error if the template doesn't depend on prior steps
        return _match;
      }
      return String(value);
    });
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /** Execute a named workflow from a validated config. */
  async execute(
    config: RelayYamlConfig,
    workflowName?: string,
    vars?: VariableContext,
  ): Promise<WorkflowRunRow> {
    const resolved = vars ? this.resolveVariables(config, vars) : config;
    const workflows = resolved.workflows ?? [];

    const workflow = workflowName
      ? workflows.find((w) => w.name === workflowName)
      : workflows[0];

    if (!workflow) {
      throw new Error(
        workflowName
          ? `Workflow "${workflowName}" not found in config`
          : 'No workflows defined in config',
      );
    }

    const runId = this.generateId();
    const now = new Date().toISOString();

    const run: WorkflowRunRow = {
      id: runId,
      workspaceId: this.workspaceId,
      workflowName: workflow.name,
      pattern: resolved.swarm.pattern,
      status: 'pending',
      config: resolved,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insertRun(run);

    // Build step rows
    const stepStates = new Map<string, StepState>();
    for (const step of workflow.steps) {
      const stepRow: WorkflowStepRow = {
        id: this.generateId(),
        runId,
        stepName: step.name,
        agentName: step.agent,
        status: 'pending',
        task: step.task,
        dependsOn: step.dependsOn ?? [],
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insertStep(stepRow);
      stepStates.set(step.name, { row: stepRow });
    }

    // Start execution
    this.abortController = new AbortController();
    this.paused = false;

    // Initialize trajectory recording
    this.trajectory = new WorkflowTrajectory(resolved.trajectories, runId, this.cwd);

    try {
      await this.updateRunStatus(runId, 'running');
      this.emit({ type: 'run:started', runId });

      // Analyze DAG for trajectory context
      const dagInfo = this.analyzeDAG(workflow.steps);
      await this.trajectory.start(workflow.name, workflow.steps.length, dagInfo);

      const channel = resolved.swarm.channel ?? 'general';
      this.channel = channel;
      await this.ensureRelaycastApiKey(channel);

      this.relay = new AgentRelay({
        ...this.relayOptions,
        channels: [channel],
      });

      // Create the dedicated workflow channel and join it
      this.relaycastApi = new RelaycastApi({ agentName: 'WorkflowRunner' });
      await this.relaycastApi.createChannel(channel, workflow.description);
      await this.relaycastApi.joinChannel(channel);
      await this.postToChannel(
        `Workflow **${workflow.name}** started — ${workflow.steps.length} steps, pattern: ${resolved.swarm.pattern}`,
      );

      const agentMap = new Map<string, AgentDefinition>();
      for (const agent of resolved.agents) {
        agentMap.set(agent.name, agent);
      }

      await this.executeSteps(
        workflow,
        stepStates,
        agentMap,
        resolved.errorHandling,
        runId,
      );

      // Check if all steps completed
      const allCompleted = [...stepStates.values()].every(
        (s) => s.row.status === 'completed' || s.row.status === 'skipped',
      );

      if (allCompleted) {
        await this.updateRunStatus(runId, 'completed');
        this.emit({ type: 'run:completed', runId });
        await this.postToChannel(`Workflow **${workflow.name}** completed — all steps passed`);

        // Complete trajectory with summary
        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        const summary = this.trajectory.buildRunSummary(outcomes);
        const confidence = this.trajectory.computeConfidence(outcomes);
        await this.trajectory.complete(summary, confidence, {
          learnings: this.trajectory.extractLearnings(outcomes),
          challenges: this.trajectory.extractChallenges(outcomes),
        });
      } else {
        const failedStep = [...stepStates.values()].find((s) => s.row.status === 'failed');
        const errorMsg = failedStep?.row.error ?? 'One or more steps failed';
        await this.updateRunStatus(runId, 'failed', errorMsg);
        this.emit({ type: 'run:failed', runId, error: errorMsg });
        await this.postToChannel(`Workflow **${workflow.name}** failed: ${errorMsg}`);

        // Abandon trajectory on failure
        await this.trajectory.abandon(errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status: WorkflowRunStatus = this.abortController?.signal.aborted ? 'cancelled' : 'failed';
      await this.updateRunStatus(runId, status, errorMsg);

      if (status === 'cancelled') {
        this.emit({ type: 'run:cancelled', runId });
        await this.postToChannel(`Workflow cancelled`);
        await this.trajectory.abandon('Cancelled by user');
      } else {
        this.emit({ type: 'run:failed', runId, error: errorMsg });
        await this.postToChannel(`Workflow failed: ${errorMsg}`);
        await this.trajectory.abandon(errorMsg);
      }
    } finally {
      await this.relay?.shutdown();
      this.relay = undefined;
      this.relaycastApi = undefined;
      this.channel = undefined;
      this.trajectory = undefined;
      this.abortController = undefined;
    }

    const finalRun = await this.db.getRun(runId);
    return finalRun ?? run;
  }

  /** Resume a previously paused or partially completed run. */
  async resume(runId: string, vars?: VariableContext): Promise<WorkflowRunRow> {
    const run = await this.db.getRun(runId);
    if (!run) {
      throw new Error(`Run "${runId}" not found`);
    }

    if (run.status !== 'running' && run.status !== 'failed') {
      throw new Error(`Run "${runId}" is in status "${run.status}" and cannot be resumed`);
    }

    const config = vars ? this.resolveVariables(run.config, vars) : run.config;
    const workflows = config.workflows ?? [];
    const workflow = workflows.find((w) => w.name === run.workflowName);
    if (!workflow) {
      throw new Error(`Workflow "${run.workflowName}" not found in stored config`);
    }

    const existingSteps = await this.db.getStepsByRunId(runId);
    const stepStates = new Map<string, StepState>();
    for (const stepRow of existingSteps) {
      stepStates.set(stepRow.stepName, { row: stepRow });
    }

    // Reset failed steps to pending for retry
    for (const [, state] of stepStates) {
      if (state.row.status === 'failed') {
        state.row.status = 'pending';
        state.row.error = undefined;
        await this.db.updateStep(state.row.id, {
          status: 'pending',
          error: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    this.abortController = new AbortController();
    this.paused = false;

    // Initialize trajectory for resumed run
    this.trajectory = new WorkflowTrajectory(config.trajectories, runId, this.cwd);

    try {
      await this.updateRunStatus(runId, 'running');

      const pendingCount = [...stepStates.values()].filter((s) => s.row.status === 'pending').length;
      await this.trajectory.start(
        workflow.name,
        workflow.steps.length,
        `Resumed run: ${pendingCount} pending steps of ${workflow.steps.length} total`,
      );

      const resumeChannel = config.swarm.channel ?? 'general';
      this.channel = resumeChannel;
      await this.ensureRelaycastApiKey(resumeChannel);

      this.relay = new AgentRelay({
        ...this.relayOptions,
        channels: [resumeChannel],
      });

      // Ensure channel exists and join it for resumed runs
      this.relaycastApi = new RelaycastApi({ agentName: 'WorkflowRunner' });
      await this.relaycastApi.createChannel(resumeChannel);
      await this.relaycastApi.joinChannel(resumeChannel);
      await this.postToChannel(
        `Workflow **${workflow.name}** resumed — ${pendingCount} pending steps`,
      );

      const agentMap = new Map<string, AgentDefinition>();
      for (const agent of config.agents) {
        agentMap.set(agent.name, agent);
      }

      await this.executeSteps(workflow, stepStates, agentMap, config.errorHandling, runId);

      const allCompleted = [...stepStates.values()].every(
        (s) => s.row.status === 'completed' || s.row.status === 'skipped',
      );

      if (allCompleted) {
        await this.updateRunStatus(runId, 'completed');
        this.emit({ type: 'run:completed', runId });
        await this.postToChannel(`Workflow **${workflow.name}** completed — all steps passed`);

        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        const summary = this.trajectory.buildRunSummary(outcomes);
        const confidence = this.trajectory.computeConfidence(outcomes);
        await this.trajectory.complete(summary, confidence, {
          learnings: this.trajectory.extractLearnings(outcomes),
          challenges: this.trajectory.extractChallenges(outcomes),
        });
      } else {
        const failedStep = [...stepStates.values()].find((s) => s.row.status === 'failed');
        const errorMsg = failedStep?.row.error ?? 'One or more steps failed';
        await this.updateRunStatus(runId, 'failed', errorMsg);
        this.emit({ type: 'run:failed', runId, error: errorMsg });
        await this.postToChannel(`Workflow **${workflow.name}** failed: ${errorMsg}`);
        await this.trajectory.abandon(errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.updateRunStatus(runId, 'failed', errorMsg);
      this.emit({ type: 'run:failed', runId, error: errorMsg });
      await this.postToChannel(`Workflow failed: ${errorMsg}`);
      await this.trajectory.abandon(errorMsg);
    } finally {
      await this.relay?.shutdown();
      this.relay = undefined;
      this.relaycastApi = undefined;
      this.channel = undefined;
      this.trajectory = undefined;
      this.abortController = undefined;
    }

    const finalRun = await this.db.getRun(runId);
    return finalRun ?? run;
  }

  /** Pause execution. Currently-running steps will finish but no new steps start. */
  pause(): void {
    this.paused = true;
  }

  /** Resume after a pause(). */
  unpause(): void {
    this.paused = false;
    this.pauseResolver?.();
    this.pauseResolver = undefined;
  }

  /** Abort the current run. Running agents are released. */
  abort(): void {
    // Unblock waitIfPaused() so the run loop can exit
    this.pauseResolver?.();
    this.pauseResolver = undefined;
    this.abortController?.abort();
  }

  // ── Step execution engine ─────────────────────────────────────────────

  private async executeSteps(
    workflow: WorkflowDefinition,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string,
  ): Promise<void> {
    const rawStrategy = errorHandling?.strategy ?? workflow.onError ?? 'fail-fast';
    // Map shorthand onError values to canonical strategy names.
    // 'retry' maps to 'fail-fast' so downstream steps are properly skipped after retries exhaust.
    const strategy = rawStrategy === 'fail' ? 'fail-fast'
      : rawStrategy === 'skip' ? 'continue'
      : rawStrategy === 'retry' ? 'fail-fast'
      : rawStrategy;

    // DAG-based execution: repeatedly find ready steps and run them in parallel
    while (true) {
      this.checkAborted();
      await this.waitIfPaused();

      const readySteps = this.findReadySteps(workflow.steps, stepStates);
      if (readySteps.length === 0) {
        // No steps ready — either all done or blocked
        break;
      }

      // Begin a track chapter if multiple parallel steps are starting
      if (readySteps.length > 1 && this.trajectory) {
        const trackNames = readySteps.map((s) => s.name).join(', ');
        await this.trajectory.beginTrack(trackNames);
      }

      const results = await Promise.allSettled(
        readySteps.map((step) =>
          this.executeStep(step, stepStates, agentMap, errorHandling, runId),
        ),
      );

      // Collect outcomes from this batch for convergence reflection
      const batchOutcomes: StepOutcome[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const step = readySteps[i];
        const state = stepStates.get(step.name);

        if (result.status === 'rejected') {
          const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
          if (state && state.row.status !== 'failed') {
            await this.markStepFailed(state, error, runId);
          }

          batchOutcomes.push({
            name: step.name,
            agent: step.agent,
            status: 'failed',
            attempts: (state?.row.retryCount ?? 0) + 1,
            error,
          });

          if (strategy === 'fail-fast') {
            // Mark all pending downstream steps as skipped
            await this.markDownstreamSkipped(step.name, workflow.steps, stepStates, runId);
            throw new Error(`Step "${step.name}" failed: ${error}`);
          }

          if (strategy === 'continue') {
            await this.markDownstreamSkipped(step.name, workflow.steps, stepStates, runId);
          }
        } else {
          batchOutcomes.push({
            name: step.name,
            agent: step.agent,
            status: state?.row.status === 'completed' ? 'completed' : 'failed',
            attempts: (state?.row.retryCount ?? 0) + 1,
            output: state?.row.output,
            verificationPassed: state?.row.status === 'completed' && step.verification !== undefined,
          });
        }
      }

      // Reflect at convergence when a parallel batch completes
      if (readySteps.length > 1 && this.trajectory?.shouldReflectOnConverge()) {
        const label = readySteps.map((s) => s.name).join(' + ');
        // Find steps that this batch unblocks
        const completedNames = new Set(batchOutcomes.filter((o) => o.status === 'completed').map((o) => o.name));
        const unblocked = workflow.steps
          .filter((s) => s.dependsOn?.some((dep) => completedNames.has(dep)))
          .filter((s) => {
            const st = stepStates.get(s.name);
            return st && st.row.status === 'pending';
          })
          .map((s) => s.name);

        await this.trajectory.synthesizeAndReflect(label, batchOutcomes, unblocked.length > 0 ? unblocked : undefined);
      }
    }
  }

  private findReadySteps(
    steps: WorkflowStep[],
    stepStates: Map<string, StepState>,
  ): WorkflowStep[] {
    return steps.filter((step) => {
      const state = stepStates.get(step.name);
      if (!state || state.row.status !== 'pending') return false;

      const deps = step.dependsOn ?? [];
      return deps.every((dep) => {
        const depState = stepStates.get(dep);
        return depState && (depState.row.status === 'completed' || depState.row.status === 'skipped');
      });
    });
  }

  private async executeStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string,
  ): Promise<void> {
    const state = stepStates.get(step.name);
    if (!state) throw new Error(`Step state not found: ${step.name}`);

    const agentDef = agentMap.get(step.agent);
    if (!agentDef) {
      throw new Error(`Agent "${step.agent}" not found in config`);
    }

    const maxRetries = step.retries ?? agentDef.constraints?.retries ?? errorHandling?.maxRetries ?? 0;
    const retryDelay = errorHandling?.retryDelayMs ?? 1000;
    const timeoutMs = step.timeoutMs ?? agentDef.constraints?.timeoutMs;

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.checkAborted();

      if (attempt > 0) {
        this.emit({ type: 'step:retrying', runId, stepName: step.name, attempt });
        await this.postToChannel(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${maxRetries + 1})`);
        state.row.retryCount = attempt;
        await this.db.updateStep(state.row.id, {
          retryCount: attempt,
          updatedAt: new Date().toISOString(),
        });
        await this.trajectory?.stepRetrying(step, attempt, maxRetries);
        await this.delay(retryDelay);
      }

      try {
        // Mark step as running
        state.row.status = 'running';
        state.row.startedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'running',
          startedAt: state.row.startedAt,
          updatedAt: new Date().toISOString(),
        });
        this.emit({ type: 'step:started', runId, stepName: step.name });
        await this.postToChannel(`**[${step.name}]** Started (agent: ${agentDef.name})`);
        await this.trajectory?.stepStarted(step, agentDef.name);

        // Resolve step-output variables (e.g. {{steps.plan.output}}) at execution time
        const stepOutputContext = this.buildStepOutputContext(stepStates);
        const resolvedTask = this.interpolateStepTask(step.task, stepOutputContext);

        // Spawn agent via AgentRelay
        const resolvedStep = { ...step, task: resolvedTask };
        const output = await this.spawnAndWait(agentDef, resolvedStep, timeoutMs);

        // Run verification if configured
        if (step.verification) {
          this.runVerification(step.verification, output, step.name);
        }

        // Mark completed
        state.row.status = 'completed';
        state.row.output = output;
        state.row.completedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'completed',
          output,
          completedAt: state.row.completedAt,
          updatedAt: new Date().toISOString(),
        });
        this.emit({ type: 'step:completed', runId, stepName: step.name, output });
        await this.postToChannel(
          `**[${step.name}]** Completed\n${output.slice(0, 500)}${output.length > 500 ? '\n...(truncated)' : ''}`,
        );
        await this.trajectory?.stepCompleted(step, output, attempt + 1);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // All retries exhausted — record decision and mark failed
    await this.trajectory?.stepFailed(step, lastError ?? 'Unknown error', maxRetries + 1, maxRetries);
    await this.trajectory?.decide(
      `How to handle ${step.name} failure`,
      'exhausted',
      `All ${maxRetries + 1} attempts failed: ${lastError ?? 'Unknown error'}`,
    );
    await this.postToChannel(`**[${step.name}]** Failed: ${lastError ?? 'Unknown error'}`);
    await this.markStepFailed(state, lastError ?? 'Unknown error', runId);
    throw new Error(`Step "${step.name}" failed after ${maxRetries} retries: ${lastError ?? 'Unknown error'}`);
  }

  private async spawnAndWait(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number,
  ): Promise<string> {
    if (!this.relay) {
      throw new Error('AgentRelay not initialized');
    }

    // Append self-termination instructions to the task
    const agentName = `${step.name}-${this.generateShortId()}`;
    const taskWithExit = step.task + '\n\n---\n' +
      'IMPORTANT: When you have fully completed this task, you MUST self-terminate by calling ' +
      `the MCP tool: relay_release(name="${agentName}", reason="Task completed"). ` +
      'Do not wait for further input — release yourself immediately after finishing.';

    const agentChannels = this.channel ? [this.channel] : agentDef.channels;

    const agent = await this.relay.spawnPty({
      name: agentName,
      cli: agentDef.cli,
      args: agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : [],
      channels: agentChannels,
      task: taskWithExit,
      idleThresholdSecs: agentDef.constraints?.idleThresholdSecs,
    });

    // Register the spawned agent in Relaycast for observability
    if (this.relaycastApi) {
      await this.relaycastApi.registerExternalAgent(
        agent.name,
        `Workflow agent for step "${step.name}" (${agentDef.cli})`,
      ).catch(() => {});
    }

    // Invite the spawned agent to the workflow channel
    if (this.channel && this.relaycastApi) {
      await this.relaycastApi.inviteToChannel(this.channel, agent.name).catch(() => {});
    }

    // Post task assignment to channel for observability
    const taskPreview = step.task.slice(0, 500) + (step.task.length > 500 ? '...' : '');
    await this.postToChannel(`**[${step.name}]** Assigned to \`${agent.name}\`:\n${taskPreview}`);

    // Also send via broker protocol for agents that need DM delivery
    const system = this.relay.human({ name: 'WorkflowRunner' });
    await system.sendMessage({ to: agent.name, text: taskWithExit });

    // Wait for agent to exit (self-termination via /exit)
    const exitResult = await agent.waitForExit(timeoutMs);

    if (exitResult === 'timeout') {
      // Safety net: check if the verification file exists before giving up.
      // The agent may have completed work but failed to /exit.
      if (step.verification?.type === 'file_exists') {
        const verifyPath = path.resolve(this.cwd, step.verification.value);
        if (existsSync(verifyPath)) {
          await this.postToChannel(
            `**[${step.name}]** Agent idle after completing work — releasing`,
          );
          await agent.release();
          // Fall through to read output below
        } else {
          await agent.release();
          throw new Error(`Step "${step.name}" timed out after ${timeoutMs}ms`);
        }
      } else {
        await agent.release();
        throw new Error(`Step "${step.name}" timed out after ${timeoutMs}ms`);
      }
    }

    // Read output from summary file if it exists
    const summaryPath = path.join(this.summaryDir, `${step.name}.md`);
    const output = existsSync(summaryPath)
      ? await readFile(summaryPath, 'utf-8')
      : `Agent exited (${exitResult})`;

    return output;
  }

  // ── Verification ────────────────────────────────────────────────────────

  private runVerification(check: VerificationCheck, output: string, stepName: string): void {
    switch (check.type) {
      case 'output_contains':
        if (!output.includes(check.value)) {
          throw new Error(
            `Verification failed for "${stepName}": output does not contain "${check.value}"`,
          );
        }
        break;

      case 'exit_code':
        // exit_code verification is implicitly satisfied if the agent exited successfully
        break;

      case 'file_exists':
        if (!existsSync(path.resolve(this.cwd, check.value))) {
          throw new Error(
            `Verification failed for "${stepName}": file "${check.value}" does not exist`,
          );
        }
        break;

      case 'custom':
        // Custom verifications are evaluated by callers; no-op here
        break;
    }
  }

  // ── State helpers ─────────────────────────────────────────────────────

  private async updateRunStatus(
    runId: string,
    status: WorkflowRunStatus,
    error?: string,
  ): Promise<void> {
    const patch: Partial<WorkflowRunRow> = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      patch.completedAt = new Date().toISOString();
    }
    if (error) {
      patch.error = error;
    }
    await this.db.updateRun(runId, patch);
  }

  private async markStepFailed(state: StepState, error: string, runId: string): Promise<void> {
    state.row.status = 'failed';
    state.row.error = error;
    state.row.completedAt = new Date().toISOString();
    await this.db.updateStep(state.row.id, {
      status: 'failed',
      error,
      completedAt: state.row.completedAt,
      updatedAt: new Date().toISOString(),
    });
    this.emit({ type: 'step:failed', runId, stepName: state.row.stepName, error });
  }

  private async markDownstreamSkipped(
    failedStepName: string,
    allSteps: WorkflowStep[],
    stepStates: Map<string, StepState>,
    runId: string,
  ): Promise<void> {
    const queue = [failedStepName];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const step of allSteps) {
        if (step.dependsOn?.includes(current)) {
          const state = stepStates.get(step.name);
          if (state && state.row.status === 'pending') {
            state.row.status = 'skipped';
            await this.db.updateStep(state.row.id, {
              status: 'skipped',
              updatedAt: new Date().toISOString(),
            });
            this.emit({ type: 'step:skipped', runId, stepName: step.name });
            await this.postToChannel(`**[${step.name}]** Skipped — upstream dependency "${current}" failed`);
            await this.trajectory?.stepSkipped(step, `Upstream dependency "${current}" failed`);
            await this.trajectory?.decide(
              `Whether to skip ${step.name}`,
              'skip',
              `Upstream dependency "${current}" failed`,
            );
            queue.push(step.name);
          }
        }
      }
    }
  }

  // ── Control flow helpers ──────────────────────────────────────────────

  private checkAborted(): void {
    if (this.abortController?.signal.aborted) {
      throw new Error('Workflow aborted');
    }
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.pauseResolver = resolve;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Channel messaging ──────────────────────────────────────────────────

  /** Post a message to the workflow channel. Fire-and-forget — never throws. */
  private async postToChannel(text: string): Promise<void> {
    if (!this.relaycastApi || !this.channel) return;
    try {
      await this.relaycastApi.sendToChannel(this.channel, text);
    } catch {
      // Non-critical — don't break workflow execution
    }
  }

  // ── Trajectory helpers ────────────────────────────────────────────────

  /** Analyze DAG structure for trajectory context. */
  private analyzeDAG(steps: WorkflowStep[]): string {
    const roots = steps.filter((s) => !s.dependsOn?.length);
    const withDeps = steps.filter((s) => s.dependsOn?.length);

    const parts = [`Parsed ${steps.length} steps`];
    if (roots.length > 1) {
      parts.push(`${roots.length} parallel tracks`);
    }
    if (withDeps.length > 0) {
      parts.push(`${withDeps.length} dependent steps`);
    }
    parts.push('DAG validated, no cycles');
    return parts.join(', ');
  }

  /** Collect step outcomes for trajectory synthesis. */
  private collectOutcomes(stepStates: Map<string, StepState>, steps?: WorkflowStep[]): StepOutcome[] {
    const stepsWithVerification = new Set(
      steps?.filter((s) => s.verification).map((s) => s.name) ?? [],
    );
    const outcomes: StepOutcome[] = [];
    for (const [name, state] of stepStates) {
      outcomes.push({
        name,
        agent: state.row.agentName,
        status: state.row.status === 'completed' ? 'completed'
          : state.row.status === 'skipped' ? 'skipped'
          : 'failed',
        attempts: state.row.retryCount + 1,
        output: state.row.output,
        error: state.row.error,
        verificationPassed: state.row.status === 'completed' && stepsWithVerification.has(name),
      });
    }
    return outcomes;
  }

  // ── ID generation ─────────────────────────────────────────────────────

  private generateId(): string {
    return randomBytes(12).toString('hex');
  }

  private generateShortId(): string {
    return randomBytes(4).toString('hex');
  }
}
