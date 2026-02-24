/**
 * WorkflowRunner — parses relay.yaml, validates config, resolves templates,
 * executes steps (sequential/parallel/DAG), runs verification checks,
 * persists state to DB, and supports pause/resume/abort with retries.
 */

import { spawn as cpSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { stripAnsi as stripAnsiFn } from '../pty.js';

import {
  loadCustomSteps,
  resolveAllCustomSteps,
  validateCustomStepsUsage,
  CustomStepsParseError,
  CustomStepResolutionError,
} from './custom-steps.js';
import { InMemoryWorkflowDb } from './memory-db.js';
import type {
  AgentCli,
  AgentDefinition,
  DryRunReport,
  DryRunWave,
  ErrorHandlingConfig,
  IdleNudgeConfig,
  PreflightCheck,
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
  | { type: 'step:retrying'; runId: string; stepName: string; attempt: number }
  | { type: 'step:nudged'; runId: string; stepName: string; nudgeCount: number }
  | { type: 'step:force-released'; runId: string; stepName: string };

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
  private relayApiKey?: string;
  private channel?: string;
  private trajectory?: WorkflowTrajectory;
  private abortController?: AbortController;
  private paused = false;
  private pauseResolver?: () => void;
  private listeners: WorkflowEventListener[] = [];

  /** Current config for the active run, so spawnAndWait can access swarm config. */
  private currentConfig?: RelayYamlConfig;
  /** Current run ID for event emission from spawnAndWait context. */
  private currentRunId?: string;
  /** Live Agent handles keyed by name, for hub-mediated nudging. */
  private readonly activeAgentHandles = new Map<string, Agent>();

  // PTY-based output capture: accumulate terminal output per-agent
  private readonly ptyOutputBuffers = new Map<string, string[]>();
  private readonly ptyListeners = new Map<string, (chunk: string) => void>();
  private readonly ptyLogStreams = new Map<string, WriteStream>();
  /** Path to workers.json so `agents:kill` can find workflow-spawned agents */
  private readonly workersPath: string;
  /** In-memory tracking of active workers to avoid race conditions on workers.json */
  private readonly activeWorkers = new Map<
    string,
    { cli: string; task: string; spawnedAt: number; pid?: number; logFile: string }
  >();
  /** Mutex for serializing workers.json file access */
  private workersFileLock: Promise<void> = Promise.resolve();

  constructor(options: WorkflowRunnerOptions = {}) {
    this.db = options.db ?? new InMemoryWorkflowDb();
    this.workspaceId = options.workspaceId ?? 'local';
    this.relayOptions = options.relay ?? {};
    this.cwd = options.cwd ?? process.cwd();
    this.summaryDir = options.summaryDir ?? path.join(this.cwd, '.relay', 'summaries');
    this.workersPath = path.join(this.cwd, '.agent-relay', 'team', 'workers.json');
  }

  // ── Relaycast auto-provisioning ────────────────────────────────────────

  /**
   * Ensure a Relaycast workspace API key is available for the broker.
   * Resolution order:
   *   1. RELAY_API_KEY environment variable
   *   2. Cached credentials at ~/.agent-relay/relaycast.json
   *   3. Auto-create a new workspace via the Relaycast API
   */
  /**
   * Validate a Relaycast API key by making a lightweight API call.
   * Returns true if the key is valid, false otherwise.
   */
  private async validateRelaycastApiKey(apiKey: string): Promise<boolean> {
    const baseUrl = process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
    try {
      const res = await fetch(`${baseUrl}/v1/channels`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async ensureRelaycastApiKey(channel: string): Promise<void> {
    if (this.relayApiKey) return;

    const configuredKey = this.relayOptions.env?.RELAY_API_KEY;
    if (configuredKey) {
      if (await this.validateRelaycastApiKey(configuredKey)) {
        this.relayApiKey = configuredKey;
        return;
      }
    }

    const envKey = process.env.RELAY_API_KEY;
    if (envKey) {
      if (await this.validateRelaycastApiKey(envKey)) {
        this.relayApiKey = envKey;
        return;
      }
    }

    // Check cached credentials — prefer per-project cache (written by the local
    // relay broker) over the legacy global cache so concurrent workflows from
    // different repos never stomp each other's credentials.
    const projectCachePath = path.join(this.cwd, '.agent-relay', 'relaycast.json');
    const globalCachePath = path.join(homedir(), '.agent-relay', 'relaycast.json');

    for (const cachePath of [projectCachePath, globalCachePath]) {
      if (existsSync(cachePath)) {
        try {
          const raw = await readFile(cachePath, 'utf-8');
          const creds = JSON.parse(raw);
          if (creds.api_key) {
            if (await this.validateRelaycastApiKey(creds.api_key)) {
              this.relayApiKey = creds.api_key;
              return;
            }
            // Cached key is stale — continue to next path or auto-provision
          }
        } catch {
          // Cache corrupt — try next path
        }
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
      throw new Error(`Failed to auto-create Relaycast workspace: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as Record<string, any>;
    const data = (body.data ?? body) as Record<string, any>;
    const apiKey = data.api_key as string;
    const workspaceId = (data.workspace_id ?? data.id) as string;

    if (!apiKey) {
      throw new Error('Relaycast workspace response missing api_key');
    }

    // Cache credentials in the per-project directory so concurrent workflows
    // from different repos each get their own workspace credentials.
    const cacheDir = path.dirname(projectCachePath);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(
      projectCachePath,
      JSON.stringify({
        workspace_id: workspaceId,
        api_key: apiKey,
        agent_id: '',
        agent_name: null,
        updated_at: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );

    this.relayApiKey = apiKey;
  }

  private getRelayEnv(): NodeJS.ProcessEnv | undefined {
    if (!this.relayApiKey) {
      return this.relayOptions.env;
    }

    return {
      ...(this.relayOptions.env ?? process.env),
      RELAY_API_KEY: this.relayApiKey,
    };
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

  // ── Dry-run simulation ──────────────────────────────────────────────

  /**
   * Validate a workflow config and simulate execution waves without spawning agents.
   * Returns a DryRunReport with DAG analysis, agent summary, and wave breakdown.
   */
  dryRun(config: RelayYamlConfig, workflowName?: string, vars?: VariableContext): DryRunReport {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Validate config
    let resolved: RelayYamlConfig;
    try {
      this.validateConfig(config);
      resolved = vars ? this.resolveVariables(config, vars) : config;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return {
        valid: false,
        errors,
        warnings,
        name: (config as any)?.name ?? '<unknown>',
        pattern: (config as any)?.swarm?.pattern ?? '<unknown>',
        agents: [],
        waves: [],
        totalSteps: 0,
        estimatedWaves: 0,
      };
    }

    // 2. Find target workflow
    const workflows = resolved.workflows ?? [];
    const workflow = workflowName ? workflows.find((w) => w.name === workflowName) : workflows[0];

    if (!workflow) {
      errors.push(
        workflowName ? `Workflow "${workflowName}" not found in config` : 'No workflows defined in config'
      );
      return {
        valid: false,
        errors,
        warnings,
        name: resolved.name,
        description: resolved.description,
        pattern: resolved.swarm.pattern,
        agents: [],
        waves: [],
        totalSteps: 0,
        estimatedWaves: 0,
      };
    }

    // 3. Load and validate custom steps
    let customSteps = new Map<string, import('./types.js').CustomStepDefinition>();
    try {
      customSteps = loadCustomSteps(this.cwd);
    } catch (err) {
      if (err instanceof CustomStepsParseError) {
        errors.push(`Custom steps file error: ${err.issue}\n${err.suggestion}`);
      } else {
        errors.push(`Failed to load custom steps: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Validate custom step usage in workflow steps
    const customStepValidation = validateCustomStepsUsage(workflow.steps, customSteps);
    errors.push(...customStepValidation.errors);
    warnings.push(...customStepValidation.warnings);

    // Resolve custom steps for further validation
    let resolvedSteps = workflow.steps;
    if (customStepValidation.valid) {
      try {
        resolvedSteps = resolveAllCustomSteps(workflow.steps, customSteps);
      } catch (err) {
        if (err instanceof CustomStepResolutionError) {
          errors.push(`${err.issue}\n${err.suggestion}`);
        } else {
          errors.push(`Failed to resolve custom steps: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 4. Build agent map and validate step→agent references
    const agentMap = new Map<string, AgentDefinition>();
    for (const agent of resolved.agents) {
      agentMap.set(agent.name, agent);
    }

    const stepAgentCounts = new Map<string, number>();
    for (const step of resolvedSteps) {
      // Only validate agent references for agent-type steps
      if (step.agent) {
        if (!agentMap.has(step.agent)) {
          warnings.push(`Step "${step.name}" references unknown agent "${step.agent}"`);
        }
        stepAgentCounts.set(step.agent, (stepAgentCounts.get(step.agent) ?? 0) + 1);
      }
    }

    // Validate cwd paths
    for (const agent of resolved.agents) {
      if (agent.cwd) {
        const resolvedCwd = path.resolve(this.cwd, agent.cwd);
        if (!existsSync(resolvedCwd)) {
          warnings.push(`Agent "${agent.name}" cwd "${agent.cwd}" resolves to "${resolvedCwd}" which does not exist`);
        }
      }
      if (agent.additionalPaths) {
        for (const ap of agent.additionalPaths) {
          const resolvedPath = path.resolve(this.cwd, ap);
          if (!existsSync(resolvedPath)) {
            warnings.push(`Agent "${agent.name}" additionalPath "${ap}" resolves to "${resolvedPath}" which does not exist`);
          }
        }
      }
    }

    // Cycle detection via topological sort
    const stepNames = new Set(resolvedSteps.map((s) => s.name));
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const step of resolvedSteps) {
      inDegree.set(step.name, 0);
      adjacency.set(step.name, []);
    }
    for (const step of resolvedSteps) {
      for (const dep of step.dependsOn ?? []) {
        if (stepNames.has(dep)) {
          adjacency.get(dep)!.push(step.name);
          inDegree.set(step.name, (inDegree.get(step.name) ?? 0) + 1);
        }
      }
    }
    const topoQueue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) topoQueue.push(name);
    }
    let visited = 0;
    while (topoQueue.length > 0) {
      const node = topoQueue.shift()!;
      visited++;
      for (const neighbor of adjacency.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) topoQueue.push(neighbor);
      }
    }
    if (visited < resolvedSteps.length) {
      errors.push(
        'Dependency cycle detected in workflow steps. Check dependsOn references for circular dependencies.'
      );
    }

    // Missing dependency references
    for (const step of resolvedSteps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepNames.has(dep)) {
          errors.push(`Step "${step.name}" depends on unknown step "${dep}"`);
        }
      }
    }

    // Unreachable steps (steps that are never depended on and aren't root steps)
    const dependedOn = new Set<string>();
    for (const step of resolvedSteps) {
      for (const dep of step.dependsOn ?? []) {
        dependedOn.add(dep);
      }
    }

    // Timeout warnings
    for (const step of resolvedSteps) {
      if (!step.timeoutMs) {
        const agentDef = step.agent ? agentMap.get(step.agent) : undefined;
        if (!agentDef?.constraints?.timeoutMs && !resolved.swarm.timeoutMs) {
          warnings.push(
            `Step "${step.name}" has no timeout configured (no step, agent, or swarm-level timeout)`
          );
        }
      }
    }

    // Large dependency fan-in warning (decomposition guidance)
    for (const step of resolvedSteps) {
      if ((step.dependsOn?.length ?? 0) >= 5) {
        warnings.push(
          `Step "${step.name}" depends on ${step.dependsOn!.length} upstream steps. ` +
            `Consider decomposing into smaller verification steps to reduce context size.`
        );
      }
    }

    // 4. Build agent summary
    const agents = resolved.agents.map((a) => ({
      name: a.name,
      cli: a.cli,
      role: a.role,
      cwd: a.cwd,
      stepCount: stepAgentCounts.get(a.name) ?? 0,
    }));

    // 5. Simulate execution waves
    const waves: DryRunWave[] = [];
    const completed = new Set<string>();
    const allSteps = [...resolvedSteps];
    let waveNum = 0;

    while (completed.size < allSteps.length) {
      const ready = allSteps.filter((step) => {
        if (completed.has(step.name)) return false;
        const deps = step.dependsOn ?? [];
        return deps.every((dep) => completed.has(dep));
      });

      if (ready.length === 0) {
        // Remaining steps are blocked — likely a cycle or unresolvable deps
        const blocked = allSteps.filter((s) => !completed.has(s.name)).map((s) => s.name);
        errors.push(`Blocked steps with unresolvable dependencies: ${blocked.join(', ')}`);
        break;
      }

      waveNum++;
      waves.push({
        wave: waveNum,
        steps: ready.map((s) => ({
          name: s.name,
          agent: s.agent,
          dependsOn: s.dependsOn ?? [],
        })),
      });

      for (const step of ready) {
        completed.add(step.name);
      }
    }

    // 6. Resource estimation
    const peakConcurrency = Math.max(...waves.map((w) => w.steps.length), 0);
    const totalAgentSteps = resolvedSteps.filter(
      (s) => s.type !== 'deterministic' && s.type !== 'worktree'
    ).length;

    // 7. Check maxConcurrency against wave widths
    const maxConcurrency = resolved.swarm.maxConcurrency;
    if (maxConcurrency !== undefined) {
      for (const wave of waves) {
        if (wave.steps.length > maxConcurrency) {
          warnings.push(
            `Wave ${wave.wave} has ${wave.steps.length} parallel steps but maxConcurrency is ${maxConcurrency}`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      name: workflow.name,
      description: workflow.description ?? resolved.description,
      pattern: resolved.swarm.pattern,
      agents,
      waves,
      totalSteps: workflow.steps.length,
      maxConcurrency,
      estimatedWaves: waves.length,
      estimatedPeakConcurrency: peakConcurrency,
      estimatedTotalAgentSteps: totalAgentSteps,
    };
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
      if (typeof s.name !== 'string') {
        throw new Error(`${source}: each step must have a string "name" field`);
      }

      // Deterministic steps require type and command
      if (s.type === 'deterministic') {
        if (typeof s.command !== 'string') {
          throw new Error(`${source}: deterministic step "${s.name}" must have a "command" field`);
        }
      } else {
        // Agent steps (type undefined or 'agent') require agent and task
        if (typeof s.agent !== 'string' || typeof s.task !== 'string') {
          throw new Error(`${source}: agent step "${s.name}" must have "agent" and "task" string fields`);
        }
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
        throw new Error(
          `${source}: workflow "${workflowName}" contains a dependency cycle involving "${node}"`
        );
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
          // Resolve variables in task (agent steps) and command (deterministic steps)
          if (step.task) {
            step.task = this.interpolate(step.task, vars);
          }
          if (step.command) {
            step.command = this.interpolate(step.command, vars);
          }
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
  private buildStepOutputContext(stepStates: Map<string, StepState>, runId?: string): VariableContext {
    const steps: Record<string, { output: string }> = {};
    for (const [name, state] of stepStates) {
      if (state.row.status === 'completed' && state.row.output !== undefined) {
        steps[name] = { output: state.row.output };
      } else if (state.row.status === 'completed' && runId) {
        // Recover from persisted output on disk (e.g., after restart)
        const persisted = this.loadStepOutput(runId, name);
        if (persisted) {
          state.row.output = persisted;
          steps[name] = { output: persisted };
        }
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
    vars?: VariableContext
  ): Promise<WorkflowRunRow> {
    const resolved = vars ? this.resolveVariables(config, vars) : config;
    const workflows = resolved.workflows ?? [];

    const workflow = workflowName ? workflows.find((w) => w.name === workflowName) : workflows[0];

    if (!workflow) {
      throw new Error(
        workflowName ? `Workflow "${workflowName}" not found in config` : 'No workflows defined in config'
      );
    }

    // Load and resolve custom step definitions
    const customSteps = loadCustomSteps(this.cwd);
    const resolvedSteps = resolveAllCustomSteps(workflow.steps, customSteps);
    const resolvedWorkflow = { ...workflow, steps: resolvedSteps };

    const runId = this.generateId();
    const now = new Date().toISOString();

    const run: WorkflowRunRow = {
      id: runId,
      workspaceId: this.workspaceId,
      workflowName: resolvedWorkflow.name,
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
    for (const step of resolvedWorkflow.steps) {
      // Handle agent, deterministic, and worktree steps
      const isNonAgent = step.type === 'deterministic' || step.type === 'worktree';

      const stepRow: WorkflowStepRow = {
        id: this.generateId(),
        runId,
        stepName: step.name,
        agentName: isNonAgent ? null : (step.agent ?? null),
        stepType: isNonAgent ? (step.type as 'deterministic' | 'worktree') : 'agent',
        status: 'pending',
        task: step.type === 'deterministic' ? (step.command ?? '')
            : step.type === 'worktree' ? (step.branch ?? '')
            : (step.task ?? ''),
        dependsOn: step.dependsOn ?? [],
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insertStep(stepRow);
      stepStates.set(step.name, { row: stepRow });
    }

    return this.runWorkflowCore({
      run,
      workflow: resolvedWorkflow,
      config: resolved,
      stepStates,
      isResume: false,
    });
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

    return this.runWorkflowCore({
      run,
      workflow,
      config,
      stepStates,
      isResume: true,
    });
  }

  private async runWorkflowCore(input: {
    run: WorkflowRunRow;
    workflow: WorkflowDefinition;
    config: RelayYamlConfig;
    stepStates: Map<string, StepState>;
    isResume: boolean;
  }): Promise<WorkflowRunRow> {
    const { run, workflow, config, stepStates, isResume } = input;
    const runId = run.id;

    // Start execution
    this.abortController = new AbortController();
    this.paused = false;
    this.currentConfig = config;
    this.currentRunId = runId;

    // Initialize trajectory recording
    this.trajectory = new WorkflowTrajectory(config.trajectories, runId, this.cwd);

    try {
      await this.updateRunStatus(runId, 'running');
      if (!isResume) {
        this.emit({ type: 'run:started', runId });
      }

      const pendingCount = [...stepStates.values()].filter((s) => s.row.status === 'pending').length;
      if (isResume) {
        await this.trajectory.start(
          workflow.name,
          workflow.steps.length,
          `Resumed run: ${pendingCount} pending steps of ${workflow.steps.length} total`
        );
      } else {
        // Analyze DAG for trajectory context on first run
        const dagInfo = this.analyzeDAG(workflow.steps);
        await this.trajectory.start(workflow.name, workflow.steps.length, dagInfo);
      }

      const channel =
        config.swarm.channel ??
        `wf-${this.sanitizeChannelName(config.name || run.workflowName)}-${this.generateShortId()}`;
      this.channel = channel;
      if (!config.swarm.channel) {
        config.swarm.channel = channel;
        await this.db.updateRun(runId, { config });
      }
      await this.ensureRelaycastApiKey(channel);

      this.relay = new AgentRelay({
        ...this.relayOptions,
        channels: [channel],
        env: this.getRelayEnv(),
      });

      // Wire PTY output dispatcher — routes chunks to per-agent listeners
      this.relay.onWorkerOutput = ({ name, chunk }) => {
        const listener = this.ptyListeners.get(name);
        if (listener) listener(chunk);
      };

      this.relaycastApi = new RelaycastApi({
        agentName: 'WorkflowRunner',
        apiKey: this.relayApiKey,
        cachePath: path.join(this.cwd, '.agent-relay', 'relaycast.json'),
      });
      if (isResume) {
        await this.relaycastApi.createChannel(channel);
      } else {
        await this.relaycastApi.createChannel(channel, workflow.description);
      }
      await this.relaycastApi.joinChannel(channel);

      if (isResume) {
        this.postToChannel(`Workflow **${workflow.name}** resumed — ${pendingCount} pending steps`);
      } else {
        this.postToChannel(
          `Workflow **${workflow.name}** started — ${workflow.steps.length} steps, pattern: ${config.swarm.pattern}`
        );
      }

      const agentMap = new Map<string, AgentDefinition>();
      for (const agent of config.agents) {
        agentMap.set(agent.name, agent);
      }

      // Run preflight checks before any steps (skip on resume)
      if (!isResume && workflow.preflight?.length) {
        await this.runPreflightChecks(workflow.preflight, runId);
      }

      await this.executeSteps(workflow, stepStates, agentMap, config.errorHandling, runId);

      const allCompleted = [...stepStates.values()].every(
        (s) => s.row.status === 'completed' || s.row.status === 'skipped'
      );

      if (allCompleted) {
        await this.updateRunStatus(runId, 'completed');
        this.emit({ type: 'run:completed', runId });

        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        const summary = this.trajectory.buildRunSummary(outcomes);
        const confidence = this.trajectory.computeConfidence(outcomes);
        await this.trajectory.complete(summary, confidence, {
          learnings: this.trajectory.extractLearnings(outcomes),
          challenges: this.trajectory.extractChallenges(outcomes),
        });

        this.postCompletionReport(workflow.name, outcomes, summary, confidence);
      } else {
        const failedStep = [...stepStates.values()].find((s) => s.row.status === 'failed');
        const errorMsg = failedStep?.row.error ?? 'One or more steps failed';
        await this.updateRunStatus(runId, 'failed', errorMsg);
        this.emit({ type: 'run:failed', runId, error: errorMsg });

        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        this.postFailureReport(workflow.name, outcomes, errorMsg);
        await this.trajectory.abandon(errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status: WorkflowRunStatus =
        !isResume && this.abortController?.signal.aborted ? 'cancelled' : 'failed';
      await this.updateRunStatus(runId, status, errorMsg);

      if (status === 'cancelled') {
        this.emit({ type: 'run:cancelled', runId });
        this.postToChannel(`Workflow **${workflow.name}** cancelled`);
        await this.trajectory.abandon('Cancelled by user');
      } else {
        this.emit({ type: 'run:failed', runId, error: errorMsg });
        this.postToChannel(`Workflow failed: ${errorMsg}`);
        await this.trajectory.abandon(errorMsg);
      }
    } finally {
      for (const stream of this.ptyLogStreams.values()) stream.end();
      this.ptyLogStreams.clear();
      this.ptyOutputBuffers.clear();
      this.ptyListeners.clear();

      await this.relay?.shutdown();
      this.relay = undefined;
      this.relaycastApi = undefined;
      this.channel = undefined;
      this.trajectory = undefined;
      this.abortController = undefined;
      this.currentConfig = undefined;
      this.currentRunId = undefined;
      this.activeAgentHandles.clear();
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
    runId: string
  ): Promise<void> {
    const rawStrategy = errorHandling?.strategy ?? workflow.onError ?? 'fail-fast';
    // Map shorthand onError values to canonical strategy names.
    // 'retry' maps to 'fail-fast' so downstream steps are properly skipped after retries exhaust.
    const strategy =
      rawStrategy === 'fail'
        ? 'fail-fast'
        : rawStrategy === 'skip'
          ? 'continue'
          : rawStrategy === 'retry'
            ? 'fail-fast'
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
        readySteps.map((step) => this.executeStep(step, stepStates, agentMap, errorHandling, runId))
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
            agent: step.agent ?? 'deterministic',
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
            agent: step.agent ?? 'deterministic',
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
        const completedNames = new Set(
          batchOutcomes.filter((o) => o.status === 'completed').map((o) => o.name)
        );
        const unblocked = workflow.steps
          .filter((s) => s.dependsOn?.some((dep) => completedNames.has(dep)))
          .filter((s) => {
            const st = stepStates.get(s.name);
            return st && st.row.status === 'pending';
          })
          .map((s) => s.name);

        await this.trajectory.synthesizeAndReflect(
          label,
          batchOutcomes,
          unblocked.length > 0 ? unblocked : undefined
        );
      }
    }
  }

  private findReadySteps(steps: WorkflowStep[], stepStates: Map<string, StepState>): WorkflowStep[] {
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

  /**
   * Execute preflight checks before any workflow steps.
   * All checks must pass or the workflow fails immediately.
   */
  private async runPreflightChecks(
    checks: PreflightCheck[],
    runId: string,
  ): Promise<void> {
    this.postToChannel(`Running ${checks.length} preflight check(s)...`);

    for (const check of checks) {
      this.checkAborted();

      const description = check.description ?? check.command.slice(0, 50);
      this.postToChannel(`**[preflight]** ${description}`);

      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = cpSpawn('sh', ['-c', check.command], {
            stdio: 'pipe',
            cwd: this.cwd,
            env: { ...process.env },
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          // Wire abort signal
          const abortSignal = this.abortController?.signal;
          let abortHandler: (() => void) | undefined;
          if (abortSignal && !abortSignal.aborted) {
            abortHandler = () => {
              child.kill('SIGTERM');
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

          // 30s timeout for preflight checks
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Preflight check timed out: ${description}`));
          }, 30_000);

          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });

          child.stderr?.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          child.on('close', (code) => {
            clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }

            if (abortSignal?.aborted) {
              reject(new Error('Preflight check aborted'));
              return;
            }

            // Non-zero exit code is a failure
            if (code !== 0 && code !== null) {
              const stderr = stderrChunks.join('');
              reject(new Error(`Preflight check failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`));
              return;
            }

            resolve(stdoutChunks.join(''));
          });

          child.on('error', (err) => {
            clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }
            reject(new Error(`Preflight check error: ${err.message}`));
          });
        });

        // Check failIf condition
        if (check.failIf) {
          const trimmedOutput = output.trim();
          if (check.failIf === 'non-empty' && trimmedOutput.length > 0) {
            throw new Error(`Preflight failed: output is non-empty\n${trimmedOutput.slice(0, 200)}`);
          }
          if (check.failIf === 'empty' && trimmedOutput.length === 0) {
            throw new Error('Preflight failed: output is empty');
          }
          // Treat as regex pattern
          if (check.failIf !== 'non-empty' && check.failIf !== 'empty') {
            const regex = new RegExp(check.failIf);
            if (regex.test(output)) {
              throw new Error(`Preflight failed: output matches pattern "${check.failIf}"`);
            }
          }
        }

        // Check successIf condition
        if (check.successIf) {
          const regex = new RegExp(check.successIf);
          if (!regex.test(output)) {
            throw new Error(`Preflight failed: output does not match required pattern "${check.successIf}"`);
          }
        }

        this.postToChannel(`**[preflight]** ${description} — passed`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.postToChannel(`**[preflight]** ${description} — FAILED: ${errorMsg}`);
        throw new Error(`Preflight check failed: ${errorMsg}`);
      }
    }

    this.postToChannel('All preflight checks passed');
  }

  /** Check if a step is deterministic (shell command) vs agent (LLM-powered). */
  private isDeterministicStep(step: WorkflowStep): boolean {
    return step.type === 'deterministic';
  }

  /** Check if a step is a worktree (git worktree setup) step. */
  private isWorktreeStep(step: WorkflowStep): boolean {
    return step.type === 'worktree';
  }

  private async executeStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string
  ): Promise<void> {
    // Branch: deterministic steps execute shell commands
    if (this.isDeterministicStep(step)) {
      return this.executeDeterministicStep(step, stepStates, runId);
    }

    // Branch: worktree steps set up git worktrees
    if (this.isWorktreeStep(step)) {
      return this.executeWorktreeStep(step, stepStates, runId);
    }

    // Agent step execution
    return this.executeAgentStep(step, stepStates, agentMap, errorHandling, runId);
  }

  /**
   * Execute a deterministic step (shell command).
   * Fast, reliable, $0 LLM cost.
   */
  private async executeDeterministicStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    runId: string,
  ): Promise<void> {
    const state = stepStates.get(step.name);
    if (!state) throw new Error(`Step state not found: ${step.name}`);

    this.checkAborted();

    // Mark step as running
    state.row.status = 'running';
    state.row.startedAt = new Date().toISOString();
    await this.db.updateStep(state.row.id, {
      status: 'running',
      startedAt: state.row.startedAt,
      updatedAt: new Date().toISOString(),
    });
    this.emit({ type: 'step:started', runId, stepName: step.name });
    this.postToChannel(`**[${step.name}]** Started (deterministic)`);

    // Resolve variables in the command (e.g., {{steps.plan.output}}, {{branch-name}})
    const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
    let resolvedCommand = this.interpolateStepTask(step.command ?? '', stepOutputContext);

    // Also resolve simple {{variable}} placeholders (already resolved in top-level config but safe to re-run)
    resolvedCommand = resolvedCommand.replace(/\{\{([\w][\w.\-]*)\}\}/g, (_match, key: string) => {
      if (key.startsWith('steps.')) return _match; // Already handled above
      const value = this.resolveDotPath(key, stepOutputContext);
      return value !== undefined ? String(value) : _match;
    });

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = cpSpawn('sh', ['-c', resolvedCommand], {
          stdio: 'pipe',
          cwd: this.cwd,
          env: { ...process.env },
        });

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        // Wire abort signal
        const abortSignal = this.abortController?.signal;
        let abortHandler: (() => void) | undefined;
        if (abortSignal && !abortSignal.aborted) {
          abortHandler = () => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        // Handle timeout
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (step.timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          }, step.timeoutMs);
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk.toString());
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString());
        });

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }

          if (abortSignal?.aborted) {
            reject(new Error(`Step "${step.name}" aborted`));
            return;
          }

          if (timedOut) {
            reject(new Error(`Step "${step.name}" timed out after ${step.timeoutMs}ms`));
            return;
          }

          const stdout = stdoutChunks.join('');
          const stderr = stderrChunks.join('');

          // Check exit code unless failOnError is explicitly false
          const failOnError = step.failOnError !== false;
          if (failOnError && code !== 0 && code !== null) {
            reject(new Error(`Command failed with exit code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`));
            return;
          }

          resolve(step.captureOutput !== false ? stdout : `Command completed (exit code ${code ?? 0})`);
        });

        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          reject(new Error(`Failed to execute command: ${err.message}`));
        });
      });

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

      // Persist step output
      await this.persistStepOutput(runId, step.name, output);

      this.emit({ type: 'step:completed', runId, stepName: step.name, output });
      this.postToChannel(
        `**[${step.name}]** Completed (deterministic)\n${output.slice(0, 500)}${output.length > 500 ? '\n...(truncated)' : ''}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.postToChannel(`**[${step.name}]** Failed: ${errorMsg}`);
      await this.markStepFailed(state, errorMsg, runId);
      throw new Error(`Step "${step.name}" failed: ${errorMsg}`);
    }
  }

  /**
   * Execute a worktree step (git worktree setup).
   * Fast, reliable, $0 LLM cost.
   * Outputs the worktree path for downstream steps to use.
   */
  private async executeWorktreeStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    runId: string,
  ): Promise<void> {
    const state = stepStates.get(step.name);
    if (!state) throw new Error(`Step state not found: ${step.name}`);

    this.checkAborted();

    // Mark step as running
    state.row.status = 'running';
    state.row.startedAt = new Date().toISOString();
    await this.db.updateStep(state.row.id, {
      status: 'running',
      startedAt: state.row.startedAt,
      updatedAt: new Date().toISOString(),
    });
    this.emit({ type: 'step:started', runId, stepName: step.name });
    this.postToChannel(`**[${step.name}]** Started (worktree setup)`);

    // Resolve variables in branch name and path
    const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
    const branch = this.interpolateStepTask(step.branch ?? '', stepOutputContext);
    const baseBranch = step.baseBranch
      ? this.interpolateStepTask(step.baseBranch, stepOutputContext)
      : 'HEAD';
    const worktreePath = step.path
      ? this.interpolateStepTask(step.path, stepOutputContext)
      : path.join('.worktrees', step.name);
    const createBranch = step.createBranch !== false;

    if (!branch) {
      const errorMsg = 'Worktree step missing required "branch" field';
      await this.markStepFailed(state, errorMsg, runId);
      throw new Error(`Step "${step.name}" failed: ${errorMsg}`);
    }

    try {
      // Build the git worktree command
      // If createBranch is true and branch doesn't exist, use -b flag
      const absoluteWorktreePath = path.resolve(this.cwd, worktreePath);

      // First, check if the branch already exists
      const checkBranchCmd = `git rev-parse --verify --quiet ${branch} 2>/dev/null`;
      let branchExists = false;

      await new Promise<void>((resolve) => {
        const checkChild = cpSpawn('sh', ['-c', checkBranchCmd], {
          stdio: 'pipe',
          cwd: this.cwd,
          env: { ...process.env },
        });
        checkChild.on('close', (code) => {
          branchExists = code === 0;
          resolve();
        });
        checkChild.on('error', () => resolve());
      });

      // Build appropriate worktree add command
      let worktreeCmd: string;
      if (branchExists) {
        // Branch exists, just checkout into worktree
        worktreeCmd = `git worktree add "${absoluteWorktreePath}" ${branch}`;
      } else if (createBranch) {
        // Create new branch from baseBranch
        worktreeCmd = `git worktree add -b ${branch} "${absoluteWorktreePath}" ${baseBranch}`;
      } else {
        // Branch doesn't exist and we're not creating it
        const errorMsg = `Branch "${branch}" does not exist and createBranch is false`;
        await this.markStepFailed(state, errorMsg, runId);
        throw new Error(`Step "${step.name}" failed: ${errorMsg}`);
      }

      const output = await new Promise<string>((resolve, reject) => {
        const child = cpSpawn('sh', ['-c', worktreeCmd], {
          stdio: 'pipe',
          cwd: this.cwd,
          env: { ...process.env },
        });

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        // Wire abort signal
        const abortSignal = this.abortController?.signal;
        let abortHandler: (() => void) | undefined;
        if (abortSignal && !abortSignal.aborted) {
          abortHandler = () => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        // Handle timeout
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (step.timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          }, step.timeoutMs);
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk.toString());
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString());
        });

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }

          if (abortSignal?.aborted) {
            reject(new Error(`Step "${step.name}" aborted`));
            return;
          }

          if (timedOut) {
            reject(new Error(`Step "${step.name}" timed out after ${step.timeoutMs}ms`));
            return;
          }

          const stderr = stderrChunks.join('');

          if (code !== 0 && code !== null) {
            reject(new Error(`git worktree add failed with exit code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`));
            return;
          }

          // Output the worktree path for downstream steps
          resolve(absoluteWorktreePath);
        });

        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          reject(new Error(`Failed to execute git worktree command: ${err.message}`));
        });
      });

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

      // Persist step output
      await this.persistStepOutput(runId, step.name, output);

      this.emit({ type: 'step:completed', runId, stepName: step.name, output });
      this.postToChannel(
        `**[${step.name}]** Worktree created at: ${output}\n  Branch: ${branch}${!branchExists && createBranch ? ' (created)' : ''}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.postToChannel(`**[${step.name}]** Failed: ${errorMsg}`);
      await this.markStepFailed(state, errorMsg, runId);
      throw new Error(`Step "${step.name}" failed: ${errorMsg}`);
    }
  }

  /**
   * Execute an agent step (LLM-powered).
   */
  private async executeAgentStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string,
  ): Promise<void> {
    const state = stepStates.get(step.name);
    if (!state) throw new Error(`Step state not found: ${step.name}`);

    const agentName = step.agent;
    if (!agentName) {
      throw new Error(`Step "${step.name}" is missing required "agent" field`);
    }
    const agentDef = agentMap.get(agentName);
    if (!agentDef) {
      throw new Error(`Agent "${agentName}" not found in config`);
    }

    const maxRetries = step.retries ?? agentDef.constraints?.retries ?? errorHandling?.maxRetries ?? 0;
    const retryDelay = errorHandling?.retryDelayMs ?? 1000;
    const timeoutMs = step.timeoutMs ?? agentDef.constraints?.timeoutMs;

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.checkAborted();

      if (attempt > 0) {
        this.emit({ type: 'step:retrying', runId, stepName: step.name, attempt });
        this.postToChannel(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${maxRetries + 1})`);
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
        this.postToChannel(`**[${step.name}]** Started (agent: ${agentDef.name})`);
        await this.trajectory?.stepStarted(step, agentDef.name);

        // Resolve step-output variables (e.g. {{steps.plan.output}}) at execution time
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        let resolvedTask = this.interpolateStepTask(step.task ?? '', stepOutputContext);

        // If this is an interactive agent, append awareness of non-interactive workers
        // so the lead knows not to message them and to use step output chaining instead
        if (agentDef.interactive !== false) {
          const nonInteractiveInfo = this.buildNonInteractiveAwareness(agentMap, stepStates);
          if (nonInteractiveInfo) {
            resolvedTask += nonInteractiveInfo;
          }
        }

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

        // Persist step output to disk so it survives restarts and is inspectable
        await this.persistStepOutput(runId, step.name, output);

        this.emit({ type: 'step:completed', runId, stepName: step.name, output });
        this.postToChannel(
          `**[${step.name}]** Completed\n${output.slice(0, 500)}${output.length > 500 ? '\n...(truncated)' : ''}`
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
      `All ${maxRetries + 1} attempts failed: ${lastError ?? 'Unknown error'}`
    );
    this.postToChannel(`**[${step.name}]** Failed: ${lastError ?? 'Unknown error'}`);
    await this.markStepFailed(state, lastError ?? 'Unknown error', runId);
    throw new Error(
      `Step "${step.name}" failed after ${maxRetries} retries: ${lastError ?? 'Unknown error'}`
    );
  }

  /**
   * Build the CLI command and arguments for a non-interactive agent execution.
   * Each CLI has a specific flag for one-shot prompt mode.
   */
  static buildNonInteractiveCommand(
    cli: AgentCli,
    task: string,
    extraArgs: string[] = []
  ): { cmd: string; args: string[] } {
    switch (cli) {
      case 'claude':
        return { cmd: 'claude', args: ['-p', task, ...extraArgs] };
      case 'codex':
        return { cmd: 'codex', args: ['exec', task, ...extraArgs] };
      case 'gemini':
        return { cmd: 'gemini', args: ['-p', task, ...extraArgs] };
      case 'opencode':
        return { cmd: 'opencode', args: ['--prompt', task, ...extraArgs] };
      case 'droid':
        return { cmd: 'droid', args: ['exec', task, ...extraArgs] };
      case 'aider':
        return { cmd: 'aider', args: ['--message', task, '--yes-always', '--no-git', ...extraArgs] };
      case 'goose':
        return { cmd: 'goose', args: ['run', '--text', task, '--no-session', ...extraArgs] };
    }
  }

  /**
   * Execute an agent as a non-interactive subprocess.
   * No PTY, no relay messaging, no /exit injection. The process receives its task
   * as a CLI argument and stdout is captured as the step output.
   */
  private async execNonInteractive(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number
  ): Promise<string> {
    const agentName = `${step.name}-${this.generateShortId()}`;
    const modelArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : [];

    // Append strict deliverable enforcement — non-interactive agents MUST produce
    // clear, structured output since there's no opportunity for follow-up or clarification.
    const taskWithDeliverable =
      step.task +
      '\n\n---\n' +
      'CRITICAL REQUIREMENT — YOU MUST FOLLOW THIS EXACTLY:\n' +
      'You are running in non-interactive mode. There is NO opportunity for follow-up, ' +
      'clarification, or additional input. Your stdout output is your ONLY deliverable.\n\n' +
      'You MUST:\n' +
      '1. Complete the ENTIRE task in a single pass — no partial work, no "I\'ll continue later"\n' +
      '2. Print your COMPLETE deliverable to stdout — this is the ONLY output that will be captured\n' +
      '3. Be thorough and self-contained — another agent will consume your output with zero context about your process\n' +
      '4. End with a clear summary of what was accomplished and any artifacts produced\n\n' +
      'DO NOT:\n' +
      '- Ask questions or request clarification (there is no one to answer)\n' +
      '- Output partial results expecting a follow-up (there will be none)\n' +
      '- Skip steps or leave work incomplete\n' +
      '- Output only status messages without the actual deliverable content';

    const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand(
      agentDef.cli,
      taskWithDeliverable,
      modelArgs
    );

    // Open a log file for dashboard observability
    const logsDir = this.getWorkerLogsDir();
    const logPath = path.join(logsDir, `${agentName}.log`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    // Register in workers.json with interactive: false metadata
    this.registerWorker(agentName, agentDef.cli, step.task ?? '', undefined, false);

    // Register agent in Relaycast for observability
    let stopHeartbeat: (() => void) | undefined;
    if (this.relaycastApi) {
      const agentClient = await this.relaycastApi
        .registerExternalAgent(
          agentName,
          `Non-interactive workflow agent for step "${step.name}" (${agentDef.cli})`
        )
        .catch((err) => {
          console.warn(`[WorkflowRunner] Failed to register ${agentName} in Relaycast:`, err?.message ?? err);
          return null;
        });
      if (agentClient) {
        stopHeartbeat = this.relaycastApi.startHeartbeat(agentClient);
      }
    }

    // Post task assignment to channel for observability
    const taskText = step.task ?? '';
    const taskPreview = taskText.slice(0, 500) + (taskText.length > 500 ? '...' : '');
    this.postToChannel(`**[${step.name}]** Assigned to \`${agentName}\` (non-interactive):\n${taskPreview}`);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = cpSpawn(cmd, args, {
          stdio: 'pipe',
          cwd: agentDef.cwd ? path.resolve(this.cwd, agentDef.cwd) : this.cwd,
          env: { ...process.env },
        });

        // Update workers.json with PID now that we have it
        this.registerWorker(agentName, agentDef.cli, step.task ?? '', child.pid, false);

        // Wire abort signal so runner.abort() kills the child process
        const abortSignal = this.abortController?.signal;
        let abortHandler: (() => void) | undefined;
        if (abortSignal && !abortSignal.aborted) {
          abortHandler = () => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stdoutChunks.push(text);
          logStream.write(text);
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stderrChunks.push(text);
          logStream.write(`[stderr] ${text}`);
        });

        // Handle timeout
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Give process time to clean up, then force kill
            setTimeout(() => child.kill('SIGKILL'), 5000);
          }, timeoutMs);
        }

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          const stdout = stdoutChunks.join('');

          if (abortSignal?.aborted) {
            reject(new Error(`Step "${step.name}" aborted`));
            return;
          }

          if (timedOut) {
            reject(new Error(`Step "${step.name}" timed out after ${timeoutMs}ms`));
            return;
          }

          if (code !== 0 && code !== null) {
            const stderr = stderrChunks.join('');
            reject(
              new Error(
                `Step "${step.name}" exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
              )
            );
            return;
          }

          resolve(stdout);
        });

        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
        });
      });

      return output;
    } finally {
      stopHeartbeat?.();
      logStream.end();
      this.unregisterWorker(agentName);
    }
  }

  private async spawnAndWait(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number
  ): Promise<string> {
    // Branch: non-interactive agents run as simple subprocesses
    if (agentDef.interactive === false) {
      return this.execNonInteractive(agentDef, step, timeoutMs);
    }

    if (!this.relay) {
      throw new Error('AgentRelay not initialized');
    }

    // Append self-termination instructions to the task
    let agentName = `${step.name}-${this.generateShortId()}`;

    // Only inject delegation guidance for lead/coordinator agents, not spokes/workers.
    // In non-hub patterns (pipeline, dag, etc.) every agent is autonomous so they all get it.
    const role = agentDef.role?.toLowerCase() ?? '';
    const nameLC = agentDef.name.toLowerCase();
    const isHub =
      WorkflowRunner.HUB_ROLES.has(nameLC) ||
      [...WorkflowRunner.HUB_ROLES].some((r) => role.includes(r));
    const pattern = this.currentConfig?.swarm.pattern;
    const isHubPattern = pattern && WorkflowRunner.HUB_PATTERNS.has(pattern);
    const delegationGuidance =
      isHub || !isHubPattern ? this.buildDelegationGuidance(agentDef.cli, timeoutMs) : '';

    const taskWithExit =
      step.task +
      (delegationGuidance ? '\n\n' + delegationGuidance + '\n' : '') +
      '\n\n---\n' +
      'IMPORTANT: When you have fully completed this task, you MUST self-terminate by outputting ' +
      'the exact text "/exit" on its own line. Do not call any MCP tools to exit — just print /exit. ' +
      'Do not wait for further input — output /exit immediately after finishing.';

    // Register PTY output listener before spawning so we capture everything
    this.ptyOutputBuffers.set(agentName, []);

    // Open a log file so `agents:logs <name>` works for workflow-spawned agents
    const logsDir = this.getWorkerLogsDir();
    const logStream = createWriteStream(path.join(logsDir, `${agentName}.log`), { flags: 'a' });
    this.ptyLogStreams.set(agentName, logStream);

    this.ptyListeners.set(agentName, (chunk: string) => {
      const stripped = WorkflowRunner.stripAnsi(chunk);
      this.ptyOutputBuffers.get(agentName)?.push(stripped);
      // Write raw output (with ANSI codes) to log file so dashboard's
      // XTermLogViewer can render colors/formatting natively via xterm.js
      logStream.write(chunk);
    });

    const agentChannels = this.channel ? [this.channel] : agentDef.channels;

    let agent: Awaited<ReturnType<typeof this.relay.spawnPty>>;
    let exitResult: string = 'unknown';
    let stopHeartbeat: (() => void) | undefined;
    let ptyChunks: string[] = [];

    try {
      agent = await this.relay.spawnPty({
        name: agentName,
        cli: agentDef.cli,
        model: agentDef.constraints?.model,
        args: [],
        channels: agentChannels,
        task: taskWithExit,
        idleThresholdSecs: agentDef.constraints?.idleThresholdSecs,
        cwd: agentDef.cwd ? path.resolve(this.cwd, agentDef.cwd) : undefined,
      });

      // Re-key PTY maps if broker assigned a different name than requested
      if (agent.name !== agentName) {
        const oldName = agentName;
        this.ptyOutputBuffers.set(agent.name, this.ptyOutputBuffers.get(oldName) ?? []);
        this.ptyOutputBuffers.delete(oldName);

        // Close old log stream and rename the file to match the new agent name
        const oldLogPath = path.join(logsDir, `${oldName}.log`);
        const newLogPath = path.join(logsDir, `${agent.name}.log`);
        const oldLogStream = this.ptyLogStreams.get(oldName);
        if (oldLogStream) {
          oldLogStream.end();
          this.ptyLogStreams.delete(oldName);
          try {
            renameSync(oldLogPath, newLogPath);
          } catch {
            // File may not exist yet if no output was written
          }
        }

        // Open new log stream with the correct name
        const newLogStream = createWriteStream(newLogPath, { flags: 'a' });
        this.ptyLogStreams.set(agent.name, newLogStream);

        // Update listener to use the new log stream
        const oldListener = this.ptyListeners.get(oldName);
        if (oldListener) {
          this.ptyListeners.delete(oldName);
          this.ptyListeners.set(agent.name, (chunk: string) => {
            const stripped = WorkflowRunner.stripAnsi(chunk);
            this.ptyOutputBuffers.get(agent.name)?.push(stripped);
            newLogStream.write(chunk);
          });
        }

        agentName = agent.name;
      }

      // Register in workers.json so `agents:kill` can find this agent
      let workerPid: number | undefined;
      try {
        const rawAgents = await this.relay!.listAgentsRaw();
        workerPid = rawAgents.find((a) => a.name === agentName)?.pid ?? undefined;
      } catch {
        // Best-effort PID lookup
      }
      this.registerWorker(agentName, agentDef.cli, step.task ?? '', workerPid);

      // Register the spawned agent in Relaycast for observability + start heartbeat
      if (this.relaycastApi) {
        const agentClient = await this.relaycastApi
          .registerExternalAgent(agent.name, `Workflow agent for step "${step.name}" (${agentDef.cli})`)
          .catch((err) => {
            console.warn(
              `[WorkflowRunner] Failed to register ${agent.name} in Relaycast:`,
              err?.message ?? err
            );
            return null;
          });

        // Keep the agent online in the dashboard while it's working
        if (agentClient) {
          stopHeartbeat = this.relaycastApi.startHeartbeat(agentClient);
        }
      }

      // Invite the spawned agent to the workflow channel
      if (this.channel && this.relaycastApi) {
        await this.relaycastApi.inviteToChannel(this.channel, agent.name).catch(() => {});
      }

      // Post task assignment to channel for observability
      const taskTextForPreview = step.task ?? '';
      const taskPreview = taskTextForPreview.slice(0, 500) + (taskTextForPreview.length > 500 ? '...' : '');
      this.postToChannel(`**[${step.name}]** Assigned to \`${agent.name}\`:\n${taskPreview}`);

      // Register agent handle for hub-mediated nudging
      this.activeAgentHandles.set(agentName, agent);

      // Wait for agent to exit, with idle nudging if configured
      exitResult = await this.waitForExitWithIdleNudging(agent, agentDef, step, timeoutMs);

      // Stop heartbeat now that agent has exited
      stopHeartbeat?.();

      if (exitResult === 'timeout') {
        // Safety net: check if the verification file exists before giving up.
        // The agent may have completed work but failed to /exit.
        if (step.verification?.type === 'file_exists') {
          const verifyPath = path.resolve(this.cwd, step.verification.value);
          if (existsSync(verifyPath)) {
            this.postToChannel(`**[${step.name}]** Agent idle after completing work — releasing`);
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
    } finally {
      // Snapshot PTY chunks before cleanup — we need them for output reading below
      ptyChunks = this.ptyOutputBuffers.get(agentName) ?? [];

      // Always clean up PTY resources — prevents fd leaks if spawnPty or waitForExit throws
      stopHeartbeat?.();
      this.activeAgentHandles.delete(agentName);
      this.ptyOutputBuffers.delete(agentName);
      this.ptyListeners.delete(agentName);
      const stream = this.ptyLogStreams.get(agentName);
      if (stream) {
        stream.end();
        this.ptyLogStreams.delete(agentName);
      }
      this.unregisterWorker(agentName);
    }

    let output: string;
    if (ptyChunks.length > 0) {
      output = ptyChunks.join('');
    } else {
      // Legacy fallback: summary file
      const summaryPath = path.join(this.summaryDir, `${step.name}.md`);
      output = existsSync(summaryPath)
        ? await readFile(summaryPath, 'utf-8')
        : exitResult === 'timeout'
          ? 'Agent completed (released after idle timeout)'
          : exitResult === 'released'
            ? 'Agent completed (force-released after idle nudging)'
            : `Agent exited (${exitResult})`;
    }

    return output;
  }

  // ── Idle nudging ────────────────────────────────────────────────────────

  /** Patterns where a hub agent coordinates spoke agents. */
  private static readonly HUB_PATTERNS = new Set<string>([
    'fan-out',
    'hub-spoke',
    'hierarchical',
    'map-reduce',
    'scatter-gather',
    'supervisor',
    'saga',
    'auction',
  ]);

  /** Roles that indicate a coordinator/lead agent (eligible for delegation guidance). */
  private static readonly HUB_ROLES = new Set([
    'lead',
    'hub',
    'coordinator',
    'supervisor',
    'orchestrator',
    'auctioneer',
  ]);

  /**
   * Wait for agent exit with idle detection and nudging.
   * If no idle nudge config is set, falls through to simple waitForExit.
   */
  private async waitForExitWithIdleNudging(
    agent: Agent,
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number
  ): Promise<'exited' | 'timeout' | 'released'> {
    const nudgeConfig = this.currentConfig?.swarm.idleNudge;
    if (!nudgeConfig) {
      // No nudge config — backward compatible simple wait
      return agent.waitForExit(timeoutMs);
    }

    const nudgeAfterMs = nudgeConfig.nudgeAfterMs ?? 120_000;
    const escalateAfterMs = nudgeConfig.escalateAfterMs ?? 120_000;
    const maxNudges = nudgeConfig.maxNudges ?? 1;

    let nudgeCount = 0;
    const startTime = Date.now();

    while (true) {
      // Calculate remaining time from overall timeout
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs ? timeoutMs - elapsed : undefined;
      if (remaining !== undefined && remaining <= 0) {
        return 'timeout';
      }

      // Determine how long to wait for idle: first time use nudgeAfterMs, after nudge use escalateAfterMs
      const idleWaitMs = nudgeCount === 0 ? nudgeAfterMs : escalateAfterMs;
      // Cap at remaining overall timeout
      const waitMs = remaining !== undefined ? Math.min(idleWaitMs, remaining) : idleWaitMs;

      // Race: exit vs idle
      const exitPromise = agent.waitForExit(waitMs);
      const idlePromise = agent.waitForIdle(waitMs);

      const result = await Promise.race([
        exitPromise.then((r) => ({ source: 'exit' as const, result: r })),
        idlePromise.then((r) => ({ source: 'idle' as const, result: r })),
      ]);

      if (result.source === 'exit') {
        // Agent exited, released, or timed out naturally
        return result.result;
      }

      // Idle detected
      if (result.result === 'exited') {
        // Agent exited while we were waiting for idle
        return 'exited';
      }

      if (result.result === 'timeout') {
        // Our wait timed out — check overall timeout
        if (remaining !== undefined && Date.now() - startTime >= timeoutMs!) {
          return 'timeout';
        }
        // The idle event didn't fire within our wait window, loop again
        continue;
      }

      // result.result === 'idle' — agent went idle
      if (nudgeCount < maxNudges) {
        // Send nudge
        await this.nudgeIdleAgent(agent, agentDef, step);
        nudgeCount++;
        this.postToChannel(`**[${step.name}]** Agent \`${agent.name}\` idle — nudge #${nudgeCount} sent`);
        this.emit({ type: 'step:nudged', runId: this.currentRunId ?? '', stepName: step.name, nudgeCount });
        // Continue loop — wait for next idle or exit
        continue;
      }

      // Exhausted nudges — force-release
      this.postToChannel(
        `**[${step.name}]** Agent \`${agent.name}\` still idle after ${nudgeCount} nudge(s) — force-releasing`
      );
      this.emit({ type: 'step:force-released', runId: this.currentRunId ?? '', stepName: step.name });
      await agent.release();
      return 'released';
    }
  }

  /**
   * Send a nudge to an idle agent. Uses hub-mediated nudge for hub patterns,
   * or direct system injection otherwise.
   */
  private async nudgeIdleAgent(agent: Agent, agentDef: AgentDefinition, step: WorkflowStep): Promise<void> {
    const hubAgent = this.resolveHubForNudge(agentDef);

    if (hubAgent) {
      // Hub-mediated: tell the hub to check on the idle agent
      try {
        await hubAgent.sendMessage({
          to: agent.name,
          text: `Agent ${agent.name} appears idle on step "${step.name}". Check on them and remind them to /exit when done.`,
        });
        return; // Hub nudge succeeded
      } catch {
        // Fall through to direct nudge
      }
    }

    // Direct system injection via human handle
    if (this.relay) {
      const human = this.relay.human({ name: 'workflow-runner' });
      await human
        .sendMessage({
          to: agent.name,
          text: "You appear idle. If you've completed your task, output /exit. If still working, continue.",
        })
        .catch(() => {
          // Non-critical — don't break workflow
        });
    }
  }

  /**
   * Find the hub agent for hub-mediated nudging.
   * Returns the hub's live Agent handle if this is a hub pattern and the idle agent is not the hub.
   */
  private resolveHubForNudge(idleAgentDef: AgentDefinition): Agent | undefined {
    const pattern = this.currentConfig?.swarm.pattern;
    if (!pattern || !WorkflowRunner.HUB_PATTERNS.has(pattern)) {
      return undefined;
    }

    // Find an interactive agent with a hub-like role
    const agents = this.currentConfig?.agents ?? [];

    for (const agentDef of agents) {
      // Skip non-interactive and the idle agent itself
      if (agentDef.interactive === false) continue;
      if (agentDef.name === idleAgentDef.name) continue;

      const role = agentDef.role?.toLowerCase() ?? '';
      const nameLC = agentDef.name.toLowerCase();

      if (
        WorkflowRunner.HUB_ROLES.has(nameLC) ||
        [...WorkflowRunner.HUB_ROLES].some((r) => role.includes(r))
      ) {
        // Found a hub candidate — check if we have a live handle
        const handle = this.activeAgentHandles.get(agentDef.name);
        if (handle) return handle;
      }
    }

    return undefined;
  }

  // ── Verification ────────────────────────────────────────────────────────

  private runVerification(check: VerificationCheck, output: string, stepName: string): void {
    switch (check.type) {
      case 'output_contains':
        if (!output.includes(check.value)) {
          throw new Error(`Verification failed for "${stepName}": output does not contain "${check.value}"`);
        }
        break;

      case 'exit_code':
        // exit_code verification is implicitly satisfied if the agent exited successfully
        break;

      case 'file_exists':
        if (!existsSync(path.resolve(this.cwd, check.value))) {
          throw new Error(`Verification failed for "${stepName}": file "${check.value}" does not exist`);
        }
        break;

      case 'custom':
        // Custom verifications are evaluated by callers; no-op here
        break;
    }
  }

  // ── State helpers ─────────────────────────────────────────────────────

  private async updateRunStatus(runId: string, status: WorkflowRunStatus, error?: string): Promise<void> {
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
    runId: string
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
            this.postToChannel(`**[${step.name}]** Skipped — upstream dependency "${current}" failed`);
            await this.trajectory?.stepSkipped(step, `Upstream dependency "${current}" failed`);
            await this.trajectory?.decide(
              `Whether to skip ${step.name}`,
              'skip',
              `Upstream dependency "${current}" failed`
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

  /**
   * Build a metadata note about non-interactive workers for inclusion in interactive agent tasks.
   * Returns undefined if there are no non-interactive agents.
   */
  private buildNonInteractiveAwareness(
    agentMap: Map<string, AgentDefinition>,
    stepStates: Map<string, StepState>
  ): string | undefined {
    const nonInteractive = [...agentMap.values()].filter((a) => a.interactive === false);
    if (nonInteractive.length === 0) return undefined;

    // Map agent names to their step names so the lead knows exact {{steps.X.output}} references
    const agentToSteps = new Map<string, string[]>();
    for (const [stepName, state] of stepStates) {
      const agentName = state.row.agentName;
      if (!agentName) continue; // Skip deterministic steps
      if (!agentToSteps.has(agentName)) agentToSteps.set(agentName, []);
      agentToSteps.get(agentName)!.push(stepName);
    }

    const lines = nonInteractive.map((a) => {
      const steps = agentToSteps.get(a.name) ?? [];
      const stepRefs = steps.map((s) => `{{steps.${s}.output}}`).join(', ');
      return `- ${a.name} (${a.cli}) — will return output when complete${stepRefs ? `. Access via: ${stepRefs}` : ''}`;
    });
    return (
      '\n\n---\n' +
      'Note: The following agents are non-interactive workers and cannot receive messages:\n' +
      lines.join('\n') +
      '\n' +
      'Do NOT attempt to message these agents. Use the {{steps.<name>.output}} references above to access their results.'
    );
  }

  /**
   * Build guidance that encourages agents to autonomously delegate subtasks
   * to helper agents when work is too complex for a single pass.
   */
  private buildDelegationGuidance(cli: string, timeoutMs?: number): string {
    const timeoutNote = timeoutMs
      ? `You have approximately ${Math.round(timeoutMs / 60000)} minutes before this step times out. ` +
        'Plan accordingly — delegate early if the work is substantial.\n\n'
      : '';

    // Option 2 (sub-agents via Task tool) is only available in Claude
    const subAgentOption =
      cli === 'claude'
        ? 'Option 2 — Use built-in sub-agents (Task tool) for research or scoped work:\n' +
          '  - Good for exploring code, reading files, or making targeted changes\n' +
          '  - Can run multiple sub-agents in parallel\n\n'
        : '';

    return (
      '---\n' +
      'AUTONOMOUS DELEGATION — READ THIS BEFORE STARTING:\n' +
      timeoutNote +
      'Before diving in, assess whether this task is too large or complex for a single agent. ' +
      'If it involves multiple independent subtasks, touches many files, or could take a long time, ' +
      'you should break it down and delegate to helper agents to avoid timeouts.\n\n' +
      'Option 1 — Spawn relay agents (for real parallel coding work):\n' +
      '  - relay_spawn(name="helper-1", cli="claude", task="Specific subtask description")\n' +
      '  - Coordinate via relay_send(to="helper-1", message="...")\n' +
      '  - Check on them with relay_inbox()\n' +
      '  - Clean up when done: relay_release(name="helper-1")\n\n' +
      subAgentOption +
      'Guidelines:\n' +
      '- You are the lead — delegate but stay in control, track progress, integrate results\n' +
      '- Give each helper a clear, self-contained task with enough context to work independently\n' +
      "- For simple or quick work, just do it yourself — don't over-delegate\n" +
      '- Always release spawned relay agents when their work is complete'
    );
  }

  /** Post a message to the workflow channel. Fire-and-forget — never throws or blocks. */
  private postToChannel(text: string): void {
    if (!this.relaycastApi || !this.channel) return;
    this.relaycastApi.sendToChannel(this.channel, text).catch(() => {
      // Non-critical — don't break workflow execution
    });
  }

  /** Post a rich completion report to the channel. */
  private postCompletionReport(
    workflowName: string,
    outcomes: StepOutcome[],
    summary: string,
    confidence: number
  ): void {
    const completed = outcomes.filter((o) => o.status === 'completed');
    const skipped = outcomes.filter((o) => o.status === 'skipped');
    const retried = outcomes.filter((o) => o.attempts > 1);

    const lines: string[] = [
      `## Workflow **${workflowName}** — Complete`,
      '',
      summary,
      `Confidence: ${Math.round(confidence * 100)}%`,
      '',
      '### Steps',
      ...completed.map(
        (o) =>
          `- **${o.name}** (${o.agent}) — passed${o.verificationPassed ? ' (verified)' : ''}${o.attempts > 1 ? ` after ${o.attempts} attempts` : ''}`
      ),
      ...skipped.map((o) => `- **${o.name}** — skipped`),
    ];

    if (retried.length > 0) {
      lines.push('', '### Retries');
      for (const o of retried) {
        lines.push(`- ${o.name}: ${o.attempts} attempts`);
      }
    }

    this.postToChannel(lines.join('\n'));
  }

  /** Post a failure report to the channel. */
  private postFailureReport(workflowName: string, outcomes: StepOutcome[], errorMsg: string): void {
    const completed = outcomes.filter((o) => o.status === 'completed');
    const failed = outcomes.filter((o) => o.status === 'failed');
    const skipped = outcomes.filter((o) => o.status === 'skipped');

    const lines: string[] = [
      `## Workflow **${workflowName}** — Failed`,
      '',
      `${completed.length}/${outcomes.length} steps passed. Error: ${errorMsg}`,
      '',
      '### Steps',
      ...completed.map((o) => `- **${o.name}** (${o.agent}) — passed`),
      ...failed.map((o) => `- **${o.name}** (${o.agent}) — FAILED: ${o.error ?? 'unknown'}`),
      ...skipped.map((o) => `- **${o.name}** — skipped`),
    ];

    this.postToChannel(lines.join('\n'));
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
    const stepsWithVerification = new Set(steps?.filter((s) => s.verification).map((s) => s.name) ?? []);
    const outcomes: StepOutcome[] = [];
    for (const [name, state] of stepStates) {
      outcomes.push({
        name,
        agent: state.row.agentName ?? 'deterministic',
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

  /** Strip ANSI escape codes from terminal output — delegates to pty.ts canonical regex. */
  private static stripAnsi(text: string): string {
    return stripAnsiFn(text);
  }

  /** Sanitize a workflow name into a valid channel name. */
  private sanitizeChannelName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32);
  }

  /** Directory for persisted step outputs: .agent-relay/step-outputs/{runId}/ */
  private getStepOutputDir(runId: string): string {
    return path.join(this.cwd, '.agent-relay', 'step-outputs', runId);
  }

  /** Persist step output to disk and post full output as a channel message. */
  private async persistStepOutput(runId: string, stepName: string, output: string): Promise<void> {
    // 1. Write to disk
    try {
      const dir = this.getStepOutputDir(runId);
      mkdirSync(dir, { recursive: true });
      const cleaned = WorkflowRunner.stripAnsi(output);
      await writeFile(path.join(dir, `${stepName}.md`), cleaned);
    } catch {
      // Non-critical
    }

    // 2. Post full output as a threaded channel message for retrieval via Relaycast
    const cleaned = WorkflowRunner.stripAnsi(output);
    const maxMsg = 4000; // Relaycast message size limit
    if (cleaned.length <= maxMsg) {
      this.postToChannel(`**[${stepName}] Output:**\n\`\`\`\n${cleaned}\n\`\`\``);
    } else {
      // Split into chunks for large outputs
      const chunks = Math.ceil(cleaned.length / maxMsg);
      for (let i = 0; i < chunks; i++) {
        const slice = cleaned.slice(i * maxMsg, (i + 1) * maxMsg);
        this.postToChannel(`**[${stepName}] Output (${i + 1}/${chunks}):**\n\`\`\`\n${slice}\n\`\`\``);
      }
    }
  }

  /** Load persisted step output from disk. */
  private loadStepOutput(runId: string, stepName: string): string | undefined {
    try {
      const filePath = path.join(this.getStepOutputDir(runId), `${stepName}.md`);
      if (!existsSync(filePath)) return undefined;
      return readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** Get or create the worker logs directory (.agent-relay/team/worker-logs) */
  private getWorkerLogsDir(): string {
    const logsDir = path.join(this.cwd, '.agent-relay', 'team', 'worker-logs');
    mkdirSync(logsDir, { recursive: true });
    return logsDir;
  }

  /** Register a spawned agent in workers.json so `agents:kill` can find it. */
  private registerWorker(
    agentName: string,
    cli: string,
    task: string,
    pid?: number,
    interactive = true
  ): void {
    // Track in memory first (no race condition)
    const workerEntry = {
      cli,
      task: task.slice(0, 500),
      spawnedAt: Date.now(),
      pid,
      interactive,
      logFile: path.join(this.getWorkerLogsDir(), `${agentName}.log`),
    };
    this.activeWorkers.set(agentName, workerEntry);

    // Serialize file writes with mutex to prevent race conditions
    this.workersFileLock = this.workersFileLock.then(() => {
      try {
        mkdirSync(path.dirname(this.workersPath), { recursive: true });
        // Filter out any existing entry with the same name before adding
        const existing = this.readWorkers().filter((w) => w.name !== agentName);
        existing.push({ name: agentName, ...workerEntry });
        this.writeWorkers(existing);
      } catch {
        // Non-critical — don't fail the workflow if workers.json can't be written
      }
    });
  }

  /** Remove a spawned agent from workers.json after it exits. */
  private unregisterWorker(agentName: string): void {
    // Remove from in-memory tracking first
    this.activeWorkers.delete(agentName);

    // Serialize file writes with mutex to prevent race conditions
    this.workersFileLock = this.workersFileLock.then(() => {
      try {
        const existing = this.readWorkers();
        const filtered = existing.filter((w) => w.name !== agentName);
        this.writeWorkers(filtered);
      } catch {
        // Non-critical
      }
    });
  }

  private readWorkers(): Array<Record<string, unknown>> {
    try {
      if (!existsSync(this.workersPath)) return [];
      const raw = JSON.parse(readFileSync(this.workersPath, 'utf-8'));
      return Array.isArray(raw?.workers) ? raw.workers : [];
    } catch {
      return [];
    }
  }

  private writeWorkers(workers: Array<Record<string, unknown>>): void {
    writeFileSync(this.workersPath, JSON.stringify({ workers }, null, 2));
  }
}
