/**
 * WorkflowRunner — parses relay.yaml, validates config, resolves templates,
 * executes steps (sequential/parallel/DAG), runs verification checks,
 * persists state to DB, and supports pause/resume/abort with retries.
 */

import { spawn as cpSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent, WriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import chalk from 'chalk';

import { parse as parseYaml } from 'yaml';
import { stripAnsi as stripAnsiFn } from '../pty.js';
import type { BrokerEvent } from '../protocol.js';
import { resolveSpawnPolicy } from '../spawn-from-env.js';
import { getCliDefinition } from '../cli-registry.js';
import { resolveCliSync } from '../cli-resolver.js';

import {
  loadCustomSteps,
  resolveAllCustomSteps,
  validateCustomStepsUsage,
  CustomStepsParseError,
  CustomStepResolutionError,
} from './custom-steps.js';
import { collectCliSession, type CliSessionReport } from './cli-session-collector.js';
import { executeApiStep } from './api-executor.js';
import { ChannelMessenger } from './channel-messenger.js';
import { InMemoryWorkflowDb } from './memory-db.js';
import { buildCommand as buildProcessCommand, spawnProcess } from './process-spawner.js';
import { formatRunSummaryTable } from './run-summary-table.js';
import {
  StepExecutor as WorkflowStepLifecycleExecutor,
  type StepExecutorDeps as WorkflowStepLifecycleExecutorDeps,
} from './step-executor.js';
import {
  interpolateStepTask as interpolateStepTaskTemplate,
  resolveDotPath as resolveTemplateDotPath,
  resolveTemplate,
  TemplateResolver,
  type VariableContext,
} from './template-resolver.js';
import type {
  AgentCli,
  AgentDefinition,
  AgentPreset,
  CompletionEvidenceChannelOrigin,
  CompletionEvidenceChannelPost,
  CompletionEvidenceFileChange,
  CompletionEvidenceSignal,
  CompletionEvidenceSignalKind,
  CompletionEvidenceToolSideEffect,
  DryRunReport,
  DryRunWave,
  ErrorHandlingConfig,
  IdleNudgeConfig,
  PathDefinition,
  PreflightCheck,
  RelayYamlConfig,
  StepCompletionDecision,
  StepCompletionEvidence,
  SwarmPattern,
  VerificationCheck,
  WorkflowDefinition,
  WorkflowOwnerDecision,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowExecuteOptions,
  WorkflowStepCompletionReason,
  WorkflowStepRow,
  WorkflowStepStatus,
} from './types.js';
import { WorkflowTrajectory, type StepOutcome } from './trajectory.js';
import {
  runVerification,
  type VerificationOptions,
  type VerificationResult,
  WorkflowCompletionError,
} from './verification.js';

// ── AgentRelay SDK imports ──────────────────────────────────────────────────

// Import from sub-paths to avoid pulling in the full @relaycast/sdk dependency.
import { AgentRelay } from '../relay.js';
import type { Agent, AgentRelayOptions } from '../relay.js';
import { RelayCast, RelayError, type AgentClient } from '@relaycast/sdk';

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

/** Result returned by spawnAndWait / execNonInteractive with optional process exit info. */
interface SpawnResult {
  output: string;
  exitCode?: number;
  exitSignal?: string;
  promptTaskText?: string;
}

/** Error carrying exit code/signal from a failed subprocess spawn. */
class SpawnExitError extends Error {
  exitCode?: number;
  exitSignal?: string;
  constructor(message: string, exitCode?: number, exitSignal?: string | null) {
    super(message);
    this.name = 'SpawnExitError';
    this.exitCode = exitCode;
    this.exitSignal = exitSignal ?? undefined;
  }
}

interface CompletionDecisionResult {
  completionReason: WorkflowStepCompletionReason;
  ownerDecision?: WorkflowOwnerDecision;
  reason?: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: 'run:started'; runId: string }
  | { type: 'run:completed'; runId: string }
  | { type: 'run:failed'; runId: string; error: string }
  | { type: 'run:cancelled'; runId: string }
  | { type: 'broker:event'; runId: string; event: BrokerEvent }
  | { type: 'step:started'; runId: string; stepName: string }
  | {
      type: 'step:owner-assigned';
      runId: string;
      stepName: string;
      ownerName: string;
      specialistName: string;
    }
  | { type: 'step:completed'; runId: string; stepName: string; output?: string; exitCode?: number; exitSignal?: string }
  | {
      type: 'step:review-completed';
      runId: string;
      stepName: string;
      reviewerName: string;
      decision: 'approved' | 'rejected';
    }
  | { type: 'step:owner-timeout'; runId: string; stepName: string; ownerName: string }
  | { type: 'step:agent-report'; runId: string; stepName: string; report: CliSessionReport }
  | { type: 'step:failed'; runId: string; stepName: string; error: string; exitCode?: number; exitSignal?: string }
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
  executor?: StepExecutor;
  envSecrets?: Record<string, string>;
}

// ── Step executor interface ──────────────────────────────────────────────────

/**
 * Extension point for delegating step execution to an external backend
 * (e.g. Daytona sandboxes) while keeping the runner's DAG/retry/verification
 * machinery intact.
 */
export interface StepExecutor {
  executeAgentStep(
    step: WorkflowStep,
    agentDef: AgentDefinition,
    resolvedTask: string,
    timeoutMs?: number
  ): Promise<string>;

  executeDeterministicStep?(
    step: WorkflowStep,
    resolvedCommand: string,
    cwd: string
  ): Promise<{ output: string; exitCode: number }>;

  executeIntegrationStep?(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string }
  ): Promise<{ output: string; success: boolean }>;
}

// ── Internal step state ─────────────────────────────────────────────────────

interface StepState {
  row: WorkflowStepRow;
  agent?: Agent;
}

interface SupervisedStep {
  specialist: AgentDefinition;
  owner: AgentDefinition;
  reviewer?: AgentDefinition;
}

interface SpawnedAgentInfo {
  requestedName: string;
  actualName: string;
  agent: Agent;
}

interface SpawnAndWaitOptions {
  agentNameSuffix?: string;
  evidenceStepName?: string;
  evidenceRole?: string;
  logicalName?: string;
  preserveOnIdle?: boolean;
  onSpawned?: (info: SpawnedAgentInfo) => void | Promise<void>;
  onChunk?: (info: { agentName: string; chunk: string }) => void;
}

interface SupervisedRuntimeAgent {
  stepName: string;
  role: 'owner' | 'specialist';
  logicalName: string;
}

interface RuntimeStepAgent {
  stepName: string;
  role: string;
  logicalName: string;
}

interface FileSnapshotEntry {
  mtimeMs: number;
  size: number;
}

interface StepEvidenceRecord {
  evidence: StepCompletionEvidence;
  baselineSnapshots: Map<string, Map<string, FileSnapshotEntry>>;
  filesCaptured: boolean;
}

interface StepSignalParticipants {
  ownerSenders: Set<string>;
  workerSenders: Set<string>;
}

interface ChannelEvidenceOptions {
  stepName?: string;
  sender?: string;
  actor?: string;
  role?: string;
  target?: string;
  origin?: CompletionEvidenceChannelOrigin;
}

// ── CLI resolution ───────────────────────────────────────────────────────────

/**
 * Resolve `cursor` to the concrete cursor agent binary available in PATH.
 * Delegates to the consolidated cli-resolver which checks PATH + well-known
 * install directories. Falls back to `agent` if nothing found.
 */
function resolveCursorCli(): 'cursor-agent' | 'agent' {
  const resolved = resolveCliSync('cursor');
  return (resolved?.binary as 'cursor-agent' | 'agent') ?? 'agent';
}

// ── WorkflowRunner ──────────────────────────────────────────────────────────

export class WorkflowRunner {
  private readonly db: WorkflowDb;
  private readonly workspaceId: string;
  private readonly relayOptions: AgentRelayOptions;
  private readonly cwd: string;
  private readonly summaryDir: string;
  private readonly executor?: StepExecutor;
  private readonly envSecrets?: Record<string, string>;
  private readonly templateResolver: TemplateResolver;
  private readonly channelMessenger: ChannelMessenger;

  /** @internal exposed for CLI signal-handler shutdown only */
  relay?: AgentRelay;
  private relaycast?: RelayCast;
  private relaycastAgent?: AgentClient;
  private relayApiKey?: string;
  private relayApiKeyAutoCreated = false;
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
  /** Snapshot of PTY output from the most recent failed attempt, keyed by step name. */
  private readonly lastFailedStepOutput = new Map<string, string>();
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
  /** Timestamp when the current workflow run started, for elapsed-time logging. */
  private runStartTime?: number;
  /** Unsubscribe handle for broker stderr listener wired during a run. */
  private unsubBrokerStderr?: () => void;
  /** Tracks last idle log time per agent to debounce idle warnings (30s multiples). */
  private readonly lastIdleLog = new Map<string, number>();
  /** Tracks last logged activity type per agent to avoid duplicate status lines. */
  private readonly lastActivity = new Map<string, string>();
  /** Runtime-name lookup for agents participating in supervised owner flows. */
  private readonly supervisedRuntimeAgents = new Map<string, SupervisedRuntimeAgent>();
  /** Runtime-name lookup for active step agents so channel messages can be attributed to a step. */
  private readonly runtimeStepAgents = new Map<string, RuntimeStepAgent>();
  /** Per-step completion evidence collected across output, channel, files, and tool side-effects. */
  private readonly stepCompletionEvidence = new Map<string, StepEvidenceRecord>();
  /** Expected owner/worker identities per step so coordination signals can be validated by sender. */
  private readonly stepSignalParticipants = new Map<string, StepSignalParticipants>();
  /** Resolved named paths from the top-level `paths` config, keyed by name → absolute directory. */
  private resolvedPaths = new Map<string, string>();
  /** Tracks agent names currently assigned as reviewers (ref-counted to handle concurrent usage). */
  private readonly activeReviewers = new Map<string, number>();
  /** Structured CLI session reports captured during the current run, keyed by step name. */
  private readonly agentReports = new Map<string, CliSessionReport>();
  private static readonly PTY_TASK_ARG_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MB

  constructor(options: WorkflowRunnerOptions = {}) {
    this.db = options.db ?? new InMemoryWorkflowDb();
    this.workspaceId = options.workspaceId ?? 'local';
    this.relayOptions = options.relay ?? {};
    this.cwd = options.cwd ?? process.cwd();
    this.summaryDir = options.summaryDir ?? path.join(this.cwd, '.relay', 'summaries');
    this.workersPath = path.join(this.cwd, '.agent-relay', 'team', 'workers.json');
    this.executor = options.executor;
    this.envSecrets = options.envSecrets;
    this.templateResolver = new TemplateResolver();
    this.channelMessenger = new ChannelMessenger({ postFn: (text) => this.postToChannel(text) });
  }

  // ── Path resolution ─────────────────────────────────────────────────────

  /** Expand environment variables like $HOME or $VAR in a path string. */
  private static resolveEnvVars(p: string): string {
    return p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName: string) => {
      return process.env[varName] ?? _match;
    });
  }

  /**
   * Resolve and validate the top-level `paths` definitions from the config.
   * Returns a map of name → absolute directory path.
   * Throws if a required path does not exist.
   */
  private resolvePathDefinitions(
    pathDefs: PathDefinition[] | undefined,
    baseCwd: string
  ): { resolved: Map<string, string>; errors: string[]; warnings: string[] } {
    const resolved = new Map<string, string>();
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!pathDefs || pathDefs.length === 0) return { resolved, errors, warnings };

    const seenNames = new Set<string>();
    for (const pd of pathDefs) {
      if (seenNames.has(pd.name)) {
        errors.push(`Duplicate path name "${pd.name}"`);
        continue;
      }
      seenNames.add(pd.name);

      const expanded = WorkflowRunner.resolveEnvVars(pd.path);
      const abs = path.resolve(baseCwd, expanded);
      resolved.set(pd.name, abs);

      const isRequired = pd.required !== false; // default true
      if (!existsSync(abs)) {
        if (isRequired) {
          errors.push(`Path "${pd.name}" resolves to "${abs}" which does not exist (required)`);
        } else {
          warnings.push(`Path "${pd.name}" resolves to "${abs}" which does not exist (optional)`);
        }
      }
    }

    return { resolved, errors, warnings };
  }

  /**
   * Resolve an agent's effective working directory, considering `workdir` (named path reference)
   * and `cwd` (explicit path). `workdir` takes precedence when both are set.
   */
  private resolveAgentCwd(agent: AgentDefinition): string {
    if (agent.workdir) {
      const resolved = this.resolvedPaths.get(agent.workdir);
      if (!resolved) {
        throw new Error(
          `Agent "${agent.name}" references workdir "${agent.workdir}" which is not defined in paths`
        );
      }
      return resolved;
    }
    if (agent.cwd) {
      return path.resolve(this.cwd, agent.cwd);
    }
    return this.cwd;
  }

  /**
   * Resolve a step's working directory from its `workdir` field (named path reference).
   * Returns undefined if no workdir is set.
   */
  private resolveStepWorkdir(step: WorkflowStep): string | undefined {
    if (!step.workdir) return undefined;
    const resolved = this.resolvedPaths.get(step.workdir);
    if (!resolved) {
      throw new Error(
        `Step "${step.name}" references workdir "${step.workdir}" which is not defined in paths`
      );
    }
    return resolved;
  }

  private resolveEffectiveCwd(step: WorkflowStep, agentDef?: AgentDefinition): string {
    if (step.cwd) {
      return path.resolve(this.cwd, step.cwd);
    }
    return this.resolveStepWorkdir(step) ?? (agentDef ? this.resolveAgentCwd(agentDef) : this.cwd);
  }

  private static readonly EVIDENCE_IGNORED_DIRS = new Set([
    '.git',
    '.agent-relay',
    '.trajectories',
    'node_modules',
  ]);

  public getStepCompletionEvidence(stepName: string): StepCompletionEvidence | undefined {
    const record = this.stepCompletionEvidence.get(stepName);
    if (!record) return undefined;

    const evidence = structuredClone(record.evidence);
    return this.filterStepEvidenceBySignalProvenance(stepName, evidence);
  }

  private getOrCreateStepEvidenceRecord(stepName: string): StepEvidenceRecord {
    const existing = this.stepCompletionEvidence.get(stepName);
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: StepEvidenceRecord = {
      evidence: {
        stepName,
        lastUpdatedAt: now,
        roots: [],
        output: {
          stdout: '',
          stderr: '',
          combined: '',
        },
        channelPosts: [],
        files: [],
        process: {},
        toolSideEffects: [],
        coordinationSignals: [],
      },
      baselineSnapshots: new Map(),
      filesCaptured: false,
    };
    this.stepCompletionEvidence.set(stepName, record);
    return record;
  }

  private initializeStepSignalParticipants(
    stepName: string,
    ownerSender?: string,
    workerSender?: string
  ): void {
    this.stepSignalParticipants.set(stepName, {
      ownerSenders: new Set(),
      workerSenders: new Set(),
    });
    this.rememberStepSignalSender(stepName, 'owner', ownerSender);
    this.rememberStepSignalSender(stepName, 'worker', workerSender);
  }

  private rememberStepSignalSender(
    stepName: string,
    participant: 'owner' | 'worker',
    ...senders: Array<string | undefined>
  ): void {
    const participants =
      this.stepSignalParticipants.get(stepName) ??
      {
        ownerSenders: new Set<string>(),
        workerSenders: new Set<string>(),
      };
    this.stepSignalParticipants.set(stepName, participants);

    const target =
      participant === 'owner' ? participants.ownerSenders : participants.workerSenders;
    for (const sender of senders) {
      const trimmed = sender?.trim();
      if (trimmed) target.add(trimmed);
    }
  }

  private resolveSignalParticipantKind(role?: string): 'owner' | 'worker' | undefined {
    const roleLC = role?.toLowerCase().trim();
    if (!roleLC) return undefined;
    if (/\b(owner|lead|supervisor)\b/.test(roleLC)) return 'owner';
    if (/\b(worker|specialist|engineer|implementer)\b/.test(roleLC)) return 'worker';
    return undefined;
  }

  private isSignalFromExpectedSender(stepName: string, signal: CompletionEvidenceSignal): boolean {
    const expectedParticipant =
      signal.kind === 'worker_done'
        ? 'worker'
        : signal.kind === 'lead_done'
          ? 'owner'
          : undefined;
    if (!expectedParticipant) return true;

    const participants = this.stepSignalParticipants.get(stepName);
    if (!participants) return true;

    const allowedSenders =
      expectedParticipant === 'owner' ? participants.ownerSenders : participants.workerSenders;
    if (allowedSenders.size === 0) return true;

    const sender = signal.sender ?? signal.actor;
    if (sender) {
      return allowedSenders.has(sender);
    }

    const observedParticipant = this.resolveSignalParticipantKind(signal.role);
    if (observedParticipant) {
      return observedParticipant === expectedParticipant;
    }

    return signal.source !== 'channel';
  }

  private filterStepEvidenceBySignalProvenance(
    stepName: string,
    evidence: StepCompletionEvidence
  ): StepCompletionEvidence {
    evidence.channelPosts = evidence.channelPosts.map((post) => {
      const signals = post.signals.filter((signal) =>
        this.isSignalFromExpectedSender(stepName, signal)
      );
      return {
        ...post,
        completionRelevant: signals.length > 0,
        signals,
      };
    });
    evidence.coordinationSignals = evidence.coordinationSignals.filter((signal) =>
      this.isSignalFromExpectedSender(stepName, signal)
    );
    return evidence;
  }

  private beginStepEvidence(stepName: string, roots: Array<string | undefined>, startedAt?: string): void {
    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const evidence = record.evidence;
    const now = startedAt ?? new Date().toISOString();

    evidence.startedAt ??= now;
    evidence.status = 'running';
    evidence.lastUpdatedAt = now;

    for (const root of this.uniqueEvidenceRoots(roots)) {
      if (!evidence.roots.includes(root)) {
        evidence.roots.push(root);
      }
      if (!record.baselineSnapshots.has(root)) {
        record.baselineSnapshots.set(root, this.captureFileSnapshot(root));
      }
    }
  }

  private captureStepTerminalEvidence(
    stepName: string,
    output: { stdout?: string; stderr?: string; combined?: string },
    process?: { exitCode?: number; exitSignal?: string },
    meta?: { sender?: string; actor?: string; role?: string }
  ): void {
    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const evidence = record.evidence;
    const observedAt = new Date().toISOString();

    const append = (current: string, next?: string): string => {
      if (!next) return current;
      return current ? `${current}\n${next}` : next;
    };

    if (output.stdout) {
      evidence.output.stdout = append(evidence.output.stdout, output.stdout);
      for (const signal of this.extractCompletionSignals(output.stdout, 'stdout', observedAt, meta)) {
        evidence.coordinationSignals.push(signal);
      }
    }
    if (output.stderr) {
      evidence.output.stderr = append(evidence.output.stderr, output.stderr);
      for (const signal of this.extractCompletionSignals(output.stderr, 'stderr', observedAt, meta)) {
        evidence.coordinationSignals.push(signal);
      }
    }

    const combinedOutput =
      output.combined ??
      [output.stdout, output.stderr].filter((value): value is string => Boolean(value)).join('\n');
    if (combinedOutput) {
      evidence.output.combined = append(evidence.output.combined, combinedOutput);
    }

    if (process) {
      if (process.exitCode !== undefined) {
        evidence.process.exitCode = process.exitCode;
        evidence.coordinationSignals.push({
          kind: 'process_exit',
          source: 'process',
          text: `Process exited with code ${process.exitCode}`,
          observedAt,
          value: String(process.exitCode),
        });
      }
      if (process.exitSignal !== undefined) {
        evidence.process.exitSignal = process.exitSignal;
      }
    }

    evidence.lastUpdatedAt = observedAt;
  }

  private finalizeStepEvidence(
    stepName: string,
    status: WorkflowStepStatus,
    completedAt?: string,
    completionReason?: WorkflowStepCompletionReason
  ): void {
    const record = this.stepCompletionEvidence.get(stepName);
    if (!record) return;

    const evidence = record.evidence;
    const observedAt = completedAt ?? new Date().toISOString();
    evidence.status = status;
    if (status !== 'running') {
      evidence.completedAt = observedAt;
    }
    evidence.lastUpdatedAt = observedAt;

    if (!record.filesCaptured) {
      const existing = new Set(evidence.files.map((file) => `${file.kind}:${file.path}`));
      for (const root of evidence.roots) {
        const before = record.baselineSnapshots.get(root) ?? new Map<string, FileSnapshotEntry>();
        const after = this.captureFileSnapshot(root);
        for (const change of this.diffFileSnapshots(before, after, root, observedAt)) {
          const key = `${change.kind}:${change.path}`;
          if (existing.has(key)) continue;
          existing.add(key);
          evidence.files.push(change);
        }
      }
      record.filesCaptured = true;
    }

    if (completionReason) {
      const decision = this.buildStepCompletionDecision(stepName, completionReason);
      if (decision) {
        void this.trajectory?.stepCompletionDecision(stepName, decision);
      }
    }
  }

  private recordStepToolSideEffect(
    stepName: string,
    effect: Omit<CompletionEvidenceToolSideEffect, 'observedAt'> & { observedAt?: string }
  ): void {
    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const observedAt = effect.observedAt ?? new Date().toISOString();
    record.evidence.toolSideEffects.push({
      ...effect,
      observedAt,
    });
    record.evidence.lastUpdatedAt = observedAt;
  }

  private recordChannelEvidence(text: string, options: ChannelEvidenceOptions = {}): void {
    const stepName =
      options.stepName ??
      this.inferStepNameFromChannelText(text) ??
      (options.actor ? this.runtimeStepAgents.get(options.actor)?.stepName : undefined);
    if (!stepName) return;

    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const postedAt = new Date().toISOString();
    const sender = options.sender ?? options.actor;
    const signals = this.extractCompletionSignals(text, 'channel', postedAt, {
      sender,
      actor: options.actor,
      role: options.role,
    });

    const channelPost: CompletionEvidenceChannelPost = {
      stepName,
      text,
      postedAt,
      origin: options.origin ?? 'runner_post',
      completionRelevant: signals.length > 0,
      sender,
      actor: options.actor,
      role: options.role,
      target: options.target,
      signals,
    };

    record.evidence.channelPosts.push(channelPost);
    record.evidence.coordinationSignals.push(...signals);
    record.evidence.lastUpdatedAt = postedAt;
  }

  private extractCompletionSignals(
    text: string,
    source: CompletionEvidenceSignal['source'],
    observedAt: string,
    meta?: { sender?: string; actor?: string; role?: string }
  ): CompletionEvidenceSignal[] {
    const signals: CompletionEvidenceSignal[] = [];
    const seen = new Set<string>();
    const add = (
      kind: CompletionEvidenceSignalKind,
      signalText: string,
      value?: string
    ): void => {
      const trimmed = signalText.trim().slice(0, 280);
      if (!trimmed) return;
      const key = `${kind}:${trimmed}:${value ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      signals.push({
        kind,
        source,
        text: trimmed,
        observedAt,
        sender: meta?.sender,
        actor: meta?.actor,
        role: meta?.role,
        value,
      });
    };

    for (const match of text.matchAll(/\bWORKER_DONE\b(?::\s*([^\n]+))?/gi)) {
      add('worker_done', match[0], match[1]?.trim());
    }
    for (const match of text.matchAll(/\bLEAD_DONE\b(?::\s*([^\n]+))?/gi)) {
      add('lead_done', match[0], match[1]?.trim());
    }
    for (const match of text.matchAll(/\bSTEP_COMPLETE:([A-Za-z0-9_.:-]+)/g)) {
      add('step_complete', match[0], match[1]);
    }
    for (const match of text.matchAll(
      /\bOWNER_DECISION:\s*(COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/gi
    )) {
      add('owner_decision', match[0], match[1].toUpperCase());
    }
    for (const match of text.matchAll(/\bREVIEW_DECISION:\s*(APPROVE|REJECT)\b/gi)) {
      add('review_decision', match[0], match[1].toUpperCase());
    }
    if (/\bverification gate observed\b|\bverification passed\b/i.test(text)) {
      add('verification_passed', this.firstMeaningfulLine(text) ?? text);
    }
    if (/\bverification failed\b/i.test(text)) {
      add('verification_failed', this.firstMeaningfulLine(text) ?? text);
    }
    if (
      /\b(summary|handoff|ready for review|ready for handoff|task complete|work complete|completed work|finished work)\b/i.test(
        text
      )
    ) {
      add('task_summary', this.firstMeaningfulLine(text) ?? text);
    }

    return signals;
  }

  private inferStepNameFromChannelText(text: string): string | undefined {
    const bracketMatch = text.match(/^\*\*\[([^\]]+)\]/);
    if (bracketMatch?.[1]) return bracketMatch[1];

    const markerMatch = text.match(/\bSTEP_COMPLETE:([A-Za-z0-9_.:-]+)/);
    if (markerMatch?.[1]) return markerMatch[1];

    return undefined;
  }

  private uniqueEvidenceRoots(roots: Array<string | undefined>): string[] {
    return [...new Set(roots.filter((root): root is string => Boolean(root)).map((root) => path.resolve(root)))];
  }

  private captureFileSnapshot(root: string): Map<string, FileSnapshotEntry> {
    const snapshot = new Map<string, FileSnapshotEntry>();
    if (!existsSync(root)) return snapshot;

    const visit = (currentPath: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory() && WorkflowRunner.EVIDENCE_IGNORED_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }

        try {
          const stats = statSync(fullPath);
          if (!stats.isFile()) continue;
          snapshot.set(fullPath, { mtimeMs: stats.mtimeMs, size: stats.size });
        } catch {
          // Best-effort evidence collection only.
        }
      }
    };

    try {
      const stats = statSync(root);
      if (stats.isFile()) {
        snapshot.set(root, { mtimeMs: stats.mtimeMs, size: stats.size });
        return snapshot;
      }
    } catch {
      return snapshot;
    }

    visit(root);
    return snapshot;
  }

  private diffFileSnapshots(
    before: Map<string, FileSnapshotEntry>,
    after: Map<string, FileSnapshotEntry>,
    root: string,
    observedAt: string
  ): CompletionEvidenceFileChange[] {
    const allPaths = new Set([...before.keys(), ...after.keys()]);
    const changes: CompletionEvidenceFileChange[] = [];

    for (const filePath of allPaths) {
      const prior = before.get(filePath);
      const next = after.get(filePath);

      let kind: CompletionEvidenceFileChange['kind'] | undefined;
      if (!prior && next) {
        kind = 'created';
      } else if (prior && !next) {
        kind = 'deleted';
      } else if (prior && next && (prior.mtimeMs !== next.mtimeMs || prior.size !== next.size)) {
        kind = 'modified';
      }

      if (!kind) continue;

      changes.push({
        path: this.normalizeEvidencePath(filePath),
        kind,
        observedAt,
        root,
      });
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  private normalizeEvidencePath(filePath: string): string {
    const relative = path.relative(this.cwd, filePath);
    if (!relative || relative === '') return path.basename(filePath);
    return relative.startsWith('..') ? filePath : relative;
  }

  private buildStepCompletionDecision(
    stepName: string,
    completionReason: WorkflowStepCompletionReason
  ): StepCompletionDecision | undefined {
    let reason: string | undefined;
    let mode: StepCompletionDecision['mode'];
    switch (completionReason) {
      case 'completed_verified':
        mode = 'verification';
        reason = 'Verification passed';
        break;
      case 'completed_by_evidence':
        mode = 'evidence';
        reason = 'Completion inferred from collected evidence';
        break;
      case 'completed_by_owner_decision': {
        const evidence = this.getStepCompletionEvidence(stepName);
        const markerObserved = evidence?.coordinationSignals.some((signal) => signal.kind === 'step_complete');
        mode = markerObserved ? 'marker' : 'owner_decision';
        reason = markerObserved ? 'Legacy STEP_COMPLETE marker observed' : 'Owner approved completion';
        break;
      }
      default:
        return undefined;
    }

    return {
      mode,
      reason,
      evidence: this.buildTrajectoryCompletionEvidence(stepName),
    };
  }

  private buildTrajectoryCompletionEvidence(
    stepName: string
  ): StepCompletionDecision['evidence'] | undefined {
    const evidence = this.getStepCompletionEvidence(stepName);
    if (!evidence) return undefined;

    const signals = evidence.coordinationSignals
      .slice(-6)
      .map((signal) => signal.value ?? signal.text);
    const channelPosts = evidence.channelPosts
      .filter((post) => post.completionRelevant)
      .slice(-3)
      .map((post) => post.text.slice(0, 160));
    const files = evidence.files.slice(0, 6).map((file) => `${file.kind}:${file.path}`);

    const summaryParts: string[] = [];
    if (signals.length > 0) summaryParts.push(`${signals.length} signal(s)`);
    if (channelPosts.length > 0) summaryParts.push(`${channelPosts.length} relevant channel post(s)`);
    if (files.length > 0) summaryParts.push(`${files.length} file change(s)`);
    if (evidence.process.exitCode !== undefined) {
      summaryParts.push(`exit=${evidence.process.exitCode}`);
    }

    return {
      summary: summaryParts.length > 0 ? summaryParts.join(', ') : undefined,
      signals: signals.length > 0 ? signals : undefined,
      channelPosts: channelPosts.length > 0 ? channelPosts : undefined,
      files: files.length > 0 ? files : undefined,
      exitCode: evidence.process.exitCode,
    };
  }

  // ── Progress logging ────────────────────────────────────────────────────

  /** Log a progress message with elapsed time since run start. */
  private log(msg: string): void {
    const elapsed = this.runStartTime ? Math.round((Date.now() - this.runStartTime) / 1000) : 0;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const ts =
      mins > 0
        ? `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `00:${String(secs).padStart(2, '0')}`;
    console.log(`${chalk.dim.cyan('[workflow')} ${chalk.dim.cyan(ts)}${chalk.dim.cyan(']')} ${msg}`);
  }

  // ── Relaycast auto-provisioning ────────────────────────────────────────

  /**
   * Ensure a Relaycast workspace API key is available for the broker.
   * Resolution order:
   *   1. RELAY_API_KEY environment variable (explicit override)
   *   2. Auto-create a fresh workspace via the Relaycast API
   *
   * Each workflow run gets its own isolated workspace — no caching, no sharing.
   */
  private async ensureRelaycastApiKey(channel: string): Promise<void> {
    if (this.relayApiKey) return;

    // Explicit override from relayOptions or environment takes priority.
    const envKey = this.relayOptions.env?.RELAY_API_KEY ?? process.env.RELAY_API_KEY;
    if (envKey) {
      this.relayApiKey = envKey;
      return;
    }

    // Always create a fresh workspace — each run gets full isolation.
    const workspaceName = `relay-${channel}-${randomBytes(4).toString('hex')}`;
    const baseUrl =
      this.relayOptions.env?.RELAYCAST_BASE_URL ??
      process.env.RELAYCAST_BASE_URL ??
      'https://api.relaycast.dev';
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

    if (!apiKey) {
      throw new Error('Relaycast workspace response missing api_key');
    }

    this.relayApiKey = apiKey;
    this.relayApiKeyAutoCreated = true;

    // Best-effort: push the key to a co-running dashboard (agent-relay up) so it
    // can make Relaycast API calls without any file or manual env var setup.
    const dashboardPort = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';
    fetch(`http://127.0.0.1:${dashboardPort}/api/relay-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`[WorkflowRunner] dashboard key push failed: HTTP ${res.status}`);
        }
      })
      .catch(() => {
        // Dashboard not running — silently ignore.
      });
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

  private getRelaycastBaseUrl(): string {
    return (
      this.relayOptions.env?.RELAYCAST_BASE_URL ??
      process.env.RELAYCAST_BASE_URL ??
      'https://api.relaycast.dev'
    );
  }

  private getRelaycastClient(): RelayCast {
    if (!this.relayApiKey) {
      throw new Error('No Relaycast API key available');
    }
    if (!this.relaycast) {
      this.relaycast = new RelayCast({
        apiKey: this.relayApiKey,
        baseUrl: this.getRelaycastBaseUrl(),
      });
    }
    return this.relaycast;
  }

  private async ensureRelaycastRunnerAgent(): Promise<AgentClient> {
    if (this.relaycastAgent) return this.relaycastAgent;

    const rc = this.getRelaycastClient();
    let registration;
    try {
      registration = await rc.agents.register({ name: 'WorkflowRunner', type: 'agent' });
    } catch (err) {
      if (err instanceof RelayError && err.code === 'name_conflict') {
        registration = await rc.agents.register({
          name: `WorkflowRunner-${randomBytes(4).toString('hex')}`,
          type: 'agent',
        });
      } else {
        throw err;
      }
    }

    this.relaycastAgent = rc.as(registration.token);
    return this.relaycastAgent;
  }

  private async createAndJoinRelaycastChannel(channel: string, topic?: string): Promise<void> {
    const agent = await this.ensureRelaycastRunnerAgent();
    try {
      await agent.channels.create({ name: channel, ...(topic ? { topic } : {}) });
    } catch (err) {
      if (!(err instanceof RelayError && err.code === 'name_conflict')) {
        throw err;
      }
    }
    await agent.channels.join(channel);
  }

  private async registerRelaycastExternalAgent(name: string, persona?: string): Promise<AgentClient | null> {
    const rc = this.getRelaycastClient();
    try {
      const registration = await rc.agents.register({
        name,
        type: 'agent',
        ...(persona ? { persona } : {}),
      });
      return rc.as(registration.token);
    } catch (err) {
      if (err instanceof RelayError && err.code === 'name_conflict') {
        return null;
      }
      throw err;
    }
  }

  private startRelaycastHeartbeat(agent: AgentClient, intervalMs = 30_000): () => void {
    const beat = () => {
      agent.heartbeat().catch(() => {});
    };
    const timer = setInterval(beat, intervalMs);
    timer.unref();
    beat();
    return () => clearInterval(timer);
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
    const config = parsed as RelayYamlConfig;
    config.agents ??= [];
    return config;
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
    if (c.agents !== undefined && !Array.isArray(c.agents)) {
      throw new Error(`${source}: "agents" must be an array when provided`);
    }

    for (const agent of c.agents ?? []) {
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
        this.validateWorkflow(wf, (c.agents ?? []) as AgentDefinition[], source);
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

    // 1b. Resolve and validate named paths
    const pathResult = this.resolvePathDefinitions(resolved.paths, this.cwd);
    errors.push(...pathResult.errors);
    warnings.push(...pathResult.warnings);
    const dryRunPaths = pathResult.resolved;

    // Validate workdir references on agents
    for (const agent of resolved.agents) {
      if (agent.workdir && !dryRunPaths.has(agent.workdir)) {
        errors.push(
          `Agent "${agent.name}" references workdir "${agent.workdir}" which is not defined in paths`
        );
      }
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

    // Validate workdir references on steps
    for (const step of resolvedSteps) {
      if (step.workdir && !dryRunPaths.has(step.workdir)) {
        errors.push(
          `Step "${step.name}" references workdir "${step.workdir}" which is not defined in paths`
        );
      }
    }

    // Validate cwd paths
    for (const agent of resolved.agents) {
      if (agent.cwd) {
        const resolvedCwd = path.resolve(this.cwd, agent.cwd);
        if (!existsSync(resolvedCwd)) {
          warnings.push(
            `Agent "${agent.name}" cwd "${agent.cwd}" resolves to "${resolvedCwd}" which does not exist`
          );
        }
      }
      if (agent.additionalPaths) {
        for (const ap of agent.additionalPaths) {
          const resolvedPath = path.resolve(this.cwd, ap);
          if (!existsSync(resolvedPath)) {
            warnings.push(
              `Agent "${agent.name}" additionalPath "${ap}" resolves to "${resolvedPath}" which does not exist`
            );
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
      cwd: a.workdir ? dryRunPaths.get(a.workdir) : a.cwd,
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
      (s) => s.type !== 'deterministic' && s.type !== 'worktree' && s.type !== 'integration'
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

  private validateWorkflow(wf: unknown, agents: AgentDefinition[], source: string): void {
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
      } else if (s.type === 'integration') {
        // Integration steps require integration and action
        if (typeof s.integration !== 'string') {
          throw new Error(`${source}: integration step "${s.name}" must have an "integration" string field`);
        }
        if (typeof s.action !== 'string') {
          throw new Error(`${source}: integration step "${s.name}" must have an "action" string field`);
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
    this.detectLeadWorkerDeadlock(w.steps as WorkflowStep[], agents, source, w.name as string);

    // Warn if non-interactive agent task is excessively large before interpolation
    for (const step of w.steps as WorkflowStep[]) {
      if (step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration') continue;
      const agentDef = agents.find((a) => a.name === step.agent);
      const isNonInteractive =
        agentDef?.interactive === false || ['worker', 'reviewer', 'analyst'].includes(agentDef?.preset ?? '');
      if (isNonInteractive && (step.task ?? '').length > 10_000) {
        console.warn(
          `[WorkflowRunner] Warning: non-interactive step "${step.name}" has a very large task (${step.task!.length} chars). ` +
            `Consider pre-reading files in a deterministic step and injecting only the relevant excerpt.`
        );
      }
    }
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

  private detectLeadWorkerDeadlock(
    steps: WorkflowStep[],
    agents: AgentDefinition[],
    source: string,
    workflowName: string
  ): void {
    // Build a map of step name → steps that depend on it
    const downstreamOf = new Map<string, string[]>();
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!downstreamOf.has(dep)) downstreamOf.set(dep, []);
        downstreamOf.get(dep)!.push(step.name);
      }
    }

    for (const step of steps) {
      // Only check interactive agent steps (leads)
      if (step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration') continue;
      const agentDef = agents.find((a) => a.name === step.agent);
      // Skip non-interactive agents — they can't wait for channel signals
      if (
        agentDef?.interactive === false ||
        agentDef?.preset === 'worker' ||
        agentDef?.preset === 'reviewer' ||
        agentDef?.preset === 'analyst'
      )
        continue;

      const downstream = downstreamOf.get(step.name) ?? [];
      if (downstream.length === 0) continue;

      // Check if the task mentions downstream step names in a "waiting" context
      const task = step.task ?? '';
      const waitingKeywords = /\b(wait|waiting|monitor|check inbox|check.*channel|DONE|_DONE|signal)\b/i;
      if (!waitingKeywords.test(task)) continue;

      // Check if any downstream step name appears in the task
      const mentioned = downstream.filter((name) => task.includes(name));
      if (mentioned.length > 0) {
        throw new Error(
          `${source}: workflow "${workflowName}" likely has a lead\u2194worker deadlock. ` +
            `Step "${step.name}" (interactive lead) mentions downstream step(s) [${mentioned.join(', ')}] in its task ` +
            `and appears to wait for their signals, but those steps can't start until "${step.name}" completes. ` +
            `Fix: make workers depend on a shared upstream step (e.g. "context"), not on the lead step. ` +
            `See tests/workflows/README.md rule #6.`
        );
      }
    }
  }

  // ── Template variable resolution ────────────────────────────────────────

  /** Resolve {{variable}} placeholders in all task strings. */
  resolveVariables(config: RelayYamlConfig, vars: VariableContext): RelayYamlConfig {
    return this.templateResolver.resolveVariables(config, vars);
  }

  private interpolate(template: string, vars: VariableContext): string {
    return resolveTemplate(template, vars);
  }

  private resolveDotPath(key: string, vars: VariableContext): string | number | boolean | undefined {
    return resolveTemplateDotPath(key, vars);
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
    return interpolateStepTaskTemplate(template, context);
  }

  private createStepLifecycleExecutor(
    workflow: WorkflowDefinition,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string
  ): WorkflowStepLifecycleExecutor<StepState> {
    let lifecycle!: WorkflowStepLifecycleExecutor<StepState>;
    const deps: WorkflowStepLifecycleExecutorDeps<StepState> = {
      cwd: this.cwd,
      runId,
      templateResolver: this.templateResolver,
      channelMessenger: this.channelMessenger,
      verificationRunner: (check, output, stepName, injectedTaskText, options) =>
        this.runVerification(check, output, stepName, injectedTaskText, options),
      postToChannel: (text) => this.postToChannel(text),
      persistStepRow: async (stepId, patch) => this.db.updateStep(stepId, patch),
      persistStepOutput: async (lifecycleRunId, stepName, output) =>
        this.persistStepOutput(lifecycleRunId, stepName, output),
      loadStepOutput: (lifecycleRunId, stepName) => this.loadStepOutput(lifecycleRunId, stepName),
      checkAborted: () => this.checkAborted(),
      waitIfPaused: () => this.waitIfPaused(),
      log: (message) => this.log(message),
      onStepStarted: async (step) => {
        this.emit({ type: 'step:started', runId, stepName: step.name });
      },
      onStepCompleted: async (step, state, result) => {
        this.emit({
          type: 'step:completed',
          runId,
          stepName: step.name,
          output: result.output,
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
        });
        this.finalizeStepEvidence(
          step.name,
          result.status,
          state.row.completedAt,
          result.completionReason
        );
      },
      onStepFailed: async (step, state, result) => {
        this.captureStepTerminalEvidence(step.name, {}, {
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
        });
        this.emit({
          type: 'step:failed',
          runId,
          stepName: step.name,
          error: result.error ?? 'Unknown error',
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
        });
        this.finalizeStepEvidence(step.name, 'failed', state.row.completedAt, result.completionReason);
      },
      executeStep: async (step, state) => {
        await this.executeStep(step, state, stepStates, agentMap, errorHandling, runId, lifecycle);
        return {
          status: state.row.status,
          output: state.row.output ?? '',
          completionReason: state.row.completionReason,
          retries: state.row.retryCount,
          error: state.row.error,
        };
      },
      onBeginTrack: async (steps) => {
        if (steps.length > 1 && this.trajectory) {
          await this.trajectory.beginTrack(steps.map((step) => step.name).join(', '));
        }
      },
      onConverge: async (readySteps, batchOutcomes) => {
        if (readySteps.length <= 1 || !this.trajectory?.shouldReflectOnConverge()) {
          return;
        }

        const completedNames = new Set(
          batchOutcomes.filter((outcome) => outcome.status === 'completed').map((outcome) => outcome.name)
        );
        const unblocked = workflow.steps
          .filter((step) => step.dependsOn?.some((dependency) => completedNames.has(dependency)))
          .filter((step) => stepStates.get(step.name)?.row.status === 'pending')
          .map((step) => step.name);

        await this.trajectory.synthesizeAndReflect(
          readySteps.map((step) => step.name).join(' + '),
          batchOutcomes,
          unblocked.length > 0 ? unblocked : undefined
        );
      },
      markDownstreamSkipped: async (failedStepName) =>
        this.markDownstreamSkipped(failedStepName, workflow.steps, stepStates, runId),
      buildCompletionMode: (stepName, completionReason) =>
        completionReason
          ? this.buildStepCompletionDecision(stepName, completionReason)?.mode
          : undefined,
    };

    lifecycle = new WorkflowStepLifecycleExecutor<StepState>(deps);
    return lifecycle;
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /** Execute a named workflow from a validated config. */
  async execute(
    config: RelayYamlConfig,
    workflowName?: string,
    vars?: VariableContext,
    executeOptions?: WorkflowExecuteOptions
  ): Promise<WorkflowRunRow> {
    // Set up abort controller early so callers can abort() even during setup
    this.abortController = new AbortController();
    this.paused = false;

    const resolved = vars ? this.resolveVariables(config, vars) : config;

    // Validate config (catches cycles, missing deps, invalid steps, etc.)
    this.validateConfig(resolved);

    // Resolve and validate named paths from the top-level `paths` config
    const pathResult = this.resolvePathDefinitions(resolved.paths, this.cwd);
    if (pathResult.errors.length > 0) {
      throw new Error(`Path validation failed:\n  ${pathResult.errors.join('\n  ')}`);
    }
    this.resolvedPaths = pathResult.resolved;
    if (this.resolvedPaths.size > 0) {
      for (const [name, abs] of this.resolvedPaths) {
        console.log(`[workflow] path "${name}" → ${abs}`);
      }
    }

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
    this.persistRunIdHint(runId);

    // Build step rows
    const stepStates = new Map<string, StepState>();
    for (const step of resolvedWorkflow.steps) {
      // Handle agent, deterministic, worktree, and integration steps
      const isNonAgent = step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration';

      const stepRow: WorkflowStepRow = {
        id: this.generateId(),
        runId,
        stepName: step.name,
        agentName: isNonAgent ? null : (step.agent ?? null),
        stepType: isNonAgent ? (step.type as 'deterministic' | 'worktree' | 'integration') : 'agent',
        status: 'pending',
        task:
          step.type === 'deterministic'
            ? (step.command ?? '')
            : step.type === 'worktree'
              ? (step.branch ?? '')
              : step.type === 'integration'
                ? (`${step.integration}.${step.action}`)
                : (step.task ?? ''),
        dependsOn: step.dependsOn ?? [],
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insertStep(stepRow);
      stepStates.set(step.name, { row: stepRow });
    }

    // Handle startFrom: skip all transitive dependencies of the target step
    if (executeOptions?.startFrom) {
      const startFromName = executeOptions.startFrom;
      const stepNames = new Set(resolvedWorkflow.steps.map((s) => s.name));
      if (!stepNames.has(startFromName)) {
        throw new Error(
          `startFrom step "${startFromName}" not found in workflow. Available steps: ${[...stepNames].join(', ')}`
        );
      }

      const transitiveDeps = this.collectTransitiveDeps(startFromName, resolvedWorkflow.steps);
      const skippedCount = transitiveDeps.size;

      // Determine which run ID to load cached outputs from
      const cacheRunId = executeOptions.previousRunId
        ?? this.findMostRecentRunWithSteps(transitiveDeps);

      for (const depName of transitiveDeps) {
        const state = stepStates.get(depName);
        if (!state) continue;

        // Load cached output from a previous run if available
        const cachedOutput = cacheRunId ? this.loadStepOutput(cacheRunId, depName) : undefined;
        if (!cachedOutput) {
          this.log(`[startFrom] No cached output for skipped step "${depName}" — using empty string`);
        }

        state.row.status = 'completed';
        state.row.output = cachedOutput ?? '';
        state.row.completedAt = now;
        await this.db.updateStep(state.row.id, {
          status: 'completed',
          output: state.row.output,
          completedAt: now,
          updatedAt: now,
        });
      }

      if (skippedCount > 0) {
        this.log(`[startFrom] Skipping ${skippedCount} steps, starting from "${startFromName}"`);
      }
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
  async resume(runId: string, vars?: VariableContext, config?: RelayYamlConfig): Promise<WorkflowRunRow> {
    // Set up abort controller early so callers can abort() even during setup
    this.abortController = new AbortController();
    this.paused = false;

    let run = await this.db.getRun(runId);
    let stepStates = new Map<string, StepState>();
    if (!run) {
      const reconstructed = this.reconstructRunFromCache(runId, config);
      if (!reconstructed) {
        throw new Error(`Run "${runId}" not found (no database entry or cached step outputs)`);
      }
      this.log('[resume] Reconstructing run from cached step outputs (workflow-runs.jsonl missing)');
      run = reconstructed.run;
      stepStates = reconstructed.stepStates;
      await this.db.insertRun(run);
      for (const [, state] of stepStates) {
        await this.db.insertStep(state.row);
      }
    }
    this.persistRunIdHint(runId);

    if (run.status !== 'running' && run.status !== 'failed') {
      throw new Error(`Run "${runId}" is in status "${run.status}" and cannot be resumed`);
    }

    const resolvedConfig = vars ? this.resolveVariables(run.config, vars) : run.config;

    // Resolve path definitions (same as execute()) so workdir lookups work on resume
    const pathResult = this.resolvePathDefinitions(resolvedConfig.paths, this.cwd);
    if (pathResult.errors.length > 0) {
      throw new Error(`Path validation failed:\n  ${pathResult.errors.join('\n  ')}`);
    }
    this.resolvedPaths = pathResult.resolved;

    const workflows = resolvedConfig.workflows ?? [];
    const workflow = workflows.find((w) => w.name === run.workflowName);
    if (!workflow) {
      throw new Error(`Workflow "${run.workflowName}" not found in stored config`);
    }

    if (stepStates.size === 0) {
      const existingSteps = await this.db.getStepsByRunId(runId);
      for (const stepRow of existingSteps) {
        stepStates.set(stepRow.stepName, { row: stepRow });
      }
    }

    // Reset failed steps to pending for retry
    for (const [, state] of stepStates) {
      if (state.row.status === 'failed') {
        state.row.status = 'pending';
        state.row.error = undefined;
        state.row.completionReason = undefined;
        await this.db.updateStep(state.row.id, {
          status: 'pending',
          error: undefined,
          completionReason: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return this.runWorkflowCore({
      run,
      workflow,
      config: resolvedConfig,
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

    // Start execution (abortController already set by execute()/resume())
    this.currentConfig = config;
    this.currentRunId = runId;
    this.runStartTime = Date.now();
    this.runtimeStepAgents.clear();
    this.stepCompletionEvidence.clear();
    this.agentReports.clear();

    this.log(`Starting workflow "${workflow.name}" (${workflow.steps.length} steps)`);

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
          `Resumed run: ${pendingCount} pending steps of ${workflow.steps.length} total`,
          config.description,
          config.swarm.pattern
        );
      } else {
        // Analyze DAG for trajectory context on first run
        const dagInfo = this.analyzeDAG(workflow.steps);
        await this.trajectory.start(
          workflow.name,
          workflow.steps.length,
          dagInfo,
          config.description,
          config.swarm.pattern
        );
      }

      const channel =
        config.swarm.channel ??
        `wf-${this.sanitizeChannelName(config.name || run.workflowName)}-${this.generateShortId()}`;
      this.channel = channel;
      if (!config.swarm.channel) {
        config.swarm.channel = channel;
        await this.db.updateRun(runId, { config });
      }
      const relaycastDisabled =
        this.relayOptions.env?.AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST === '1';
      const requiresBroker =
        !this.executor &&
        workflow.steps.some((step) => step.type !== 'deterministic' && step.type !== 'worktree' && step.type !== 'integration');
      // Skip broker/relay init when an external executor handles agent spawning
      if (requiresBroker) {
        if (!relaycastDisabled) {
          this.log('Resolving Relaycast API key...');
          await this.ensureRelaycastApiKey(channel);
          this.log('API key resolved');
          if (this.relayApiKeyAutoCreated && this.relayApiKey) {
            this.log(`Workspace created — follow this run in Relaycast:`);
            this.log(`  Observer: https://agentrelay.dev/observer?key=${this.relayApiKey}`);
            this.log(`  Channel: ${channel}`);
          }
        }

        this.log('Starting broker...');
        // Include a short run ID suffix in the broker name so each workflow execution
        // registers a unique identity in Relaycast. Without this, re-running in the same
        // workspace hits a 409 conflict because the previous run's agent is still registered.
        const brokerBaseName = path.basename(this.cwd) || 'workflow';
        const brokerName = `${brokerBaseName}-${runId.slice(0, 8)}`;
        this.relay = new AgentRelay({
          ...this.relayOptions,
          brokerName,
          channels: relaycastDisabled ? [] : [channel],
          env: this.getRelayEnv(),
          // Workflows spawn agents across multiple waves; each spawn requires a PTY +
          // Relaycast registration. 60s is too tight when the broker is saturated with
          // long-running PTY processes from earlier steps. 120s gives room to breathe.
          requestTimeoutMs: this.relayOptions.requestTimeoutMs ?? 120_000,
        });

        // Wire PTY output dispatcher — routes chunks to per-agent listeners + activity logging
        this.relay.onWorkerOutput = ({ name, chunk }) => {
          const listener = this.ptyListeners.get(name);
          if (listener) listener(chunk);

          // Parse PTY output for high-signal activity
          const stripped = WorkflowRunner.stripAnsi(chunk);
          const shortName = name.replace(/-[a-f0-9]{6,}$/, '');
          let activity: string | undefined;
          if (/Read\(/.test(stripped)) {
            // Extract filename — path may be truncated at chunk boundary so require
            // at least a dir separator or 8+ chars to trust the basename.
            const m = stripped.match(/Read\(\s*~?([^\s)"']{8,})/);
            if (m) {
              const base = path.basename(m[1]);
              activity = base.length >= 3 ? `Reading ${base}` : 'Reading file...';
            } else {
              activity = 'Reading file...';
            }
          } else if (/Edit\(/.test(stripped)) {
            const m = stripped.match(/Edit\(\s*~?([^\s)"']{8,})/);
            if (m) {
              const base = path.basename(m[1]);
              activity = base.length >= 3 ? `Editing ${base}` : 'Editing file...';
            } else {
              activity = 'Editing file...';
            }
          } else if (/Bash\(/.test(stripped)) {
            // Extract a short preview of the command
            const m = stripped.match(/Bash\(\s*(.{1,40})/);
            activity = m ? `Running: ${m[1].trim()}...` : 'Running command...';
          } else if (/Explore\(/.test(stripped)) {
            const m = stripped.match(/Explore\(\s*(.{1,50})/);
            activity = m ? `Exploring: ${m[1].replace(/\).*/, '').trim()}` : 'Exploring codebase...';
          } else if (/Task\(/.test(stripped)) {
            activity = 'Running sub-agent...';
          } else if (/Sublimating|Thinking|Coalescing|Cultivating/.test(stripped)) {
            const m = stripped.match(/(\d+)s/);
            activity = m ? `Thinking... (${m[1]}s)` : 'Thinking...';
          }
          if (activity && this.lastActivity.get(name) !== activity) {
            this.lastActivity.set(name, activity);
            this.log(`[${shortName}] ${activity}`);
          }
        };

        // Wire relay event hooks for rich console logging
        this.relay.onMessageReceived = (msg) => {
          this.emit({
            type: 'broker:event',
            runId,
            event: {
              kind: 'relay_inbound',
              event_id: msg.eventId,
              from: msg.from,
              target: msg.to,
              body: msg.text,
              thread_id: msg.threadId,
            } as BrokerEvent,
          });
          const body = msg.text.length > 120 ? msg.text.slice(0, 117) + '...' : msg.text;
          const fromShort = msg.from.replace(/-[a-f0-9]{6,}$/, '');
          const toShort = msg.to.replace(/-[a-f0-9]{6,}$/, '');
          this.log(`[msg] ${fromShort} → ${toShort}: ${body}`);

          if (this.channel && (msg.to === this.channel || msg.to === `#${this.channel}`)) {
            const runtimeAgent = this.runtimeStepAgents.get(msg.from);
            this.recordChannelEvidence(msg.text, {
              sender: runtimeAgent?.logicalName ?? msg.from,
              actor: msg.from,
              role: runtimeAgent?.role,
              target: msg.to,
              origin: 'relay_message',
              stepName: runtimeAgent?.stepName,
            });
          }

          const supervision = this.supervisedRuntimeAgents.get(msg.from);
          if (supervision?.role === 'owner') {
            this.recordStepToolSideEffect(supervision.stepName, {
              type: 'owner_monitoring',
              detail: `Owner messaged ${msg.to}: ${msg.text.slice(0, 120)}`,
              raw: { to: msg.to, text: msg.text },
            });
            void this.trajectory?.ownerMonitoringEvent(
              supervision.stepName,
              supervision.logicalName,
              `Messaged ${msg.to}: ${msg.text.slice(0, 120)}`,
              { to: msg.to, text: msg.text }
            );
          }
        };

        this.relay.onAgentSpawned = (agent) => {
          this.emit({
            type: 'broker:event',
            runId,
            event: {
              kind: 'agent_spawned',
              name: agent.name,
              runtime: agent.runtime,
            } as BrokerEvent,
          });
          // Skip agents already managed by step execution
          if (!this.activeAgentHandles.has(agent.name)) {
            this.log(`[spawned] ${agent.name} (${agent.runtime})`);
          }
        };

        this.relay.onAgentReleased = (agent) => {
          this.emit({
            type: 'broker:event',
            runId,
            event: {
              kind: 'agent_released',
              name: agent.name,
            } as BrokerEvent,
          });
        };

        this.relay.onAgentExited = (agent) => {
          this.emit({
            type: 'broker:event',
            runId,
            event: {
              kind: 'agent_exited',
              name: agent.name,
              code: agent.exitCode,
              signal: agent.exitSignal,
            } as BrokerEvent,
          });
          this.lastActivity.delete(agent.name);
          this.lastIdleLog.delete(agent.name);
          if (!this.activeAgentHandles.has(agent.name)) {
            this.log(`[exited] ${agent.name} (code: ${agent.exitCode ?? '?'})`);
          }
        };

        this.relay.onDeliveryUpdate = (event) => {
          this.emit({ type: 'broker:event', runId, event });
        };

        this.relay.onAgentIdle = ({ name, idleSecs }) => {
          this.emit({
            type: 'broker:event',
            runId,
            event: {
              kind: 'agent_idle',
              name,
              idle_secs: idleSecs,
            } as BrokerEvent,
          });
          // Only log at 30s multiples to avoid watchdog spam
          const bucket = Math.floor(idleSecs / 30) * 30;
          if (bucket >= 30 && this.lastIdleLog.get(name) !== bucket) {
            this.lastIdleLog.set(name, bucket);
            const shortName = name.replace(/-[a-f0-9]{6,}$/, '');
            this.log(`[idle] ${shortName} silent for ${bucket}s`);
          }
        };

        this.relaycast = undefined;
        this.relaycastAgent = undefined;

        // Wire broker stderr to console for observability — skip empty and
        // JSON event lines (already surfaced via the broker:event emitter).
        this.unsubBrokerStderr = this.relay.onBrokerStderr((line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          // JSON event lines from the Rust EventEmitter are already parsed
          // and emitted as broker:event — no need to double-log them.
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) return;
          console.log(`${chalk.dim.yellow('[broker]')} ${line}`);
        });

        if (!relaycastDisabled) {
          this.log(`Creating channel: ${channel}...`);
          if (isResume) {
            await this.createAndJoinRelaycastChannel(channel);
          } else {
            await this.createAndJoinRelaycastChannel(channel, workflow.description);
          }
          this.log('Channel ready');

          if (isResume) {
            this.postToChannel(`Workflow **${workflow.name}** resumed — ${pendingCount} pending steps`);
          } else {
            this.postToChannel(
              `Workflow **${workflow.name}** started — ${workflow.steps.length} steps, pattern: ${config.swarm.pattern}`
            );
          }
        }
      }

      const agentMap = new Map<string, AgentDefinition>();
      for (const agent of config.agents) {
        agentMap.set(agent.name, agent);
      }

      // Run preflight checks before any steps (skip on resume)
      if (!isResume && workflow.preflight?.length) {
        await this.runPreflightChecks(workflow.preflight, runId);
      }

      this.log(`Executing ${workflow.steps.length} steps (pattern: ${config.swarm.pattern})`);
      await this.executeSteps(workflow, stepStates, agentMap, config.errorHandling, runId);

      const errorStrategy =
        config.errorHandling?.strategy ?? workflow.onError ?? 'fail-fast';
      const continueOnError =
        errorStrategy === 'continue' || errorStrategy === 'skip';
      const allCompleted = [...stepStates.values()].every(
        (s) =>
          s.row.status === 'completed' ||
          s.row.status === 'skipped' ||
          (continueOnError && s.row.status === 'failed')
      );

      if (allCompleted) {
        this.log('Workflow completed successfully');
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
        this.logRunSummary(workflow.name, outcomes, runId);
      } else {
        const failedStep = [...stepStates.values()].find((s) => s.row.status === 'failed');
        const errorMsg = failedStep?.row.error ?? 'One or more steps failed';
        await this.updateRunStatus(runId, 'failed', errorMsg);
        this.emit({ type: 'run:failed', runId, error: errorMsg });

        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        const summary = this.trajectory.buildRunSummary(outcomes);
        const confidence = this.trajectory.computeConfidence(outcomes);
        const learnings = this.trajectory.extractLearnings(outcomes);
        const challenges = this.trajectory.extractChallenges(outcomes);
        this.postFailureReport(workflow.name, outcomes, errorMsg);
        this.logRunSummary(workflow.name, outcomes, runId);
        await this.trajectory.abandon(errorMsg, {
          summary,
          confidence,
          learnings,
          challenges,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status: WorkflowRunStatus =
        !isResume && this.abortController?.signal.aborted ? 'cancelled' : 'failed';
      await this.updateRunStatus(runId, status, errorMsg);

      if (status === 'cancelled') {
        // Mark any pending or in-progress steps as failed due to cancellation
        for (const [stepName, state] of stepStates) {
          if (state.row.status === 'pending' || state.row.status === 'running') {
            state.row.status = 'failed';
            state.row.error = 'Cancelled';
            await this.db.updateStep(state.row.id, {
              status: 'failed',
              error: 'Cancelled',
              updatedAt: new Date().toISOString(),
            });
            this.emit({ type: 'step:failed', runId, stepName, error: 'Cancelled' });
            this.finalizeStepEvidence(stepName, 'failed');
          }
        }
        this.emit({ type: 'run:cancelled', runId });
        this.postToChannel(`Workflow **${workflow.name}** cancelled`);
        await this.trajectory.abandon('Cancelled by user');
      } else {
        this.emit({ type: 'run:failed', runId, error: errorMsg });
        this.postToChannel(`Workflow failed: ${errorMsg}`);
        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        await this.trajectory.abandon(errorMsg, {
          summary: this.trajectory.buildRunSummary(outcomes),
          confidence: this.trajectory.computeConfidence(outcomes),
          learnings: this.trajectory.extractLearnings(outcomes),
          challenges: this.trajectory.extractChallenges(outcomes),
        });
      }
    } finally {
      this.lastFailedStepOutput.clear();
      for (const stream of this.ptyLogStreams.values()) stream.end();
      this.ptyLogStreams.clear();
      this.ptyOutputBuffers.clear();
      this.ptyListeners.clear();

      this.unsubBrokerStderr?.();
      this.unsubBrokerStderr = undefined;

      // Null out relay event hooks to prevent leaks
      if (this.relay) {
        this.relay.onMessageReceived = null;
        this.relay.onAgentSpawned = null;
        this.relay.onAgentReleased = null;
        this.relay.onAgentExited = null;
        this.relay.onAgentIdle = null;
        this.relay.onWorkerOutput = null;
        this.relay.onDeliveryUpdate = null;
      }
      this.lastIdleLog.clear();
      this.lastActivity.clear();
      this.supervisedRuntimeAgents.clear();
      this.runtimeStepAgents.clear();
      this.activeReviewers.clear();

      this.log('Shutting down broker...');
      await this.relay?.shutdown();
      this.relay = undefined;
      this.runStartTime = undefined;
      this.relaycast = undefined;
      this.relaycastAgent = undefined;
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
    const strategy =
      rawStrategy === 'fail'
        ? 'fail-fast'
        : rawStrategy === 'skip'
          ? 'continue'
          : rawStrategy === 'retry'
            ? 'fail-fast'
            : rawStrategy;

    const lifecycle = this.createStepLifecycleExecutor(
      workflow,
      stepStates,
      agentMap,
      errorHandling,
      runId
    );

    await lifecycle.executeAll(
      workflow.steps,
      agentMap,
      {
        ...(errorHandling ?? { strategy: 'fail-fast' }),
        strategy,
      },
      stepStates
    );
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
  private async runPreflightChecks(checks: PreflightCheck[], runId: string): Promise<void> {
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
              reject(
                new Error(`Preflight check failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
              );
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

  /** Check if a step is an integration (external service) step. */
  private isIntegrationStep(step: WorkflowStep): boolean {
    return step.type === 'integration';
  }

  private async executeStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    // Branch: deterministic steps execute shell commands
    if (this.isDeterministicStep(step)) {
      return this.executeDeterministicStep(step, state, stepStates, runId, errorHandling, lifecycle);
    }

    // Branch: worktree steps set up git worktrees
    if (this.isWorktreeStep(step)) {
      return this.executeWorktreeStep(step, state, stepStates, runId, lifecycle);
    }

    // Branch: integration steps interact with external services
    if (this.isIntegrationStep(step)) {
      return this.executeIntegrationStep(step, state, stepStates, runId, lifecycle);
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
    state: StepState,
    stepStates: Map<string, StepState>,
    runId: string,
    errorHandling: ErrorHandlingConfig | undefined,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    const maxRetries = step.retries ?? errorHandling?.maxRetries ?? 0;
    const retryDelay = errorHandling?.retryDelayMs ?? 1000;
    let lastError = 'Unknown error';
    let lastCompletionReason: WorkflowStepCompletionReason | undefined;
    let lastExitCode: number | undefined;
    let lastExitSignal: string | undefined;

    const result = await lifecycle.monitorStep(step, state, {
      maxRetries,
      retryDelayMs: retryDelay,
      startMessage: `**[${step.name}]** Started (deterministic)`,
      onRetry: async (attempt, total) => {
        this.emit({ type: 'step:retrying', runId, stepName: step.name, attempt });
        this.postToChannel(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${total + 1})`);
        this.recordStepToolSideEffect(step.name, {
          type: 'retry',
          detail: `Retrying attempt ${attempt + 1}/${total + 1}`,
          raw: { attempt, maxRetries: total },
        });
      },
      execute: async () => {
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        let resolvedCommand = this.interpolateStepTask(step.command ?? '', stepOutputContext);

        resolvedCommand = resolvedCommand.replace(/\{\{([\w][\w.\-]*)\}\}/g, (_match, key: string) => {
          if (key.startsWith('steps.')) return _match;
          const value = this.resolveDotPath(key, stepOutputContext);
          return value !== undefined ? String(value) : _match;
        });

        const stepCwd = this.resolveEffectiveCwd(step);
        this.beginStepEvidence(step.name, [stepCwd], state.row.startedAt);

        if (this.executor?.executeDeterministicStep) {
          const executorResult = await this.executor.executeDeterministicStep(step, resolvedCommand, stepCwd);
          lastExitCode = executorResult.exitCode;
          lastExitSignal = undefined;
          const failOnError = step.failOnError !== false;
          if (failOnError && executorResult.exitCode !== 0) {
            throw new Error(
              `Command failed with exit code ${executorResult.exitCode}: ${executorResult.output.slice(0, 500)}`
            );
          }
          const output =
            step.captureOutput !== false
              ? executorResult.output
              : `Command completed (exit code ${executorResult.exitCode})`;
          this.captureStepTerminalEvidence(
            step.name,
            { stdout: executorResult.output, combined: executorResult.output },
            { exitCode: executorResult.exitCode }
          );
          const verificationResult = step.verification
            ? this.runVerification(step.verification, output, step.name)
            : undefined;
          return {
            output,
            completionReason: verificationResult?.completionReason,
          };
        }

        let commandStdout = '';
        let commandStderr = '';
        const output = await new Promise<string>((resolve, reject) => {
          const child = cpSpawn('sh', ['-c', resolvedCommand], {
            stdio: 'pipe',
            cwd: stepCwd,
            env: { ...process.env },
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          const abortSignal = this.abortController?.signal;
          let abortHandler: (() => void) | undefined;
          if (abortSignal && !abortSignal.aborted) {
            abortHandler = () => {
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

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

          child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }

            if (abortSignal?.aborted) {
              reject(new Error(`Step "${step.name}" aborted`));
              return;
            }

            if (timedOut) {
              reject(
                new Error(`Step "${step.name}" timed out (no step timeout set, check global swarm.timeoutMs)`)
              );
              return;
            }

            const stdout = stdoutChunks.join('');
            const stderr = stderrChunks.join('');
            commandStdout = stdout;
            commandStderr = stderr;
            lastExitCode = code ?? undefined;
            lastExitSignal = signal ?? undefined;

            const failOnError = step.failOnError !== false;
            if (failOnError && code !== 0 && code !== null) {
              reject(
                new Error(
                  `Command failed with exit code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
                )
              );
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

        this.captureStepTerminalEvidence(
          step.name,
          {
            stdout: commandStdout || output,
            stderr: commandStderr,
            combined: [commandStdout || output, commandStderr].filter(Boolean).join('\n'),
          },
          { exitCode: lastExitCode, exitSignal: lastExitSignal }
        );

        const verificationResult = step.verification
          ? this.runVerification(step.verification, output, step.name)
          : undefined;

        return {
          output,
          completionReason: verificationResult?.completionReason,
        };
      },
      toCompletionResult: ({ output, completionReason }, attempt) => ({
        status: 'completed',
        output,
        completionReason,
        retries: attempt,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      }),
      onAttemptFailed: async (error) => {
        lastError = error instanceof Error ? error.message : String(error);
        lastCompletionReason =
          error instanceof WorkflowCompletionError ? error.completionReason : undefined;
      },
      getFailureResult: () => ({
        status: 'failed',
        output: '',
        error: lastError,
        retries: state.row.retryCount,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
        completionReason: lastCompletionReason,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }
  }

  /**
   * Execute a worktree step (git worktree setup).
   * Fast, reliable, $0 LLM cost.
   * Outputs the worktree path for downstream steps to use.
   */
  private async executeWorktreeStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    let lastExitCode: number | undefined;
    let lastExitSignal: string | undefined;
    let worktreeBranch = '';
    let createdBranch = false;

    const result = await lifecycle.monitorStep(step, state, {
      startMessage: `**[${step.name}]** Started (worktree setup)`,
      execute: async () => {
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        const branch = this.interpolateStepTask(step.branch ?? '', stepOutputContext);
        const baseBranch = step.baseBranch
          ? this.interpolateStepTask(step.baseBranch, stepOutputContext)
          : 'HEAD';
        const worktreePath = step.path
          ? this.interpolateStepTask(step.path, stepOutputContext)
          : path.join('.worktrees', step.name);
        const createBranch = step.createBranch !== false;
        const stepCwd = this.resolveStepWorkdir(step) ?? this.cwd;

        this.beginStepEvidence(step.name, [stepCwd], state.row.startedAt);

        if (!branch) {
          throw new Error('Worktree step missing required "branch" field');
        }

        const absoluteWorktreePath = path.resolve(stepCwd, worktreePath);
        const checkBranchCmd = `git rev-parse --verify --quiet ${branch} 2>/dev/null`;
        let branchExists = false;

        await new Promise<void>((resolve) => {
          const checkChild = cpSpawn('sh', ['-c', checkBranchCmd], {
            stdio: 'pipe',
            cwd: stepCwd,
            env: { ...process.env },
          });
          checkChild.on('close', (code) => {
            branchExists = code === 0;
            resolve();
          });
          checkChild.on('error', () => resolve());
        });

        let worktreeCmd: string;
        if (branchExists) {
          worktreeCmd = `git worktree add "${absoluteWorktreePath}" ${branch}`;
        } else if (createBranch) {
          worktreeCmd = `git worktree add -b ${branch} "${absoluteWorktreePath}" ${baseBranch}`;
        } else {
          throw new Error(`Branch "${branch}" does not exist and createBranch is false`);
        }

        let commandStdout = '';
        let commandStderr = '';
        const output = await new Promise<string>((resolve, reject) => {
          const child = cpSpawn('sh', ['-c', worktreeCmd], {
            stdio: 'pipe',
            cwd: stepCwd,
            env: { ...process.env },
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          const abortSignal = this.abortController?.signal;
          let abortHandler: (() => void) | undefined;
          if (abortSignal && !abortSignal.aborted) {
            abortHandler = () => {
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

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

          child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }

            if (abortSignal?.aborted) {
              reject(new Error(`Step "${step.name}" aborted`));
              return;
            }

            if (timedOut) {
              reject(
                new Error(`Step "${step.name}" timed out (no step timeout set, check global swarm.timeoutMs)`)
              );
              return;
            }

            commandStdout = stdoutChunks.join('');
            commandStderr = stderrChunks.join('');
            lastExitCode = code ?? undefined;
            lastExitSignal = signal ?? undefined;

            if (code !== 0 && code !== null) {
              reject(
                new Error(
                  `git worktree add failed with exit code ${code}${commandStderr ? `: ${commandStderr.slice(0, 500)}` : ''}`
                )
              );
              return;
            }

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

        this.captureStepTerminalEvidence(
          step.name,
          {
            stdout: commandStdout || output,
            stderr: commandStderr,
            combined: [commandStdout || output, commandStderr].filter(Boolean).join('\n'),
          },
          { exitCode: lastExitCode, exitSignal: lastExitSignal }
        );

        worktreeBranch = branch;
        createdBranch = !branchExists && createBranch;
        return { output };
      },
      toCompletionResult: ({ output }, attempt) => ({
        status: 'completed',
        output,
        retries: attempt,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      }),
      getFailureResult: (error) => ({
        status: 'failed',
        output: '',
        error: error instanceof Error ? error.message : String(error),
        retries: state.row.retryCount,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }

    this.postToChannel(
      `**[${step.name}]** Worktree created at: ${result.output}\n  Branch: ${worktreeBranch}${createdBranch ? ' (created)' : ''}`
    );
    this.recordStepToolSideEffect(step.name, {
      type: 'worktree_created',
      detail: `Worktree created at ${result.output}`,
      raw: { branch: worktreeBranch, createdBranch },
    });
  }

  /**
   * Execute an integration step (external service interaction via executor).
   */
  private async executeIntegrationStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    const result = await lifecycle.monitorStep(step, state, {
      startMessage: `**[${step.name}]** Started (integration: ${step.integration}.${step.action})`,
      execute: async () => {
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        const resolvedParams: Record<string, string> = {};
        for (const [key, value] of Object.entries(step.params ?? {})) {
          resolvedParams[key] = this.interpolateStepTask(value, stepOutputContext);
        }

        if (!this.executor?.executeIntegrationStep) {
          throw new Error(
            `Integration steps require a cloud executor. Step "${step.name}" cannot run locally. ` +
            `Use "cloud run" to execute workflows with integration steps.`
          );
        }

        const integrationResult = await this.executor.executeIntegrationStep(step, resolvedParams, {
          workspaceId: this.workspaceId,
        });

        if (!integrationResult.success) {
          throw new Error(`Integration step "${step.name}" failed: ${integrationResult.output}`);
        }

        return { output: integrationResult.output };
      },
      toCompletionResult: ({ output }, attempt) => ({
        status: 'completed',
        output,
        retries: attempt,
      }),
      getFailureResult: (error) => ({
        status: 'failed',
        output: '',
        error: error instanceof Error ? error.message : String(error),
        retries: state.row.retryCount,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }

    this.postToChannel(`**[${step.name}]** Completed (integration: ${step.integration}.${step.action})`);
  }

  /**
   * Execute an agent step (LLM-powered).
   */
  private async executeAgentStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string
  ): Promise<void> {
    const state = stepStates.get(step.name);
    if (!state) throw new Error(`Step state not found: ${step.name}`);

    const agentName = step.agent;
    if (!agentName) {
      throw new Error(`Step "${step.name}" is missing required "agent" field`);
    }
    const rawAgentDef = agentMap.get(agentName);
    if (!rawAgentDef) {
      throw new Error(`Agent "${agentName}" not found in config`);
    }
    const specialistDef = WorkflowRunner.resolveAgentDef(rawAgentDef);

    // API-mode agents: execute via direct API call instead of spawning a PTY/subprocess.
    if (specialistDef.cli === 'api') {
      const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
      const resolvedTask = this.interpolateStepTask(step.task ?? '', stepOutputContext);

      state.row.status = 'running';
      state.row.startedAt = new Date().toISOString();
      await this.db.updateStep(state.row.id, {
        status: 'running',
        startedAt: state.row.startedAt,
        updatedAt: new Date().toISOString(),
      });
      this.emit({ type: 'step:started', runId, stepName: step.name });
      this.postToChannel(`**[${step.name}]** Started (api)`);

      try {
        const output = await executeApiStep(
          specialistDef.constraints?.model ?? 'claude-sonnet-4-20250514',
          resolvedTask,
          { envSecrets: this.envSecrets, skills: specialistDef.skills, defaultMaxTokens: specialistDef.constraints?.maxTokens },
        );

        state.row.status = 'completed';
        state.row.output = output;
        state.row.completedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'completed',
          output,
          completedAt: state.row.completedAt,
          updatedAt: new Date().toISOString(),
        });
        await this.persistStepOutput(runId, step.name, output);
        this.emit({ type: 'step:completed', runId, stepName: step.name, output });
      } catch (apiError) {
        const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
        state.row.status = 'failed';
        state.row.error = errorMessage;
        state.row.completedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'failed',
          error: errorMessage,
          completedAt: state.row.completedAt,
          updatedAt: new Date().toISOString(),
        });
        this.emit({ type: 'step:failed', runId, stepName: step.name, error: errorMessage });
        this.postToChannel(`**[${step.name}]** Failed (api): ${errorMessage}`);
        throw apiError;
      }
      return;
    }

    const usesOwnerFlow = specialistDef.interactive !== false;
    const currentPattern = this.currentConfig?.swarm?.pattern ?? '';
    const isHubPattern = WorkflowRunner.HUB_PATTERNS.has(currentPattern);
    const usesAutoHardening = usesOwnerFlow && isHubPattern && !this.isExplicitInteractiveWorker(specialistDef);
    const ownerDef = usesAutoHardening ? this.resolveAutoStepOwner(specialistDef, agentMap) : specialistDef;
    // Reviewer resolution is deferred to just before the review gate runs (see below)
    // so that activeReviewers is up-to-date for concurrent steps.
    let reviewDef: ReturnType<typeof this.resolveAutoReviewAgent> | undefined;
    const supervised: SupervisedStep = {
      specialist: specialistDef,
      owner: ownerDef,
      reviewer: reviewDef,
    };
    const usesDedicatedOwner = usesOwnerFlow && ownerDef.name !== specialistDef.name;

    const maxRetries =
      step.retries ??
      ownerDef.constraints?.retries ??
      specialistDef.constraints?.retries ??
      errorHandling?.maxRetries ??
      0;
    const retryDelay = errorHandling?.retryDelayMs ?? 1000;
    const timeoutMs =
      step.timeoutMs ??
      ownerDef.constraints?.timeoutMs ??
      specialistDef.constraints?.timeoutMs ??
      this.currentConfig?.swarm?.timeoutMs;

    let lastError: string | undefined;
    let lastExitCode: number | undefined;
    let lastExitSignal: string | undefined;
    let lastCompletionReason: WorkflowStepCompletionReason | undefined;
    let lastAttemptStartedAt: number | undefined;
    let lastEffectiveAgentDef: AgentDefinition | undefined;
    let lastEffectiveCwd: string | undefined;

    // OWNER_DECISION: INCOMPLETE_RETRY is enforced here at the attempt-loop level so every
    // interactive execution path shares the same contract:
    // - retries remaining => throw back into the loop and retry
    // - maxRetries = 0 => fail immediately after the first retry request
    // - retry budget exhausted => fail with retry_requested_by_owner, never "completed"
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.checkAborted();

      // Reset per-attempt exit info so stale values don't leak across retries
      lastExitCode = undefined;
      lastExitSignal = undefined;

      if (attempt > 0) {
        this.emit({ type: 'step:retrying', runId, stepName: step.name, attempt });
        this.postToChannel(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${maxRetries + 1})`);
        this.recordStepToolSideEffect(step.name, {
          type: 'retry',
          detail: `Retrying attempt ${attempt + 1}/${maxRetries + 1}`,
          raw: { attempt, maxRetries },
        });
        state.row.retryCount = attempt;
        await this.db.updateStep(state.row.id, {
          retryCount: attempt,
          updatedAt: new Date().toISOString(),
        });
        await this.trajectory?.stepRetrying(step, attempt, maxRetries);
        await this.delay(retryDelay);
      }

      try {
        lastAttemptStartedAt = Date.now();
        // Mark step as running
        state.row.status = 'running';
        state.row.error = undefined;
        state.row.completionReason = undefined;
        state.row.startedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'running',
          error: undefined,
          completionReason: undefined,
          startedAt: state.row.startedAt,
          updatedAt: new Date().toISOString(),
        });
        this.emit({ type: 'step:started', runId, stepName: step.name });
        this.log(
          `[${step.name}] Started (owner: ${ownerDef.name}, specialist: ${specialistDef.name})`
        );
        this.initializeStepSignalParticipants(step.name, ownerDef.name, specialistDef.name);
        await this.trajectory?.stepStarted(step, ownerDef.name, {
          role: usesDedicatedOwner ? 'owner' : 'specialist',
          owner: ownerDef.name,
          specialist: specialistDef.name,
          reviewer: reviewDef?.name,
        });
        if (usesDedicatedOwner) {
          await this.trajectory?.stepSupervisionAssigned(step, supervised);
        }
        this.emit({
          type: 'step:owner-assigned',
          runId,
          stepName: step.name,
          ownerName: ownerDef.name,
          specialistName: specialistDef.name,
        });

        // Resolve step-output variables (e.g. {{steps.plan.output}}) at execution time
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        let resolvedTask = this.interpolateStepTask(step.task ?? '', stepOutputContext);

        // On retry attempts, prepend failure context so the agent knows what went wrong
        if (attempt > 0 && lastError) {
          const priorOutput = (this.lastFailedStepOutput.get(step.name) ?? '').slice(-2000);
          resolvedTask =
            `[RETRY — Attempt ${attempt + 1}/${maxRetries + 1}]\n` +
            `Previous attempt failed: ${lastError}\n` +
            (priorOutput ? `Previous output (last 2000 chars):\n${priorOutput}\n` : '') +
            `---\n${resolvedTask}`;
        }

        // If this is an interactive agent, append awareness of non-interactive workers
        // so the lead knows not to message them and to use step output chaining instead
        if (specialistDef.interactive !== false || ownerDef.interactive !== false) {
          const nonInteractiveInfo = this.buildNonInteractiveAwareness(agentMap, stepStates);
          if (nonInteractiveInfo) {
            resolvedTask += nonInteractiveInfo;
          }
        }

        // Apply step-level workdir override to agent definitions if present
        const applyStepCwd = (def: AgentDefinition): AgentDefinition => {
          if (step.cwd) {
            return { ...def, cwd: step.cwd, workdir: undefined };
          }
          if (step.workdir) {
            const stepWorkdir = this.resolveStepWorkdir(step);
            if (stepWorkdir) {
              return { ...def, cwd: stepWorkdir, workdir: undefined };
            }
          }
          return def;
        };
        const effectiveSpecialist = applyStepCwd(specialistDef);
        const effectiveOwner = applyStepCwd(ownerDef);
        const effectiveReviewer = reviewDef ? applyStepCwd(reviewDef) : undefined;
        lastEffectiveAgentDef = effectiveSpecialist;
        lastEffectiveCwd = this.resolveAgentCwd(effectiveSpecialist);
        this.beginStepEvidence(
          step.name,
          [
            this.resolveAgentCwd(effectiveSpecialist),
            this.resolveAgentCwd(effectiveOwner),
            effectiveReviewer ? this.resolveAgentCwd(effectiveReviewer) : undefined,
          ],
          state.row.startedAt
        );

        let specialistOutput: string;
        let ownerOutput: string;
        let ownerElapsed: number;
        let completionReason: WorkflowStepCompletionReason | undefined;
        let promptTaskText: string | undefined;

        if (usesDedicatedOwner) {
          const result = await this.executeSupervisedAgentStep(
            step,
            { specialist: effectiveSpecialist, owner: effectiveOwner, reviewer: reviewDef },
            resolvedTask,
            timeoutMs
          );
          specialistOutput = result.specialistOutput;
          ownerOutput = result.ownerOutput;
          ownerElapsed = result.ownerElapsed;
          completionReason = result.completionReason;
        } else {
          const ownerTask = this.injectStepOwnerContract(step, resolvedTask, effectiveOwner, effectiveSpecialist);
          const explicitInteractiveWorker = this.isExplicitInteractiveWorker(effectiveOwner);
          let explicitWorkerHandle: Agent | undefined;
          let explicitWorkerCompleted = false;
          let explicitWorkerOutput = '';

          this.log(`[${step.name}] Spawning owner "${effectiveOwner.name}" (cli: ${effectiveOwner.cli})${step.workdir ? ` [workdir: ${step.workdir}]` : ''}`);
          const resolvedStep = { ...step, task: ownerTask };
          const ownerStartTime = Date.now();
          const spawnResult = this.executor
            ? await this.executor.executeAgentStep(resolvedStep, effectiveOwner, ownerTask, timeoutMs)
            : await this.spawnAndWait(effectiveOwner, resolvedStep, timeoutMs, {
                evidenceStepName: step.name,
                evidenceRole: usesOwnerFlow ? 'owner' : 'specialist',
                preserveOnIdle: (!isHubPattern || !this.isLeadLikeAgent(effectiveOwner)) ? false : undefined,
                logicalName: effectiveOwner.name,
                onSpawned: explicitInteractiveWorker
                  ? ({ agent }) => {
                      explicitWorkerHandle = agent;
                    }
                  : undefined,
                onChunk: explicitInteractiveWorker
                  ? ({ chunk }) => {
                      explicitWorkerOutput += WorkflowRunner.stripAnsi(chunk);
                      if (
                        !explicitWorkerCompleted &&
                        this.hasExplicitInteractiveWorkerCompletionEvidence(
                          step,
                          explicitWorkerOutput,
                          ownerTask,
                          resolvedTask
                        )
                      ) {
                        explicitWorkerCompleted = true;
                        void explicitWorkerHandle?.release().catch(() => undefined);
                      }
                    }
                  : undefined,
              });
          const output = typeof spawnResult === 'string' ? spawnResult : spawnResult.output;
          promptTaskText =
            typeof spawnResult === 'string'
              ? effectiveOwner.interactive === false
                ? undefined
                : ownerTask
              : spawnResult.promptTaskText ?? ownerTask;
          lastExitCode = typeof spawnResult === 'string' ? undefined : spawnResult.exitCode;
          lastExitSignal = typeof spawnResult === 'string' ? undefined : spawnResult.exitSignal;
          ownerElapsed = Date.now() - ownerStartTime;
          this.log(`[${step.name}] Owner "${effectiveOwner.name}" exited`);
          if (usesOwnerFlow) {
            try {
              const completionDecision = this.resolveOwnerCompletionDecision(
                step,
                output,
                output,
                promptTaskText ?? ownerTask,
                promptTaskText ?? ownerTask
              );
              completionReason = completionDecision.completionReason;
            } catch (error) {
              const canUseVerificationFallback =
                !usesDedicatedOwner &&
                step.verification &&
                error instanceof WorkflowCompletionError &&
                error.completionReason === 'failed_no_evidence';
              if (!canUseVerificationFallback) {
                throw error;
              }
            }
          }
          specialistOutput = output;
          ownerOutput = output;
        }

        // Even non-interactive steps can emit an explicit OWNER_DECISION contract.
        // Honor retry/fail/clarification signals before verification-driven success so
        // real runs stay consistent with interactive owner flows.
        if (!usesOwnerFlow) {
          const explicitOwnerDecision = this.parseOwnerDecision(step, ownerOutput, false);
          if (explicitOwnerDecision?.decision === 'INCOMPLETE_RETRY') {
            throw new WorkflowCompletionError(
              `Step "${step.name}" owner requested retry${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
              'retry_requested_by_owner'
            );
          }
          if (explicitOwnerDecision?.decision === 'INCOMPLETE_FAIL') {
            throw new WorkflowCompletionError(
              `Step "${step.name}" owner marked the step incomplete${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
              'failed_owner_decision'
            );
          }
          if (explicitOwnerDecision?.decision === 'NEEDS_CLARIFICATION') {
            throw new WorkflowCompletionError(
              `Step "${step.name}" owner requested clarification before completion${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
              'retry_requested_by_owner'
            );
          }
        }

        // Run verification if configured.
        // Self-owned interactive steps still need verification fallback so
        // explicit OWNER_DECISION output is not mandatory for the happy path.
        if (step.verification && (!usesOwnerFlow || !usesDedicatedOwner) && !completionReason) {
          const verificationResult = this.runVerification(
            step.verification,
            specialistOutput,
            step.name,
            promptTaskText
          );
          completionReason = verificationResult.completionReason;
        }

        // Retry-style owner decisions are control-flow signals, not terminal success states.
        // Guard here so they cannot accidentally fall through into review or completed-step
        // persistence if a future branch returns a completionReason instead of throwing.
        if (completionReason === 'retry_requested_by_owner') {
          throw new WorkflowCompletionError(
            `Step "${step.name}" owner requested another attempt`,
            'retry_requested_by_owner'
          );
        }

        // Every interactive step gets a review pass; pick a dedicated reviewer when available.
        // Resolve reviewer JIT so activeReviewers reflects concurrent steps that started earlier.
        if (usesAutoHardening && usesDedicatedOwner && !reviewDef) {
          reviewDef = this.resolveAutoReviewAgent(ownerDef, agentMap);
          supervised.reviewer = reviewDef;
        }
        let combinedOutput = specialistOutput;
        if (usesOwnerFlow && reviewDef) {
          this.activeReviewers.set(reviewDef.name, (this.activeReviewers.get(reviewDef.name) ?? 0) + 1);
          try {
            const remainingMs = timeoutMs ? Math.max(0, timeoutMs - ownerElapsed) : undefined;
            const reviewOutput = await this.runStepReviewGate(
              step,
              resolvedTask,
              specialistOutput,
              ownerOutput,
              ownerDef,
              reviewDef,
              remainingMs
            );
            combinedOutput = this.combineStepAndReviewOutput(specialistOutput, reviewOutput);
          } finally {
            const count = (this.activeReviewers.get(reviewDef.name) ?? 1) - 1;
            if (count <= 0) this.activeReviewers.delete(reviewDef.name);
            else this.activeReviewers.set(reviewDef.name, count);
          }
        }

        await this.captureAgentReport(
          runId,
          step.name,
          lastEffectiveAgentDef,
          lastEffectiveCwd,
          lastAttemptStartedAt,
          Date.now()
        );

        // Mark completed
        state.row.status = 'completed';
        state.row.output = combinedOutput;
        state.row.completionReason = completionReason;
        state.row.completedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'completed',
          output: combinedOutput,
          completionReason,
          completedAt: state.row.completedAt,
          updatedAt: new Date().toISOString(),
        });

        // Persist step output to disk so it survives restarts and is inspectable
        await this.persistStepOutput(runId, step.name, combinedOutput);

        this.emit({ type: 'step:completed', runId, stepName: step.name, output: combinedOutput, exitCode: lastExitCode, exitSignal: lastExitSignal });
        this.finalizeStepEvidence(
          step.name,
          'completed',
          state.row.completedAt,
          completionReason
        );
        await this.trajectory?.stepCompleted(step, combinedOutput, attempt + 1);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastCompletionReason =
          err instanceof WorkflowCompletionError ? err.completionReason : undefined;
        if (lastCompletionReason === 'retry_requested_by_owner' && attempt >= maxRetries) {
          lastError = this.buildOwnerRetryBudgetExceededMessage(step.name, maxRetries, lastError);
        }
        if (err instanceof SpawnExitError) {
          lastExitCode = err.exitCode;
          lastExitSignal = err.exitSignal;
        }
        const ownerTimedOut = usesDedicatedOwner
          ? /\bowner timed out\b/i.test(lastError)
          : /\btimed out\b/i.test(lastError) && !lastError.includes(`${step.name}-review`);
        if (ownerTimedOut) {
          this.emit({ type: 'step:owner-timeout', runId, stepName: step.name, ownerName: ownerDef.name });
        }
      }
    }

    // All retries exhausted — record root-cause diagnosis and mark failed
    const nonInteractive =
      ownerDef.interactive === false || ['worker', 'reviewer', 'analyst'].includes(ownerDef.preset ?? '');
    const verificationValue =
      typeof step.verification === 'object' && 'value' in step.verification
        ? String(step.verification.value)
        : undefined;
    await this.captureAgentReport(
      runId,
      step.name,
      lastEffectiveAgentDef,
      lastEffectiveCwd,
      lastAttemptStartedAt,
      Date.now()
    );
    await this.trajectory?.stepFailed(step, lastError ?? 'Unknown error', maxRetries + 1, maxRetries, {
      agent: agentName,
      nonInteractive,
      verificationValue,
    });
    this.postToChannel(`**[${step.name}]** Failed: ${lastError ?? 'Unknown error'}`);
    await this.markStepFailed(state, lastError ?? 'Unknown error', runId, {
      exitCode: lastExitCode,
      exitSignal: lastExitSignal,
    }, lastCompletionReason);
    throw new Error(
      `Step "${step.name}" failed after ${maxRetries} retries: ${lastError ?? 'Unknown error'}`
    );
  }

  private buildOwnerRetryBudgetExceededMessage(
    stepName: string,
    maxRetries: number,
    ownerDecisionError?: string
  ): string {
    const attempts = maxRetries + 1;
    const prefix = `Step "${stepName}" `;
    const normalizedDecision = ownerDecisionError?.startsWith(prefix)
      ? ownerDecisionError.slice(prefix.length).trim()
      : ownerDecisionError?.trim();
    const decisionSuffix = normalizedDecision
      ? ` Latest owner decision: ${normalizedDecision}`
      : '';

    if (maxRetries === 0) {
      return (
        `Step "${stepName}" owner requested another attempt, but no retries are configured ` +
        `(maxRetries=0). Configure retries > 0 to allow OWNER_DECISION: INCOMPLETE_RETRY.` +
        decisionSuffix
      );
    }

    return (
      `Step "${stepName}" owner requested another attempt after ${attempts} total attempts, ` +
      `but the retry budget is exhausted (maxRetries=${maxRetries}).` +
      decisionSuffix
    );
  }

  private injectStepOwnerContract(
    step: WorkflowStep,
    resolvedTask: string,
    ownerDef: AgentDefinition,
    specialistDef: AgentDefinition
  ): string {
    if (ownerDef.interactive === false) return resolvedTask;
    const specialistNote =
      ownerDef.name === specialistDef.name
        ? ''
        : `Specialist intended for this step: "${specialistDef.name}" (${specialistDef.role ?? specialistDef.cli}).`;
    return (
      resolvedTask +
      '\n\n---\n' +
      `STEP OWNER CONTRACT:\n` +
      `- You are the accountable owner for step "${step.name}".\n` +
      (specialistNote ? `- ${specialistNote}\n` : '') +
      `- If you delegate, you must still verify completion yourself.\n` +
      `- Preferred final decision format:\n` +
      `  OWNER_DECISION: <one of COMPLETE, INCOMPLETE_RETRY, INCOMPLETE_FAIL, NEEDS_CLARIFICATION>\n` +
      `  REASON: <one sentence>\n` +
      `- Legacy completion marker still supported: STEP_COMPLETE:${step.name}\n` +
      `- Then self-terminate immediately with /exit.`
    );
  }

  private buildOwnerSupervisorTask(
    step: WorkflowStep,
    originalTask: string,
    supervised: SupervisedStep,
    workerRuntimeName: string
  ): string {
    const verificationGuide = this.buildSupervisorVerificationGuide(step.verification);
    const channelLine = this.channel ? `#${this.channel}` : '(workflow channel unavailable)';
    const channelContract = this.channel
      ? `- Prefer Relaycast/group-chat handoff signals over terminal sentinels: wait for the worker to post \`WORKER_DONE: <brief summary>\` in ${channelLine}\n` +
        `- When you have validated the handoff, post \`LEAD_DONE: <brief summary>\` to ${channelLine} before you exit\n`
      : '';
    return (
      `You are the step owner/supervisor for step "${step.name}".\n\n` +
      `Worker: ${supervised.specialist.name} (runtime: ${workerRuntimeName}) on ${channelLine}\n` +
      `Task: ${originalTask}\n\n` +
      `Your job: Monitor the worker and determine when the task is complete.\n\n` +
      `How to verify completion:\n` +
      `- Watch ${channelLine} for the worker's progress messages and mirrored PTY output\n` +
      `- Check file changes: run \`git diff --stat\` or inspect expected files directly\n` +
      `- Ask the worker directly on ${channelLine} if you need a status update\n` +
      channelContract +
      verificationGuide +
      `\nWhen you have enough evidence, return:\n` +
      `OWNER_DECISION: <one of COMPLETE, INCOMPLETE_RETRY, INCOMPLETE_FAIL, NEEDS_CLARIFICATION>\n` +
      `REASON: <one sentence>\n` +
      `Legacy completion marker still supported: STEP_COMPLETE:${step.name}`
    );
  }

  private buildWorkerHandoffTask(
    step: WorkflowStep,
    originalTask: string,
    supervised: SupervisedStep
  ): string {
    if (!this.channel) return originalTask;

    return (
      `${originalTask}\n\n---\n` +
      `WORKER COMPLETION CONTRACT:\n` +
      `- You are handing work off to owner "${supervised.owner.name}" for step "${step.name}".\n` +
      `- When your work is ready for review, post to #${this.channel}: \`WORKER_DONE: <brief summary>\`\n` +
      `- Do not rely on terminal output alone for handoff; use the workflow group chat signal above.\n` +
      `- After posting your handoff signal, self-terminate with /exit unless the owner asks for follow-up.`
    );
  }

  private buildSupervisorVerificationGuide(verification?: VerificationCheck): string {
    if (!verification) return '';
    switch (verification.type) {
      case 'output_contains':
        return `- Verification gate: confirm the worker output contains ${JSON.stringify(verification.value)}\n`;
      case 'file_exists':
        return `- Verification gate: confirm the file exists at ${JSON.stringify(verification.value)}\n`;
      case 'exit_code':
        return `- Verification gate: confirm the worker exits with code ${JSON.stringify(verification.value)}\n`;
      case 'custom':
        return `- Verification gate: apply the custom verification rule ${JSON.stringify(verification.value)}\n`;
      default:
        return '';
    }
  }

  private async executeSupervisedAgentStep(
    step: WorkflowStep,
    supervised: SupervisedStep,
    resolvedTask: string,
    timeoutMs?: number
  ): Promise<{
    specialistOutput: string;
    ownerOutput: string;
    ownerElapsed: number;
    completionReason: WorkflowStepCompletionReason;
  }> {
    if (this.executor) {
      const specialistTask = this.buildWorkerHandoffTask(step, resolvedTask, supervised);
      const supervisorTask = this.buildOwnerSupervisorTask(
        step,
        resolvedTask,
        supervised,
        supervised.specialist.name
      );
      const specialistStep = { ...step, task: specialistTask };
      const ownerStep: WorkflowStep = {
        ...step,
        name: `${step.name}-owner`,
        agent: supervised.owner.name,
        task: supervisorTask,
      };

      this.log(
        `[${step.name}] Spawning specialist "${supervised.specialist.name}" and owner "${supervised.owner.name}"`
      );
      const specialistPromise = this.executor.executeAgentStep(
        specialistStep,
        supervised.specialist,
        specialistTask,
        timeoutMs
      );
      // Guard against unhandled rejection if owner fails before specialist settles
      const specialistSettled = specialistPromise.catch(() => undefined);

      try {
        const ownerStartTime = Date.now();
        const ownerOutput = await this.executor.executeAgentStep(
          ownerStep,
          supervised.owner,
          supervisorTask,
          timeoutMs
        );
        const ownerElapsed = Date.now() - ownerStartTime;
        const specialistOutput = await specialistPromise;
        const completionDecision = this.resolveOwnerCompletionDecision(
          step,
          ownerOutput,
          specialistOutput,
          supervisorTask,
          resolvedTask
        );
        return {
          specialistOutput,
          ownerOutput,
          ownerElapsed,
          completionReason: completionDecision.completionReason,
        };
      } catch (error) {
        await specialistSettled;
        throw error;
      }
    }

    let workerHandle: Agent | undefined;
    let workerRuntimeName = supervised.specialist.name;
    let workerSpawned = false;
    let workerReleased = false;
    let resolveWorkerSpawn!: () => void;
    let rejectWorkerSpawn!: (error: unknown) => void;
    const workerReady = new Promise<void>((resolve, reject) => {
      resolveWorkerSpawn = resolve;
      rejectWorkerSpawn = reject;
    });

    const specialistTask = this.buildWorkerHandoffTask(step, resolvedTask, supervised);
    const specialistStep = { ...step, task: specialistTask };
    this.log(
      `[${step.name}] Spawning specialist "${supervised.specialist.name}" (cli: ${supervised.specialist.cli})`
    );
    const workerPromise = this.spawnAndWait(supervised.specialist, specialistStep, timeoutMs, {
      agentNameSuffix: 'worker',
      evidenceStepName: step.name,
      evidenceRole: 'worker',
      logicalName: supervised.specialist.name,
      onSpawned: ({ actualName, agent }) => {
        workerHandle = agent;
        workerRuntimeName = actualName;
        this.supervisedRuntimeAgents.set(actualName, {
          stepName: step.name,
          role: 'specialist',
          logicalName: supervised.specialist.name,
        });
        if (!workerSpawned) {
          workerSpawned = true;
          resolveWorkerSpawn();
        }
      },
      onChunk: ({ agentName, chunk }) => {
        this.forwardAgentChunkToChannel(
          step.name,
          'Worker',
          agentName,
          chunk,
          supervised.specialist.name
        );
      },
    }).catch((error) => {
      if (!workerSpawned) {
        workerSpawned = true;
        rejectWorkerSpawn(error);
      }
      throw error;
    });

    const workerSettled = workerPromise.catch(() => undefined);
    workerPromise
      .then((result) => {
        workerReleased = true;
        this.log(`[${step.name}] Worker ${workerRuntimeName} exited`);
        this.recordStepToolSideEffect(step.name, {
          type: 'worker_exit',
          detail: `Worker ${workerRuntimeName} exited`,
          raw: { worker: workerRuntimeName, exitCode: result.exitCode, exitSignal: result.exitSignal },
        });
        if (
          step.verification?.type === 'output_contains' &&
          this.outputContainsVerificationToken(
            result.output,
            step.verification.value,
            result.promptTaskText
          )
        ) {
          this.log(
            `[${step.name}] Verification gate observed: output contains ${JSON.stringify(step.verification.value)}`
          );
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.postToChannel(
          `**[${step.name}]** Worker \`${workerRuntimeName}\` exited with error: ${message}`
        );
        this.recordStepToolSideEffect(step.name, {
          type: 'worker_error',
          detail: `Worker ${workerRuntimeName} exited with error: ${message}`,
          raw: { worker: workerRuntimeName, error: message },
        });
      });

    await workerReady;

    const supervisorTask = this.buildOwnerSupervisorTask(step, resolvedTask, supervised, workerRuntimeName);
    const ownerStep: WorkflowStep = {
      ...step,
      name: `${step.name}-owner`,
      agent: supervised.owner.name,
      task: supervisorTask,
    };

    this.log(`[${step.name}] Spawning owner "${supervised.owner.name}" (cli: ${supervised.owner.cli})`);
    const ownerStartTime = Date.now();

    try {
      const ownerResultObj = await this.spawnAndWait(supervised.owner, ownerStep, timeoutMs, {
        agentNameSuffix: 'owner',
        evidenceStepName: step.name,
        evidenceRole: 'owner',
        logicalName: supervised.owner.name,
        onSpawned: ({ actualName }) => {
          this.supervisedRuntimeAgents.set(actualName, {
            stepName: step.name,
            role: 'owner',
            logicalName: supervised.owner.name,
          });
        },
        onChunk: ({ chunk }) => {
          void this.recordOwnerMonitoringChunk(step, supervised.owner, chunk);
        },
      });
      const ownerElapsed = Date.now() - ownerStartTime;
      const ownerOutput = ownerResultObj.output;
      this.log(`[${step.name}] Owner "${supervised.owner.name}" exited`);
      const workerResultObj = await workerPromise;
      const specialistOutput = workerResultObj.output;
      const completionDecision = this.resolveOwnerCompletionDecision(
        step,
        ownerOutput,
        specialistOutput,
        ownerResultObj.promptTaskText ?? supervisorTask,
        workerResultObj.promptTaskText ?? specialistTask
      );
      return {
        specialistOutput,
        ownerOutput,
        ownerElapsed,
        completionReason: completionDecision.completionReason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!workerReleased && workerHandle) {
        await workerHandle.release().catch(() => undefined);
      }
      await workerSettled;
      if (/\btimed out\b/i.test(message)) {
        throw new Error(`Step "${step.name}" owner timed out after ${timeoutMs ?? 'unknown'}ms`);
      }
      throw error;
    }
  }

  private forwardAgentChunkToChannel(
    stepName: string,
    roleLabel: string,
    agentName: string,
    chunk: string,
    sender?: string
  ): void {
    const lines = WorkflowRunner.scrubForChannel(chunk)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3);
    for (const line of lines) {
      this.postToChannel(`**[${stepName}]** ${roleLabel} \`${agentName}\`: ${line.slice(0, 280)}`, {
        stepName,
        sender,
        actor: agentName,
        role: roleLabel,
        origin: 'forwarded_chunk',
      });
    }
  }

  private async recordOwnerMonitoringChunk(
    step: WorkflowStep,
    ownerDef: AgentDefinition,
    chunk: string
  ): Promise<void> {
    const stripped = WorkflowRunner.stripAnsi(chunk);
    const details: string[] = [];
    if (/git diff --stat/i.test(stripped)) details.push('Checked git diff stats');
    if (/\bls -la\b/i.test(stripped)) details.push('Listed files for verification');
    if (/status update\?/i.test(stripped)) details.push('Asked the worker for a status update');
    if (/STEP_COMPLETE:/i.test(stripped)) details.push('Declared the step complete');

    for (const detail of details) {
      this.recordStepToolSideEffect(step.name, {
        type: 'owner_monitoring',
        detail,
        raw: { output: stripped.slice(0, 240), owner: ownerDef.name },
      });
      await this.trajectory?.ownerMonitoringEvent(step.name, ownerDef.name, detail, {
        output: stripped.slice(0, 240),
      });
    }
  }

  private resolveAutoStepOwner(
    specialistDef: AgentDefinition,
    agentMap: Map<string, AgentDefinition>
  ): AgentDefinition {
    if (specialistDef.interactive === false) return specialistDef;

    const allDefs = [...agentMap.values()].map((d) => WorkflowRunner.resolveAgentDef(d));
    const candidates = allDefs.filter((d) => d.interactive !== false);
    const matchesHubRole = (text: string): boolean =>
      [...WorkflowRunner.HUB_ROLES].some((r) => new RegExp(`\\b${r}\\b`, 'i').test(text));
    const ownerish = (def: AgentDefinition): boolean => {
      const nameLC = def.name.toLowerCase();
      const roleLC = def.role?.toLowerCase() ?? '';
      return matchesHubRole(nameLC) || matchesHubRole(roleLC);
    };
    const ownerPriority = (def: AgentDefinition): number => {
      const roleLC = def.role?.toLowerCase() ?? '';
      const nameLC = def.name.toLowerCase();
      if (/\blead\b/.test(roleLC) || /\blead\b/.test(nameLC)) return 6;
      if (/\bcoordinator\b/.test(roleLC) || /\bcoordinator\b/.test(nameLC)) return 5;
      if (/\bsupervisor\b/.test(roleLC) || /\bsupervisor\b/.test(nameLC)) return 4;
      if (/\borchestrator\b/.test(roleLC) || /\borchestrator\b/.test(nameLC)) return 3;
      if (/\bhub\b/.test(roleLC) || /\bhub\b/.test(nameLC)) return 2;
      return ownerish(def) ? 1 : 0;
    };
    const dedicatedOwner = candidates
      .filter((d) => d.name !== specialistDef.name && ownerish(d))
      .sort((a, b) => ownerPriority(b) - ownerPriority(a) || a.name.localeCompare(b.name))[0];
    if (dedicatedOwner) return dedicatedOwner;
    return specialistDef;
  }

  private resolveAutoReviewAgent(
    ownerDef: AgentDefinition,
    agentMap: Map<string, AgentDefinition>
  ): AgentDefinition {
    const allDefs = [...agentMap.values()].map((d) => WorkflowRunner.resolveAgentDef(d));
    const eligible = (def: AgentDefinition): boolean =>
      def.name !== ownerDef.name && !this.isExplicitInteractiveWorker(def);
    const isReviewer = (def: AgentDefinition): boolean => {
      const roleLC = def.role?.toLowerCase() ?? '';
      const nameLC = def.name.toLowerCase();
      return (
        def.preset === 'reviewer' ||
        roleLC.includes('review') ||
        roleLC.includes('critic') ||
        roleLC.includes('verifier') ||
        roleLC.includes('qa') ||
        nameLC.includes('review')
      );
    };
    const reviewerPriority = (def: AgentDefinition): number => {
      if (def.preset === 'reviewer') return 5;
      const roleLC = def.role?.toLowerCase() ?? '';
      const nameLC = def.name.toLowerCase();
      if (roleLC.includes('review') || nameLC.includes('review')) return 4;
      if (roleLC.includes('verifier') || roleLC.includes('qa')) return 3;
      if (roleLC.includes('critic')) return 2;
      return isReviewer(def) ? 1 : 0;
    };
    // Prefer agents not currently assigned as reviewers to avoid double-booking
    const notBusy = (def: AgentDefinition): boolean => !this.activeReviewers.has(def.name);

    const dedicatedCandidates = allDefs
      .filter((d) => eligible(d) && isReviewer(d))
      .sort((a, b) => reviewerPriority(b) - reviewerPriority(a) || a.name.localeCompare(b.name));
    const dedicated = dedicatedCandidates.find(notBusy) ?? dedicatedCandidates[0];
    if (dedicated) return dedicated;

    const alternateCandidates = allDefs.filter((d) => eligible(d) && d.interactive !== false);
    const alternate = alternateCandidates.find(notBusy) ?? alternateCandidates[0];
    if (alternate) return alternate;

    // Self-review fallback — log a warning since owner reviewing itself is weak.
    return ownerDef;
  }

  private isExplicitInteractiveWorker(agentDef: AgentDefinition): boolean {
    return agentDef.preset === 'worker' && agentDef.interactive !== false;
  }

  private resolveOwnerCompletionDecision(
    step: WorkflowStep,
    ownerOutput: string,
    specialistOutput: string,
    injectedTaskText: string,
    verificationTaskText?: string
  ): CompletionDecisionResult {
    const hasMarker = this.hasOwnerCompletionMarker(step, ownerOutput, injectedTaskText);
    const explicitOwnerDecision = this.parseOwnerDecision(step, ownerOutput, false);

    // INCOMPLETE_RETRY / NEEDS_CLARIFICATION are non-terminal owner outcomes. They never mark
    // the step complete here; instead they throw back to executeAgentStep(), which decides
    // whether to retry or fail based on the remaining retry budget for this step.
    if (explicitOwnerDecision?.decision === 'INCOMPLETE_RETRY') {
      throw new WorkflowCompletionError(
        `Step "${step.name}" owner requested retry${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
        'retry_requested_by_owner'
      );
    }
    if (explicitOwnerDecision?.decision === 'INCOMPLETE_FAIL') {
      throw new WorkflowCompletionError(
        `Step "${step.name}" owner marked the step incomplete${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
        'failed_owner_decision'
      );
    }
    if (explicitOwnerDecision?.decision === 'NEEDS_CLARIFICATION') {
      throw new WorkflowCompletionError(
        `Step "${step.name}" owner requested clarification before completion${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
        'retry_requested_by_owner'
      );
    }

    const verificationResult = step.verification
      ? this.runVerification(step.verification, specialistOutput, step.name, verificationTaskText, {
          allowFailure: true,
          completionMarkerFound: hasMarker,
        })
      : { passed: false };

    if (verificationResult.error) {
      throw new WorkflowCompletionError(
        `Step "${step.name}" verification failed and no owner decision or evidence established completion: ${verificationResult.error}`,
        'failed_verification'
      );
    }

    if (explicitOwnerDecision?.decision === 'COMPLETE') {
      if (!hasMarker) {
        this.log(
          `[${step.name}] Structured OWNER_DECISION completed the step without legacy STEP_COMPLETE marker`
        );
      }
      return {
        completionReason: 'completed_by_owner_decision',
        ownerDecision: explicitOwnerDecision.decision,
        reason: explicitOwnerDecision.reason,
      };
    }
    if (verificationResult.passed) {
      return { completionReason: 'completed_verified' };
    }

    const ownerDecision = this.parseOwnerDecision(step, ownerOutput, hasMarker);
    if (ownerDecision?.decision === 'COMPLETE') {
      return {
        completionReason: 'completed_by_owner_decision',
        ownerDecision: ownerDecision.decision,
        reason: ownerDecision.reason,
      };
    }

    if (!explicitOwnerDecision) {
      const evidenceReason = this.judgeOwnerCompletionByEvidence(step.name, ownerOutput);
      if (evidenceReason) {
        if (!hasMarker) {
          this.log(
            `[${step.name}] Evidence-based completion resolved without legacy STEP_COMPLETE marker`
          );
        }
        return {
          completionReason: 'completed_by_evidence',
          reason: evidenceReason,
        };
      }
    }

    // Process-exit fallback: if the agent exited cleanly (code 0) and verification
    // passes (or no verification is configured), infer completion rather than failing.
    // This reduces dependence on agents posting exact coordination signals.
    const processExitFallback = this.tryProcessExitFallback(step, specialistOutput, verificationTaskText, ownerOutput);
    if (processExitFallback) {
      this.log(
        `[${step.name}] Completion inferred from clean process exit (code 0)` +
          (step.verification ? ' + verification passed' : '') +
          ' — no coordination signal was required'
      );
      return processExitFallback;
    }

    throw new WorkflowCompletionError(
      `Step "${step.name}" owner completion decision missing: no OWNER_DECISION, legacy STEP_COMPLETE marker, or evidence-backed completion signal`,
      'failed_no_evidence'
    );
  }

  private hasExplicitInteractiveWorkerCompletionEvidence(
    step: WorkflowStep,
    output: string,
    injectedTaskText: string,
    verificationTaskText: string
  ): boolean {
    try {
      this.resolveOwnerCompletionDecision(step, output, output, injectedTaskText, verificationTaskText);
      return true;
    } catch {
      return false;
    }
  }

  private hasOwnerCompletionMarker(
    step: WorkflowStep,
    output: string,
    injectedTaskText: string
  ): boolean {
    const marker = `STEP_COMPLETE:${step.name}`;
    const strippedOutput = this.stripInjectedTaskEcho(output, injectedTaskText);
    if (strippedOutput.includes(marker)) {
      return true;
    }
    const taskHasMarker = injectedTaskText.includes(marker);
    const first = output.indexOf(marker);
    if (first === -1) {
      return false;
    }
    // PTY output often includes echoed prompt text, so when the injected task
    // itself contains the legacy marker require a second occurrence from the
    // agent response.
    const outputLikelyContainsInjectedPrompt =
      output.includes('STEP OWNER CONTRACT') ||
      output.includes('Preferred final decision format') ||
      output.includes('Legacy completion marker still supported') ||
      output.includes('Output exactly: STEP_COMPLETE:');
    if (taskHasMarker && outputLikelyContainsInjectedPrompt) {
      return output.includes(marker, first + marker.length);
    }
    return true;
  }

  private parseOwnerDecision(
    step: WorkflowStep,
    ownerOutput: string,
    hasMarker: boolean
  ): { decision: WorkflowOwnerDecision; reason?: string } | null {
    const decisionPattern =
      /OWNER_DECISION:\s*(COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/gi;
    const decisionMatches = [...ownerOutput.matchAll(decisionPattern)];
    const outputLikelyContainsEchoedPrompt =
      ownerOutput.includes('STEP OWNER CONTRACT') ||
      ownerOutput.includes('Preferred final decision format') ||
      ownerOutput.includes('one of COMPLETE, INCOMPLETE_RETRY') ||
      ownerOutput.includes('COMPLETE|INCOMPLETE_RETRY');

    if (decisionMatches.length === 0) {
      if (!hasMarker) return null;
      return {
        decision: 'COMPLETE',
        reason: `Legacy completion marker observed: STEP_COMPLETE:${step.name}`,
      };
    }

    // Filter out matches that appear on a template/instruction line (e.g.
    // "COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION") to avoid
    // picking up the template format as the agent's actual decision.
    const realMatches = outputLikelyContainsEchoedPrompt
      ? decisionMatches.filter((m) => {
          const lineStart = ownerOutput.lastIndexOf('\n', m.index!) + 1;
          const lineEnd = ownerOutput.indexOf('\n', m.index!);
          const line = ownerOutput.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          return !line.includes('COMPLETE|INCOMPLETE_RETRY');
        })
      : decisionMatches;
    const decisionMatch =
      realMatches.length > 0
        ? realMatches[realMatches.length - 1]
        : decisionMatches[decisionMatches.length - 1];
    const decision = decisionMatch?.[1]?.toUpperCase() as WorkflowOwnerDecision | undefined;
    if (
      decision !== 'COMPLETE' &&
      decision !== 'INCOMPLETE_RETRY' &&
      decision !== 'INCOMPLETE_FAIL' &&
      decision !== 'NEEDS_CLARIFICATION'
    ) {
      return null;
    }

    const reasonPattern = /(?:^|\n)REASON:\s*(.+)/gi;
    const reasonMatches = [...ownerOutput.matchAll(reasonPattern)];
    const reasonMatch =
      outputLikelyContainsEchoedPrompt && reasonMatches.length > 1
        ? reasonMatches[reasonMatches.length - 1]
        : reasonMatches[0];
    const reason = reasonMatch?.[1]?.trim();

    return {
      decision,
      reason: reason && reason !== '<one sentence>' ? reason : undefined,
    };
  }

  private stripEchoedPromptLines(output: string, patterns: RegExp[]): string {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => patterns.every((pattern) => !pattern.test(line)))
      .join('\n');
  }

  private stripInjectedTaskEcho(output: string, injectedTaskText?: string): string {
    if (!injectedTaskText) {
      return output;
    }

    const candidates = [
      injectedTaskText,
      injectedTaskText.replace(/\r\n/g, '\n'),
      injectedTaskText.replace(/\n/g, '\r\n'),
    ].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

    for (const candidate of candidates) {
      const start = output.indexOf(candidate);
      if (start !== -1) {
        return output.slice(0, start) + output.slice(start + candidate.length);
      }
    }

    return output;
  }

  private outputContainsVerificationToken(
    output: string,
    token: string,
    injectedTaskText?: string
  ): boolean {
    if (!token) {
      return false;
    }
    return this.stripInjectedTaskEcho(output, injectedTaskText).includes(token);
  }

  private prepareInteractiveSpawnTask(
    agentName: string,
    taskText: string
  ): { spawnTaskText: string; promptTaskText: string; taskTmpFile?: string } {
    if (Buffer.byteLength(taskText, 'utf8') <= WorkflowRunner.PTY_TASK_ARG_SIZE_LIMIT) {
      return {
        spawnTaskText: taskText,
        promptTaskText: taskText,
      };
    }

    const taskTmpDir = mkdtempSync(path.join(tmpdir(), 'relay-pty-task-'));
    const taskTmpFile = path.join(taskTmpDir, `${agentName}-${Date.now()}.txt`);
    writeFileSync(taskTmpFile, taskText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const promptTaskText =
      `TASK_FILE:${taskTmpFile}\n` +
      'Read that file completely before taking any action.\n' +
      'Treat the file contents as the full workflow task and follow them exactly.\n' +
      'Do not ask for the task again.';

    return {
      spawnTaskText: promptTaskText,
      promptTaskText,
      taskTmpFile,
    };
  }

  private firstMeaningfulLine(output: string): string | undefined {
    return output
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
  }

  private judgeOwnerCompletionByEvidence(stepName: string, ownerOutput: string): string | null {
    // Never infer completion when the raw output contains an explicit retry/fail/clarification signal.
    if (/OWNER_DECISION:\s*(?:INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/i.test(ownerOutput)) {
      return null;
    }
    const sanitized = this.stripEchoedPromptLines(ownerOutput, [
      /^STEP OWNER CONTRACT:?$/i,
      /^Preferred final decision format:?$/i,
      /^OWNER_DECISION:\s*(?:COMPLETE\|INCOMPLETE_RETRY|<one of COMPLETE, INCOMPLETE_RETRY)/i,
      /^REASON:\s*<one sentence>$/i,
      /^Legacy completion marker still supported:/i,
      /^STEP_COMPLETE:/i,
    ]);
    if (!sanitized) return null;

    const hasExplicitSelfRelease =
      /Calling\s+(?:[\w.-]+\.)?remove_agent\(\{[^<\n]*"reason":"task completed"/i.test(
        sanitized
      );
    const hasPositiveConclusion =
      /\b(complete(?:d)?|done|verified|looks correct|safe handoff|artifact verified)\b/i.test(
        sanitized
      ) ||
      /\bartifacts?\b.*\b(correct|verified|complete)\b/i.test(sanitized) ||
      hasExplicitSelfRelease;
    const evidence = this.getStepCompletionEvidence(stepName);
    const hasValidatedCoordinationSignal =
      evidence?.coordinationSignals.some(
        (signal) =>
          signal.kind === 'worker_done' ||
          signal.kind === 'lead_done' ||
          signal.kind === 'verification_passed' ||
          (signal.kind === 'process_exit' && signal.value === '0')
      ) ?? false;
    const hasValidatedInspectionSignal =
      evidence?.toolSideEffects.some(
        (effect) =>
          effect.type === 'owner_monitoring' &&
          (/Checked git diff stats/i.test(effect.detail) ||
            /Listed files for verification/i.test(effect.detail))
      ) ?? false;
    const hasEvidenceSignal = hasValidatedCoordinationSignal || hasValidatedInspectionSignal;

    if (!hasPositiveConclusion || !hasEvidenceSignal) {
      return null;
    }

    return this.firstMeaningfulLine(sanitized) ?? 'Evidence-backed completion';
  }

  /**
   * Process-exit fallback: when agent exits with code 0 but posts no coordination
   * signal, check if verification passes (or no verification is configured) and
   * infer completion. This is the key mechanism for reducing agent compliance
   * dependence — the runner trusts a clean exit + passing verification over
   * requiring exact signal text.
   */
  private tryProcessExitFallback(
    step: WorkflowStep,
    specialistOutput: string,
    verificationTaskText?: string,
    ownerOutput?: string
  ): CompletionDecisionResult | null {
    const gracePeriodMs = this.currentConfig?.swarm.completionGracePeriodMs ?? 5000;
    if (gracePeriodMs === 0) return null;

    // Never infer completion when the owner explicitly requested retry/fail/clarification.
    if (ownerOutput && /OWNER_DECISION:\s*(?:INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/i.test(ownerOutput)) {
      return null;
    }

    const evidence = this.getStepCompletionEvidence(step.name);
    const hasCleanExit = evidence?.coordinationSignals.some(
      (signal) =>
        signal.kind === 'process_exit' && signal.value === '0'
    ) ?? false;

    if (!hasCleanExit) return null;

    // If verification is configured, it must pass for the fallback to succeed.
    if (step.verification) {
      const verificationResult = this.runVerification(
        step.verification,
        specialistOutput,
        step.name,
        verificationTaskText,
        { allowFailure: true }
      );
      if (!verificationResult.passed) return null;
    }

    return {
      completionReason: 'completed_by_process_exit',
      reason: `Process exited with code 0${step.verification ? ' and verification passed' : ''} — coordination signal not required`,
    };
  }

  private async runStepReviewGate(
    step: WorkflowStep,
    resolvedTask: string,
    specialistOutput: string,
    ownerOutput: string,
    ownerDef: AgentDefinition,
    reviewerDef: AgentDefinition,
    timeoutMs?: number
  ): Promise<string> {
    const reviewSnippetMax = 12_000;
    let specialistSnippet = specialistOutput;
    if (specialistOutput.length > reviewSnippetMax) {
      const head = Math.floor(reviewSnippetMax / 2);
      const tail = reviewSnippetMax - head;
      const omitted = specialistOutput.length - head - tail;
      specialistSnippet =
        `${specialistOutput.slice(0, head)}\n` +
        `...[truncated ${omitted} chars for review]...\n` +
        `${specialistOutput.slice(specialistOutput.length - tail)}`;
    }

    let ownerSnippet = ownerOutput;
    if (ownerOutput.length > reviewSnippetMax) {
      const head = Math.floor(reviewSnippetMax / 2);
      const tail = reviewSnippetMax - head;
      const omitted = ownerOutput.length - head - tail;
      ownerSnippet =
        `${ownerOutput.slice(0, head)}\n` +
        `...[truncated ${omitted} chars for review]...\n` +
        `${ownerOutput.slice(ownerOutput.length - tail)}`;
    }

    const reviewTask =
      `Review workflow step "${step.name}" for completion and safe handoff.\n` +
      `Step owner: ${ownerDef.name}\n` +
      `Original objective:\n${resolvedTask}\n\n` +
      `Specialist output:\n${specialistSnippet}\n\n` +
      `Owner verification notes:\n${ownerSnippet}\n\n` +
      `Return exactly:\n` +
      `REVIEW_DECISION: APPROVE or REJECT\n` +
      `REVIEW_REASON: <one sentence>\n` +
      `Then output /exit.`;

    const safetyTimeoutMs = timeoutMs ?? 600_000;
    const reviewStep: WorkflowStep = {
      name: `${step.name}-review`,
      type: 'agent',
      agent: reviewerDef.name,
      task: reviewTask,
    };

    await this.trajectory?.registerAgent(reviewerDef.name, 'reviewer');
    this.postToChannel(`**[${step.name}]** Review started (reviewer: ${reviewerDef.name})`);
    this.recordStepToolSideEffect(step.name, {
      type: 'review_started',
      detail: `Review started with ${reviewerDef.name}`,
      raw: { reviewer: reviewerDef.name },
    });
    const emitReviewCompleted = async (decision: 'approved' | 'rejected', reason?: string) => {
      this.recordStepToolSideEffect(step.name, {
        type: 'review_completed',
        detail: `Review ${decision} by ${reviewerDef.name}${reason ? `: ${reason}` : ''}`,
        raw: { reviewer: reviewerDef.name, decision, reason },
      });
      await this.trajectory?.reviewCompleted(step.name, reviewerDef.name, decision, reason);
      this.emit({
        type: 'step:review-completed',
        runId: this.currentRunId ?? '',
        stepName: step.name,
        reviewerName: reviewerDef.name,
        decision,
      });
    };

    if (this.executor) {
      const reviewOutput = await this.executor.executeAgentStep(
        reviewStep,
        reviewerDef,
        reviewTask,
        safetyTimeoutMs
      );
      const parsed = this.parseReviewDecision(reviewOutput);
      if (!parsed) {
        throw new Error(
          `Step "${step.name}" review response malformed from "${reviewerDef.name}" (missing REVIEW_DECISION)`
        );
      }
      await emitReviewCompleted(parsed.decision, parsed.reason);
      if (parsed.decision === 'rejected') {
        throw new Error(`Step "${step.name}" review rejected by "${reviewerDef.name}"`);
      }
      this.postToChannel(`**[${step.name}]** Review approved by \`${reviewerDef.name}\``);
      return reviewOutput;
    }

    let reviewerHandle: Agent | undefined;
    let reviewerReleased = false;
    let reviewOutput = '';
    let completedReview:
      | { decision: 'approved' | 'rejected'; reason?: string }
      | undefined;
    let reviewCompletionPromise: Promise<void> | undefined;
    const reviewCompletionStarted = { value: false };

    const startReviewCompletion = (parsed: { decision: 'approved' | 'rejected'; reason?: string }) => {
      if (reviewCompletionStarted.value) return;
      reviewCompletionStarted.value = true;
      completedReview = parsed;
      reviewCompletionPromise = (async () => {
        await emitReviewCompleted(parsed.decision, parsed.reason);
        if (reviewerHandle && !reviewerReleased) {
          reviewerReleased = true;
          await reviewerHandle.release().catch(() => undefined);
        }
      })();
    };

    try {
      await this.spawnAndWait(reviewerDef, reviewStep, safetyTimeoutMs, {
        evidenceStepName: step.name,
        evidenceRole: 'reviewer',
        logicalName: reviewerDef.name,
        onSpawned: ({ agent }) => {
          reviewerHandle = agent;
        },
        onChunk: ({ chunk }) => {
          const nextOutput = reviewOutput + WorkflowRunner.stripAnsi(chunk);
          reviewOutput = nextOutput;
          const parsed = this.parseReviewDecision(nextOutput);
          if (parsed) {
            startReviewCompletion(parsed);
          }
        },
      });
      await reviewCompletionPromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\btimed out\b/i.test(message)) {
        this.log(`[${step.name}] Review safety backstop timeout fired after ${safetyTimeoutMs}ms`);
        throw new Error(
          `Step "${step.name}" review safety backstop timed out after ${safetyTimeoutMs}ms`
        );
      }
      throw error;
    }

    if (!completedReview) {
      const parsed = this.parseReviewDecision(reviewOutput);
      if (!parsed) {
        throw new Error(
          `Step "${step.name}" review response malformed from "${reviewerDef.name}" (missing REVIEW_DECISION)`
        );
      }
      completedReview = parsed;
      await emitReviewCompleted(parsed.decision, parsed.reason);
    }

    if (completedReview.decision === 'rejected') {
      throw new Error(`Step "${step.name}" review rejected by "${reviewerDef.name}"`);
    }

    this.postToChannel(`**[${step.name}]** Review approved by \`${reviewerDef.name}\``);
    return reviewOutput;
  }

  private parseReviewDecision(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const strict = this.parseStrictReviewDecision(reviewOutput);
    if (strict) {
      return strict;
    }

    const tolerant = this.parseTolerantReviewDecision(reviewOutput);
    if (tolerant) {
      return tolerant;
    }

    return this.judgeReviewDecisionFromEvidence(reviewOutput);
  }

  private parseStrictReviewDecision(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const decisionPattern = /REVIEW_DECISION:\s*(APPROVE|REJECT)/gi;
    const decisionMatches = [...reviewOutput.matchAll(decisionPattern)];
    if (decisionMatches.length === 0) {
      return null;
    }

    const outputLikelyContainsEchoedPrompt =
      reviewOutput.includes('Return exactly') || reviewOutput.includes('REVIEW_DECISION: APPROVE or REJECT');
    const realReviewMatches = outputLikelyContainsEchoedPrompt
      ? decisionMatches.filter((m) => {
          const lineStart = reviewOutput.lastIndexOf('\n', m.index!) + 1;
          const lineEnd = reviewOutput.indexOf('\n', m.index!);
          const line = reviewOutput.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          return !line.includes('APPROVE or REJECT');
        })
      : decisionMatches;
    const decisionMatch =
      realReviewMatches.length > 0
        ? realReviewMatches[realReviewMatches.length - 1]
        : decisionMatches[decisionMatches.length - 1];
    const decision = decisionMatch?.[1]?.toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      return null;
    }

    const reasonPattern = /REVIEW_REASON:\s*(.+)/gi;
    const reasonMatches = [...reviewOutput.matchAll(reasonPattern)];
    const reasonMatch =
      outputLikelyContainsEchoedPrompt && reasonMatches.length > 1
        ? reasonMatches[reasonMatches.length - 1]
        : reasonMatches[0];
    const reason = reasonMatch?.[1]?.trim();

    return {
      decision: decision === 'APPROVE' ? 'approved' : 'rejected',
      reason: reason && reason !== '<one sentence>' ? reason : undefined,
    };
  }

  private parseTolerantReviewDecision(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const sanitized = this.stripEchoedPromptLines(reviewOutput, [
      /^Return exactly:?$/i,
      /^REVIEW_DECISION:\s*APPROVE\s+or\s+REJECT$/i,
      /^REVIEW_REASON:\s*<one sentence>$/i,
    ]);
    if (!sanitized) {
      return null;
    }

    const lines = sanitized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const candidate = line.replace(/^REVIEW_DECISION:\s*/i, '').trim();
      const decision = this.normalizeReviewDecisionCandidate(candidate);
      if (decision) {
        return {
          decision,
          reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
        };
      }
    }

    const decision = this.normalizeReviewDecisionCandidate(lines.join(' '));
    if (!decision) {
      return null;
    }

    return {
      decision,
      reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
    };
  }

  private normalizeReviewDecisionCandidate(candidate: string): 'approved' | 'rejected' | null {
    const value = candidate.trim().toLowerCase();
    if (!value) return null;

    if (
      /^(approve|approved|complete|completed|pass|passed|accept|accepted|lgtm|ship it|looks good|looks fine)\b/i.test(
        value
      )
    ) {
      return 'approved';
    }
    if (
      /^(reject|rejected|retry|retry requested|fail|failed|incomplete|needs clarification|not complete|not ready|insufficient evidence)\b/i.test(
        value
      )
    ) {
      return 'rejected';
    }
    return null;
  }

  private parseReviewReason(reviewOutput: string): string | undefined {
    const reasonPattern = /REVIEW_REASON:\s*(.+)/gi;
    const reasonMatches = [...reviewOutput.matchAll(reasonPattern)];
    const outputLikelyContainsEchoedPrompt =
      reviewOutput.includes('Return exactly') || reviewOutput.includes('REVIEW_DECISION: APPROVE or REJECT');
    const reasonMatch =
      outputLikelyContainsEchoedPrompt && reasonMatches.length > 1
        ? reasonMatches[reasonMatches.length - 1]
        : reasonMatches[0];
    const reason = reasonMatch?.[1]?.trim();
    return reason && reason !== '<one sentence>' ? reason : undefined;
  }

  private judgeReviewDecisionFromEvidence(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const sanitized = this.stripEchoedPromptLines(reviewOutput, [
      /^Return exactly:?$/i,
      /^REVIEW_DECISION:\s*APPROVE\s+or\s+REJECT$/i,
      /^REVIEW_REASON:\s*<one sentence>$/i,
    ]);
    if (!sanitized) {
      return null;
    }

    const hasPositiveEvidence =
      /\b(approved?|complete(?:d)?|verified|looks good|looks fine|safe handoff|pass(?:ed)?)\b/i.test(
        sanitized
      );
    const hasNegativeEvidence =
      /\b(reject(?:ed)?|retry|fail(?:ed)?|incomplete|missing checks|insufficient evidence|not safe)\b/i.test(
        sanitized
      );

    if (hasNegativeEvidence) {
      return {
        decision: 'rejected',
        reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
      };
    }
    if (!hasPositiveEvidence) {
      return null;
    }

    return {
      decision: 'approved',
      reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
    };
  }

  private combineStepAndReviewOutput(stepOutput: string, reviewOutput: string): string {
    const primary = stepOutput.trimEnd();
    const review = reviewOutput.trim();
    if (!review) return primary;
    if (!primary) return `REVIEW_OUTPUT\n${review}\n`;
    return `${primary}\n\n---\nREVIEW_OUTPUT\n${review}\n`;
  }

  /**
   * Build the CLI command and arguments for a non-interactive agent execution.
   * Delegates to the consolidated CLI registry for per-CLI arg formats.
   */
  static buildNonInteractiveCommand(
    cli: AgentCli,
    task: string,
    extraArgs: string[] = []
  ): { cmd: string; args: string[] } {
    const [cmd, ...args] = buildProcessCommand(cli, extraArgs, task);
    return {
      cmd,
      args,
    };
  }

  /**
   * Apply preset defaults to an agent definition.
   * Explicit fields on the definition always win over preset-inferred defaults.
   */
  private static resolveAgentDef(def: AgentDefinition): AgentDefinition {
    // Resolve "cursor" alias to whichever cursor agent binary is in PATH
    const resolvedCli: AgentCli = def.cli === 'cursor' ? resolveCursorCli() : def.cli;

    if (!def.preset) return resolvedCli !== def.cli ? { ...def, cli: resolvedCli } : def;
    const nonInteractivePresets: AgentPreset[] = ['worker', 'reviewer', 'analyst'];
    const defaults: Partial<AgentDefinition> = nonInteractivePresets.includes(def.preset)
      ? { interactive: false }
      : {};
    // Explicit fields on the def always win
    return { ...defaults, ...def, cli: resolvedCli } as AgentDefinition;
  }

  /**
   * Returns a preset-specific prefix that is prepended to the non-interactive
   * enforcement block in execNonInteractive.
   */
  /**
   * Returns a prefix injected into the task prompt for non-interactive agents.
   * Lead agents are always interactive (PTY), so they never reach execNonInteractive
   * and there is no 'lead' case here.
   */
  private buildPresetInjection(preset: AgentPreset | undefined): string {
    switch (preset) {
      case 'worker':
        return (
          'You are a non-interactive worker agent. Produce clean, structured output to stdout.\n' +
          'Do NOT use mcp__relaycast__agent_add, add_agent, or any MCP tool to spawn sub-agents.\n' +
          'Do NOT use mcp__relaycast__message_dm_send or any Relaycast messaging tools — you have no relay connection.\n\n'
        );
      case 'reviewer':
        return (
          'You are a non-interactive reviewer agent. Read the specified files/artifacts and produce a clear verdict.\n' +
          'Do NOT spawn sub-agents or use any Relaycast messaging tools.\n\n'
        );
      case 'analyst':
        return (
          'You are a non-interactive analyst agent. Read the specified code/files and write your findings.\n' +
          'Do NOT spawn sub-agents or use any Relaycast messaging tools.\n\n'
        );
      default:
        return '';
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
  ): Promise<SpawnResult> {
    const agentName = `${step.name}-${this.generateShortId()}`;
    const modelArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : [];

    // Append strict deliverable enforcement — non-interactive agents MUST produce
    // clear, structured output since there's no opportunity for follow-up or clarification.
    const presetPrefix = this.buildPresetInjection(agentDef.preset);
    const taskWithDeliverable =
      presetPrefix +
      step.task +
      '\n\n---\n' +
      'IMPORTANT: You are running as a non-interactive subprocess. ' +
      'Do NOT call mcp__relaycast__agent_add, add_agent, or any MCP tool to spawn or manage other agents.\n\n' +
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
    if (this.relayApiKey) {
      const agentClient = await this.registerRelaycastExternalAgent(
        agentName,
        `Non-interactive workflow agent for step "${step.name}" (${agentDef.cli})`
      ).catch((err) => {
        console.warn(`[WorkflowRunner] Failed to register ${agentName} in Relaycast:`, err?.message ?? err);
        return null;
      });
      if (agentClient) {
        stopHeartbeat = this.startRelaycastHeartbeat(agentClient);
      }
    }

    // Post assignment notification (no task content — task arrives via direct broker injection)
    this.postToChannel(`**[${step.name}]** Assigned to \`${agentName}\` (non-interactive)`);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    try {
      const { stdout: output, exitCode, exitSignal } = await new Promise<{ stdout: string; exitCode?: number; exitSignal?: string }>((resolve, reject) => {
        const child = spawnProcess([cmd, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: this.resolveEffectiveCwd(step, agentDef),
          env: this.getRelayEnv() ?? { ...process.env },
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

        // Heartbeat so a slow non-interactive agent doesn't look frozen.
        // Each tick shows the last substantive line received — gives insight
        // without flooding the log with raw model output.
        const startedAt = Date.now();
        let lastHeartbeatLine = '';
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const suffix = lastHeartbeatLine ? ` — ${lastHeartbeatLine.slice(0, 80)}` : '';
          this.log(`[${step.name}] still running (${elapsed}s)${suffix}`);
          lastHeartbeatLine = '';
        }, 30_000);

        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stdoutChunks.push(text);
          logStream.write(text);
          // Track last substantive line for the next heartbeat
          const line =
            text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .at(-1) ?? '';
          if (line) lastHeartbeatLine = line;
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

        child.on('close', (code, signal) => {
          clearInterval(heartbeat);
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
            reject(new Error(`Step "${step.name}" timed out after ${timeoutMs ?? 'unknown'}ms`));
            return;
          }

          const cliDef = getCliDefinition(agentDef.cli);
          if (code !== 0 && code !== null && !cliDef?.ignoreExitCode) {
            const stderr = stderrChunks.join('');
            reject(
              new SpawnExitError(
                `Step "${step.name}" exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
                code,
                signal
              )
            );
            return;
          }

          resolve({
            stdout,
            exitCode: code ?? undefined,
            exitSignal: signal ?? undefined,
          });
        });

        child.on('error', (err) => {
          clearInterval(heartbeat);
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
        });
      });

      this.captureStepTerminalEvidence(step.name, {}, { exitCode, exitSignal });
      return { output, exitCode, exitSignal };
    } finally {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      const combinedOutput = stdout + stderr;
      this.lastFailedStepOutput.set(step.name, combinedOutput);
      this.captureStepTerminalEvidence(
        step.name,
        {
          stdout,
          stderr,
          combined: combinedOutput,
        }
      );
      stopHeartbeat?.();
      logStream.end();
      this.unregisterWorker(agentName);
    }
  }

  private async spawnAndWait(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number,
    options: SpawnAndWaitOptions = {}
  ): Promise<SpawnResult> {
    // Branch: non-interactive agents run as simple subprocesses
    if (agentDef.interactive === false) {
      return this.execNonInteractive(agentDef, step, timeoutMs);
    }

    if (!this.relay) {
      throw new Error('AgentRelay not initialized');
    }

    const evidenceStepName = options.evidenceStepName ?? step.name;

    // Deterministic name: step name + optional role suffix + first 8 chars of run ID.
    const requestedName = `${step.name}${options.agentNameSuffix ? `-${options.agentNameSuffix}` : ''}-${(this.currentRunId ?? this.generateShortId()).slice(0, 8)}`;
    let agentName = requestedName;

    // Only inject delegation guidance for lead/coordinator agents, not spokes/workers.
    // In non-hub patterns (pipeline, dag, etc.) every agent is autonomous so they all get it.
    const role = agentDef.role?.toLowerCase() ?? '';
    const nameLC = agentDef.name.toLowerCase();
    const isHub =
      WorkflowRunner.HUB_ROLES.has(nameLC) ||
      [...WorkflowRunner.HUB_ROLES].some((r) => new RegExp(`\\b${r}\\b`).test(role));
    const pattern = this.currentConfig?.swarm.pattern;
    const isHubPattern = pattern && WorkflowRunner.HUB_PATTERNS.has(pattern);
    const delegationGuidance =
      isHub || !isHubPattern ? this.buildDelegationGuidance(agentDef.cli, timeoutMs) : '';

    // Non-claude CLIs (codex, gemini, etc.) don't auto-register with Relaycast
    // via the MCP system prompt the way claude does. Inject an explicit preamble
    // so they call register() before any other relay tool.
    const relayRegistrationNote = this.buildRelayRegistrationNote(agentDef.cli, agentName);

    const taskWithExit =
      step.task +
      (relayRegistrationNote ? '\n\n' + relayRegistrationNote : '') +
      (delegationGuidance ? '\n\n' + delegationGuidance + '\n' : '') +
      '\n\n---\n' +
      'IMPORTANT: When you have fully completed this task, you MUST self-terminate by either: ' +
      '(a) calling remove_agent(name: "<your-agent-name>", reason: "task completed") — preferred, or ' +
      '(b) outputting the exact text "/exit" on its own line as a fallback. ' +
      'Do not wait for further input — terminate immediately after finishing. ' +
      'Do NOT spawn sub-agents unless the task explicitly requires it.';
    const preparedTask = this.prepareInteractiveSpawnTask(agentName, taskWithExit);

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
      options.onChunk?.({ agentName, chunk });
    });

    const agentChannels = this.channel ? [this.channel] : agentDef.channels;

    let agent: Awaited<ReturnType<typeof this.relay.spawnPty>> | undefined;
    let exitResult: string = 'unknown';
    let stopHeartbeat: (() => void) | undefined;
    let ptyChunks: string[] = [];

    try {
      const agentCwd = this.resolveAgentCwd(agentDef);
      const interactiveSpawnPolicy = resolveSpawnPolicy({
        AGENT_NAME: agentName,
        AGENT_CLI: agentDef.cli,
        RELAY_API_KEY: this.relayApiKey ?? 'workflow-runner',
        AGENT_CHANNELS: (agentChannels ?? []).join(','),
      });
      agent = await this.relay.spawnPty({
        name: agentName,
        cli: agentDef.cli,
        model: agentDef.constraints?.model,
        args: interactiveSpawnPolicy.args,
        channels: agentChannels,
        task: preparedTask.spawnTaskText,
        idleThresholdSecs: agentDef.constraints?.idleThresholdSecs,
        cwd: agentCwd,
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
          const resolvedAgentName = agent.name;
          this.ptyListeners.set(resolvedAgentName, (chunk: string) => {
            const stripped = WorkflowRunner.stripAnsi(chunk);
            this.ptyOutputBuffers.get(resolvedAgentName)?.push(stripped);
            newLogStream.write(chunk);
            options.onChunk?.({ agentName: resolvedAgentName, chunk });
          });
        }

        agentName = agent.name;
      }

      const liveAgent = agent;
      await options.onSpawned?.({ requestedName, actualName: liveAgent.name, agent: liveAgent });
      this.runtimeStepAgents.set(liveAgent.name, {
        stepName: evidenceStepName,
        role: options.evidenceRole ?? agentDef.role ?? 'agent',
        logicalName: options.logicalName ?? agentDef.name,
      });
      const signalParticipant = this.resolveSignalParticipantKind(
        options.evidenceRole ?? agentDef.role ?? 'agent'
      );
      if (signalParticipant) {
        this.rememberStepSignalSender(
          evidenceStepName,
          signalParticipant,
          liveAgent.name,
          options.logicalName ?? agentDef.name
        );
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
      if (this.relayApiKey) {
        const agentClient = await this.registerRelaycastExternalAgent(
          liveAgent.name,
          `Workflow agent for step "${step.name}" (${agentDef.cli})`
        ).catch((err) => {
          console.warn(
            `[WorkflowRunner] Failed to register ${liveAgent.name} in Relaycast:`,
            err?.message ?? err
          );
          return null;
        });

        // Keep the agent online in the dashboard while it's working
        if (agentClient) {
          stopHeartbeat = this.startRelaycastHeartbeat(agentClient);
        }
      }

      // Invite the spawned agent to the workflow channel
      if (this.channel && this.relayApiKey) {
        const channelAgent = await this.ensureRelaycastRunnerAgent().catch(() => null);
        await channelAgent?.channels.invite(this.channel, agent.name).catch(() => {});
      }

      // Keep operational assignment chatter out of the agent coordination channel.
      this.log(`[${step.name}] Assigned to ${agent.name}`);

      // Register agent handle for hub-mediated nudging
      this.activeAgentHandles.set(agentName, agent);

      // Wait for agent to exit, with idle nudging if configured
      exitResult = await this.waitForExitWithIdleNudging(
        agent,
        agentDef,
        step,
        timeoutMs,
        preparedTask.promptTaskText,
        options.preserveOnIdle ?? this.shouldPreserveIdleSupervisor(agentDef, step, options.evidenceRole)
      );

      // Stop heartbeat now that agent has exited
      stopHeartbeat?.();

      if (exitResult === 'timeout') {
        // Grace-period fallback: before failing, check if the agent completed
        // its work but just failed to self-terminate. Run verification if
        // configured — a passing gate + timeout is better than a hard failure.
        let timeoutRecovered = false;
        if (step.verification) {
          const ptyOutput = (this.ptyOutputBuffers.get(agentName) ?? []).join('');
          const verificationResult = this.runVerification(
            step.verification,
            ptyOutput,
            step.name,
            preparedTask.promptTaskText,
            { allowFailure: true }
          );
          if (verificationResult.passed) {
            this.log(
              `[${step.name}] Agent timed out but verification passed — treating as complete`
            );
            this.postToChannel(
              `**[${step.name}]** Agent idle after completing work — verification passed, releasing`
            );
            await agent.release().catch(() => undefined);
            timeoutRecovered = true;
          }
        }
        if (!timeoutRecovered) {
          await agent.release().catch(() => undefined);
          throw new Error(`Step "${step.name}" timed out after ${timeoutMs ?? 'unknown'}ms`);
        }
      }

      if (exitResult === 'force-released') {
        throw new Error(
          `Step "${step.name}" failed — agent was force-released after exhausting idle nudges without completing`
        );
      }
    } finally {
      // Snapshot PTY chunks before cleanup — we need them for output reading below
      ptyChunks = this.ptyOutputBuffers.get(agentName) ?? [];
      this.lastFailedStepOutput.set(step.name, ptyChunks.join(''));
      if (ptyChunks.length > 0 || agent?.exitCode !== undefined || agent?.exitSignal !== undefined) {
        this.captureStepTerminalEvidence(
          evidenceStepName,
          {
            stdout: ptyChunks.length > 0 ? ptyChunks.join('') : undefined,
            combined: ptyChunks.length > 0 ? ptyChunks.join('') : undefined,
          },
          {
            exitCode: agent?.exitCode,
            exitSignal: agent?.exitSignal,
          },
          {
            sender: options.logicalName ?? agentDef.name,
            actor: agent?.name ?? agentName,
            role: options.evidenceRole ?? agentDef.role ?? 'agent',
          }
        );
      }

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
      this.supervisedRuntimeAgents.delete(agentName);
      this.runtimeStepAgents.delete(agentName);
      if (preparedTask.taskTmpFile) {
        await unlink(preparedTask.taskTmpFile).catch(() => undefined);
      }
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
            ? 'Agent completed (idle — treated as done)'
            : `Agent exited (${exitResult})`;
    }

    if (ptyChunks.length === 0) {
      this.captureStepTerminalEvidence(
        evidenceStepName,
        { stdout: output, combined: output },
        { exitCode: agent?.exitCode, exitSignal: agent?.exitSignal },
        {
          sender: options.logicalName ?? agentDef.name,
          actor: agent?.name ?? agentName,
          role: options.evidenceRole ?? agentDef.role ?? 'agent',
        }
      );
    }

    return {
      output,
      exitCode: agent?.exitCode,
      exitSignal: agent?.exitSignal,
      promptTaskText: preparedTask.promptTaskText,
    };
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

  private isLeadLikeAgent(agentDef: AgentDefinition, roleOverride?: string): boolean {
    if (agentDef.preset === 'lead') return true;

    const role = (roleOverride ?? agentDef.role ?? '').toLowerCase();
    const nameLC = agentDef.name.toLowerCase();
    return [...WorkflowRunner.HUB_ROLES].some(
      (hubRole) =>
        new RegExp(`\\b${hubRole}\\b`, 'i').test(nameLC) ||
        new RegExp(`\\b${hubRole}\\b`, 'i').test(role)
    );
  }

  private shouldPreserveIdleSupervisor(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    evidenceRole?: string
  ): boolean {
    if (evidenceRole && /\bowner\b/i.test(evidenceRole)) {
      return true;
    }

    if (!this.isLeadLikeAgent(agentDef, evidenceRole)) {
      return false;
    }

    const task = step.task ?? '';
    return /\b(wait|waiting|monitor|supervis|check inbox|check.*channel|poll|DONE|_DONE|signal|handoff)\b/i.test(
      task
    );
  }

  /**
   * Wait for agent exit with idle detection and nudging.
   * If no idle nudge config is set, falls through to simple waitForExit.
   */
  private async waitForExitWithIdleNudging(
    agent: Agent,
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number,
    promptTaskText?: string,
    preserveIdleSupervisor = false
  ): Promise<'exited' | 'timeout' | 'released' | 'force-released'> {
    const nudgeConfig = this.currentConfig?.swarm.idleNudge;
    if (!nudgeConfig) {
      if (preserveIdleSupervisor) {
        this.log(
          `[${step.name}] Supervising agent "${agent.name}" may idle while waiting — using exit-only completion`
        );
        return agent.waitForExit(timeoutMs);
      }

      // Idle = done: race exit against idle, but only accept idle if verification passes.
      const idleLoopStart = Date.now();
      while (true) {
        const elapsed = Date.now() - idleLoopStart;
        const remaining = timeoutMs != null ? Math.max(0, timeoutMs - elapsed) : undefined;
        if (remaining != null && remaining <= 0) {
          return 'timeout';
        }
        const result = await Promise.race([
          agent.waitForExit(remaining).then((r) => ({ kind: 'exit' as const, result: r })),
          agent.waitForIdle(remaining).then((r) => ({ kind: 'idle' as const, result: r })),
        ]);
        if (result.kind === 'idle' && result.result === 'idle') {
          // Check verification before treating idle as complete.
          if (step.verification && step.verification.type === 'output_contains') {
            const token = step.verification.value;
            const ptyOutput = (this.ptyOutputBuffers.get(agent.name) ?? []).join('');
            const verificationPassed = this.outputContainsVerificationToken(
              ptyOutput,
              token,
              promptTaskText
            );
            if (!verificationPassed) {
              // The broker fires agent_idle only once per idle transition.
              // If the agent is still working (will produce output then idle again),
              // continuing the loop works. But if the agent is permanently idle,
              // waitForIdle won't resolve again. Wait briefly for new output,
              // then release and let upstream verification handle the result.
              this.log(`[${step.name}] Agent "${agent.name}" went idle but verification not yet passed — waiting for more output`);
              const idleGraceSecs = 15;
              const graceResult = await Promise.race([
                agent.waitForExit(idleGraceSecs * 1000).then((r) => ({ kind: 'exit' as const, result: r })),
                agent.waitForIdle(idleGraceSecs * 1000).then((r) => ({ kind: 'idle' as const, result: r })),
              ]);
              if (graceResult.kind === 'idle' && graceResult.result === 'idle') {
                // Agent went idle again after producing output — re-check verification
                continue;
              }
              if (graceResult.kind === 'exit') {
                return graceResult.result as 'exited' | 'timeout' | 'released';
              }
              // Grace period timed out — agent is permanently idle without verification.
              // Release and let upstream executeAgentStep handle verification.
              this.log(`[${step.name}] Agent "${agent.name}" still idle after ${idleGraceSecs}s grace — releasing`);
              this.postToChannel(`**[${step.name}]** Agent \`${agent.name}\` idle — releasing (verification pending)`);
              await agent.release().catch(() => undefined);
              return 'released';
            }
          }
          this.log(`[${step.name}] Agent "${agent.name}" went idle — treating as complete`);
          this.postToChannel(`**[${step.name}]** Agent \`${agent.name}\` idle — treating as complete`);
          await agent.release().catch(() => undefined);
          return 'released';
        }
        // Exit won the race, or idle returned 'exited'/'timeout' — pass through.
        return result.result as 'exited' | 'timeout' | 'released';
      }
    }

    const nudgeAfterMs = nudgeConfig.nudgeAfterMs ?? 120_000;
    const escalateAfterMs = nudgeConfig.escalateAfterMs ?? 120_000;
    const maxNudges = nudgeConfig.maxNudges ?? 1;

    let nudgeCount = 0;
    let preservedSupervisorNoticeSent = false;
    const startTime = Date.now();

    while (true) {
      // Calculate remaining time from overall timeout
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs ? timeoutMs - elapsed : undefined;
      if (remaining !== undefined && remaining <= 0) {
        return 'timeout';
      }

      // nudgeAfterMs = how long to wait before nudging (first interval).
      // escalateAfterMs = how long to wait between subsequent nudges.
      //
      // We wait for exit, not for idle. The broker's idle_threshold_secs is
      // only 30s by default, so racing waitForExit vs waitForIdle would nudge
      // after 30s of PTY silence regardless of nudgeAfterMs. Instead, we give
      // the agent the full nudgeAfterMs window to finish before nudging.
      const windowMs = nudgeCount === 0 ? nudgeAfterMs : escalateAfterMs;
      const waitMs = remaining !== undefined ? Math.min(windowMs, remaining) : windowMs;

      const exitResult = await agent.waitForExit(waitMs);

      if (exitResult !== 'timeout') {
        // Agent actually exited or was released — done
        return exitResult;
      }

      // Agent is still running after the window expired.
      if (timeoutMs !== undefined && Date.now() - startTime >= timeoutMs) {
        return 'timeout';
      }

      // Nudge if we haven't exhausted the limit
      if (nudgeCount < maxNudges) {
        await this.nudgeIdleAgent(agent, agentDef, step);
        nudgeCount++;
        this.postToChannel(`**[${step.name}]** Agent \`${agent.name}\` idle — nudge #${nudgeCount} sent`);
        this.emit({ type: 'step:nudged', runId: this.currentRunId ?? '', stepName: step.name, nudgeCount });
        continue;
      }

      if (preserveIdleSupervisor) {
        if (!preservedSupervisorNoticeSent) {
          this.log(
            `[${step.name}] Supervising agent "${agent.name}" stayed idle after ${nudgeCount} nudge(s) — preserving until exit or timeout`
          );
          this.postToChannel(
            `**[${step.name}]** Supervising agent \`${agent.name}\` is waiting on handoff — keeping it alive until it exits or the step times out`
          );
          preservedSupervisorNoticeSent = true;
        }
        continue;
      }

      // Exhausted nudges — force-release
      this.postToChannel(
        `**[${step.name}]** Agent \`${agent.name}\` still idle after ${nudgeCount} nudge(s) — force-releasing`
      );
      this.emit({ type: 'step:force-released', runId: this.currentRunId ?? '', stepName: step.name });
      await agent.release().catch(() => undefined);
      return 'force-released';
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
        [...WorkflowRunner.HUB_ROLES].some((r) => new RegExp(`\\b${r}\\b`).test(role))
      ) {
        // Found a hub candidate — check if we have a live handle
        const handle = this.activeAgentHandles.get(agentDef.name);
        if (handle) return handle;
      }
    }

    return undefined;
  }

  // ── Verification ────────────────────────────────────────────────────────

  private runVerification(
    check: VerificationCheck,
    output: string,
    stepName: string,
    injectedTaskText?: string,
    options?: VerificationOptions
  ): VerificationResult {
    return runVerification(
      check,
      output,
      stepName,
      injectedTaskText,
      { ...options, cwd: this.cwd },
      {
        recordStepToolSideEffect: (name, effect) => this.recordStepToolSideEffect(name, effect),
        getOrCreateStepEvidenceRecord: (name) => this.getOrCreateStepEvidenceRecord(name),
        log: (message) => this.log(message),
      }
    );
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

  private async markStepFailed(
    state: StepState,
    error: string,
    runId: string,
    exitInfo?: { exitCode?: number; exitSignal?: string },
    completionReason?: WorkflowStepCompletionReason
  ): Promise<void> {
    this.captureStepTerminalEvidence(state.row.stepName, {}, exitInfo);
    state.row.status = 'failed';
    state.row.error = error;
    state.row.completionReason = completionReason;
    state.row.completedAt = new Date().toISOString();
    await this.db.updateStep(state.row.id, {
      status: 'failed',
      error,
      completionReason,
      completedAt: state.row.completedAt,
      updatedAt: new Date().toISOString(),
    });
    this.emit({
      type: 'step:failed',
      runId,
      stepName: state.row.stepName,
      error,
      exitCode: exitInfo?.exitCode,
      exitSignal: exitInfo?.exitSignal,
    });
    this.finalizeStepEvidence(state.row.stepName, 'failed', state.row.completedAt, completionReason);
  }

  private async captureAgentReport(
    runId: string,
    stepName: string,
    agentDef: AgentDefinition | undefined,
    cwd: string | undefined,
    startedAt: number | undefined,
    completedAt: number
  ): Promise<void> {
    if (!agentDef || !cwd || !startedAt) return;

    try {
      const report = await collectCliSession({
        cli: agentDef.cli,
        cwd,
        startedAt,
        completedAt,
      });
      if (!report) return;

      this.agentReports.set(stepName, report);
      this.emit({ type: 'step:agent-report', runId, stepName, report });
      await this.persistAgentReport(runId, stepName, report);
    } catch (error) {
      this.log(
        `[${stepName}] CLI session collection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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

  // ── startFrom dependency resolution ─────────────────────────────────

  /**
   * Walk the dependsOn graph backwards from a target step to collect ALL
   * transitive dependencies (i.e. every step that must complete before
   * the target step can run). The target step itself is NOT included.
   */
  private collectTransitiveDeps(targetStep: string, steps: WorkflowStep[]): Set<string> {
    const stepMap = new Map<string, WorkflowStep>();
    for (const s of steps) stepMap.set(s.name, s);

    const deps = new Set<string>();
    const queue = [...(stepMap.get(targetStep)?.dependsOn ?? [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (deps.has(current)) continue;
      deps.add(current);
      const step = stepMap.get(current);
      if (step?.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!deps.has(dep)) queue.push(dep);
        }
      }
    }

    return deps;
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
    return this.channelMessenger.buildNonInteractiveAwareness(agentMap, stepStates);
  }

  /**
   * Build guidance that encourages agents to autonomously delegate subtasks
   * to helper agents when work is too complex for a single pass.
   */
  /**
   * Returns a relay registration preamble for CLIs that don't auto-call
   * `register` via the MCP system prompt (everyone except claude).
   *
   * Claude reads the Relaycast system prompt and registers on its own.
   * Codex, gemini, etc. have the MCP server configured with the workspace
   * key, but they won't call `register` unless explicitly told to.
   */
  private buildRelayRegistrationNote(cli: string, agentName: string): string {
    return this.channelMessenger.buildRelayRegistrationNote(cli, agentName);
  }

  private buildDelegationGuidance(cli: string, timeoutMs?: number): string {
    return this.channelMessenger.buildDelegationGuidance(cli, timeoutMs);
  }

  /** Post a message to the workflow channel. Fire-and-forget — never throws or blocks. */
  private postToChannel(text: string, options: ChannelEvidenceOptions = {}): void {
    if (!this.relayApiKey || !this.channel) return;
    this.recordChannelEvidence(text, options);

    const stepName = options.stepName ?? this.inferStepNameFromChannelText(text);
    if (stepName) {
      this.recordStepToolSideEffect(stepName, {
        type: 'post_channel_message',
        detail: text.slice(0, 240),
        raw: {
          actor: options.actor,
          role: options.role,
          target: options.target ?? this.channel,
          origin: options.origin ?? 'runner_post',
        },
      });
    }

    this.ensureRelaycastRunnerAgent()
      .then((agent) => agent.send(this.channel!, text))
      .catch(() => {
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
    this.channelMessenger.postCompletionReport(workflowName, outcomes, summary, confidence);
  }

  /** Post a failure report to the channel. */
  private postFailureReport(workflowName: string, outcomes: StepOutcome[], errorMsg: string): void {
    this.channelMessenger.postFailureReport(workflowName, outcomes, errorMsg);
  }

  /**
   * Log a human-readable run summary to the console after completion or failure.
   * Extracts the last meaningful lines from each step's raw PTY output.
   */
  private logRunSummary(workflowName: string, outcomes: StepOutcome[], runId: string): void {
    const completed = outcomes.filter((o) => o.status === 'completed');
    const failed = outcomes.filter((o) => o.status === 'failed');
    const skipped = outcomes.filter((o) => o.status === 'skipped');

    console.log('');
    console.log(chalk.dim('━'.repeat(70)));
    console.log(`  Workflow "${workflowName}" — ${failed.length === 0 ? chalk.green('COMPLETED') : chalk.red('FAILED')}`);
    console.log(
      `  ${chalk.green(`${completed.length} passed`)}, ${chalk.red(`${failed.length} failed`)}, ${chalk.dim(`${skipped.length} skipped`)}`
    );
    console.log(chalk.dim('━'.repeat(70)));

    // Always show the summary table — with agent reports when available,
    // with just step/status/duration when not (non-interactive agents).
    console.log(formatRunSummaryTable(outcomes, this.agentReports));

    // Show errors and output excerpts for failed steps below the table
    for (const outcome of outcomes) {
      if (outcome.status !== 'failed') continue;

      if (outcome.error) {
        console.log(chalk.red(`  ${outcome.name}: ${outcome.error}`));
      }

      if (outcome.output) {
        const excerpt = this.extractOutputExcerpt(outcome.output);
        if (excerpt) {
          for (const line of excerpt.split('\n')) {
            console.log(`    ${line}`);
          }
        }
      }
    }

    // Point to detailed output files
    const outputDir = this.getStepOutputDir(runId);
    const logsDir = path.join(this.cwd, '.agent-relay', 'team', 'worker-logs');
    console.log('');
    console.log(`  Run ID:      ${runId}`);
    console.log(`  Step output: ${outputDir}`);
    console.log(`  Agent logs:  ${logsDir}`);
    console.log(chalk.dim('━'.repeat(70)));
    console.log('');
  }

  /**
   * Extract a useful excerpt from raw PTY output.
   * Looks for the agent's final text output (ignoring ANSI, system prompts, tool calls).
   */
  private extractOutputExcerpt(rawOutput: string): string {
    const stripped = WorkflowRunner.stripAnsi(rawOutput);

    // Split into lines, filter out noise
    const lines = stripped.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Skip system/UI chrome
      if (trimmed.startsWith('╭') || trimmed.startsWith('╰') || trimmed.startsWith('│')) return false;
      if (trimmed.startsWith('─')) return false;
      if (trimmed.startsWith('❯') || trimmed.startsWith('⏵')) return false;
      if (trimmed.startsWith('<system-reminder>') || trimmed.startsWith('</system-reminder>')) return false;
      if (/^\[?workflow\s/.test(trimmed)) return false;
      // Skip tool invocations
      if (/^(Read|Edit|Bash|Glob|Grep|Task|Explore|Write)\(/.test(trimmed)) return false;
      // Skip thinking indicators
      if (/^[·✳✻✽⏺]?\s*Sublimating/.test(trimmed)) return false;
      // Skip very short lines (likely UI fragments)
      if (trimmed.length < 10) return false;
      return true;
    });

    if (lines.length === 0) return '';

    // Take the last few meaningful lines (agent's final words)
    const tail = lines.slice(-5);
    const excerpt = tail.map((l) => l.trim().slice(0, 120)).join('\n');
    return excerpt.length > 0 ? `...\n${excerpt}` : '';
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
      const startedAtMs = state.row.startedAt ? Date.parse(state.row.startedAt) : Number.NaN;
      const completedAtMs = state.row.completedAt ? Date.parse(state.row.completedAt) : Number.NaN;
      const durationMs =
        Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
          ? Math.max(0, completedAtMs - startedAtMs)
          : undefined;
      outcomes.push({
        name,
        agent: state.row.agentName ?? 'deterministic',
        status:
          state.row.status === 'completed'
            ? 'completed'
            : state.row.status === 'skipped'
              ? 'skipped'
              : 'failed',
        attempts: state.row.retryCount + 1,
        output: state.row.output,
        error: state.row.error,
        verificationPassed: state.row.status === 'completed' && stepsWithVerification.has(name),
        durationMs,
        completionMode: state.row.completionReason
          ? this.buildStepCompletionDecision(name, state.row.completionReason)?.mode
          : undefined,
      });
    }
    return outcomes;
  }

  // ── ID generation ─────────────────────────────────────────────────────

  private persistRunIdHint(runId: string): void {
    const target = process.env.AGENT_RELAY_RUN_ID_FILE?.trim();
    if (!target) return;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, runId + '\n', 'utf8');
    } catch {
      // Ignore hint persistence failures.
    }
  }

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

  /**
   * Strip TUI chrome from PTY-captured output before posting to a channel.
   * Removes: ANSI codes, unicode spinner/thinking characters, cursor-movement
   * artifacts, and collapses runs of blank lines to a single blank line.
   * The raw (ANSI-stripped) output is still written to disk for step chaining.
   */
  private static scrubForChannel(text: string): string {
    // Strip system-reminder blocks (closed or unclosed)
    const withoutSystemReminders = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '')
      .replace(/<system-reminder>[\s\S]*/giu, '');

    // Normalize CRLF and bare \r before stripping ANSI — PTY output often
    // contains \r\r\n which leaves stray \r after stripping that confuse line splitting.
    const normalized = withoutSystemReminders.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const ansiStripped = stripAnsiFn(normalized);

    // Unicode spinner / ornament characters used by Claude TUI animations.
    // Includes block-element chars (▗▖▘▝) used in the Claude Code header bar.
    const SPINNER =
      '\\u2756\\u2738\\u2739\\u273a\\u273b\\u273c\\u273d\\u2731\\u2732\\u2733\\u2734\\u2735\\u2736\\u2737\\u2743\\u2745\\u2746\\u25d6\\u25d7\\u25d8\\u25d9\\u2022\\u25cf\\u25cb\\u25a0\\u25a1\\u25b6\\u25c0\\u23f5\\u23f6\\u23f7\\u23f8\\u23f9\\u25e2\\u25e3\\u25e4\\u25e5\\u2597\\u2596\\u2598\\u259d\\u2bc8\\u2bc7\\u2bc5\\u2bc6\\u00b7' +
      '\\u2590\\u258c\\u2588\\u2584\\u2580\\u259a\\u259e' + // additional block elements
      '\\u2b21\\u2b22'; // hex-hollow ⬡ and hex-filled ⬢ (Cursor "Generating" spinner)
    const spinnerRe = new RegExp(`[${SPINNER}]`, 'gu');
    const spinnerClassRe = new RegExp(`^[\\s${SPINNER}]*$`, 'u');

    // Line-level filters
    const boxDrawingOnlyRe = /^[\s\u2500-\u257f\u2580-\u259f\u25a0-\u25ff\-_=~]{3,}$/u;
    // Broker internal log lines: "2026-02-26T12:45:12.123Z  INFO agent_relay_broker::..."
    const brokerLogRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+(?:INFO|WARN|ERROR|DEBUG)\s/u;
    const claudeHeaderRe =
      /^(?:[\s\u2580-\u259f✢*·▗▖▘▝]+\s*)?(?:Claude\s+Code(?:\s+v?[\d.]+)?|(?:Sonnet|Haiku|Opus)\s*[\d.]+|claude-(?:sonnet|haiku|opus)-[\w.-]+|Running\s+on\s+claude)/iu;
    // TUI directory breadcrumb lines (e.g. "  ~/Projects/agent-workforce/relay-...")
    const dirBreadcrumbRe = /^\s*~[\\/]/u;
    const uiHintRe =
      /\b(?:Press\s+up\s+to\s+edit|tab\s+to\s+queue|bypass\s+permissions|esc\s+to\s+interrupt)\b/iu;
    // Any spinner-prefixed word ending in … — catches all Claude thinking animations
    // regardless of the specific word used (Thinking, Cascading, Flibbertigibbeting, etc.)
    const thinkingLineRe = new RegExp(`^[\\s${SPINNER}]*\\s*\\w[\\w\\s]*\\u2026\\s*$`, 'u');
    const cursorOnlyRe = /^[\s❯⎿›»◀▶←→↑↓⟨⟩⟪⟫·]+$/u;
    // Cursor Agent TUI lines: generating animations, pasted text indicators, UI chrome
    const cursorAgentRe =
      /^(?:Cursor Agent|[\s⬡⬢]*Generating[.\s]|\[Pasted text|Auto-run all|Add a follow-up|ctrl\+c to stop|shift\+tab|Auto$|\/\s*commands|@\s*files|!\s*shell|follow-ups?\s|The user ha)/iu;
    const slashCommandRe = /^\/\w+\s*$/u;
    const mcpJsonKvRe =
      /^\s*"(?:type|method|params|result|id|jsonrpc|tool|name|arguments|content|role|metadata)"\s*:/u;
    const meaningfulContentRe = /[a-zA-Z0-9]/u;

    const countJsonDepth = (line: string): number => {
      let depth = 0;
      for (const ch of line) {
        if (ch === '{' || ch === '[') depth += 1;
        if (ch === '}' || ch === ']') depth -= 1;
      }
      return depth;
    };

    const lines = ansiStripped.split('\n');
    const meaningful: string[] = [];
    let jsonDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (jsonDepth > 0) {
        jsonDepth += countJsonDepth(line);
        if (jsonDepth <= 0) jsonDepth = 0;
        continue;
      }

      if (trimmed.length === 0) continue;

      if (trimmed.startsWith('{') || /^\[\s*\{/.test(trimmed)) {
        jsonDepth = Math.max(countJsonDepth(line), 0);
        continue;
      }

      if (mcpJsonKvRe.test(line)) continue;
      if (spinnerClassRe.test(trimmed)) continue;
      if (boxDrawingOnlyRe.test(trimmed)) continue;
      if (brokerLogRe.test(trimmed)) continue;
      if (claudeHeaderRe.test(trimmed)) continue;
      if (dirBreadcrumbRe.test(trimmed)) continue;
      if (uiHintRe.test(trimmed)) continue;
      if (thinkingLineRe.test(trimmed)) continue;
      if (cursorOnlyRe.test(trimmed)) continue;
      if (cursorAgentRe.test(trimmed)) continue;
      if (slashCommandRe.test(trimmed)) continue;
      if (!meaningfulContentRe.test(trimmed)) continue;

      // Drop TUI animation frame fragments: lines where stripping spinners and
      // whitespace leaves ≤ 3 alphanumeric characters (e.g. "F", "l  b", "i  g").
      const alphanum = trimmed.replace(spinnerRe, '').replace(/\s+/g, '');
      if (alphanum.replace(/[^a-zA-Z0-9]/g, '').length <= 3) continue;

      meaningful.push(line);
    }

    return meaningful
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Sanitize a workflow name into a valid channel name. */
  private sanitizeChannelName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32);
  }

  /** Validate that a runId is safe for use in file paths (no traversal). */
  private validateRunId(runId: string): void {
    if (/[/\\]|^\.\.?$/.test(runId) || runId.includes('..')) {
      throw new Error(`Invalid runId: "${runId}" contains path traversal characters`);
    }
  }

  /** Directory for persisted step outputs: .agent-relay/step-outputs/{runId}/ */
  private getStepOutputDir(runId: string): string {
    this.validateRunId(runId);
    return path.join(this.cwd, '.agent-relay', 'step-outputs', runId);
  }

  /** Persist step output to disk and post full output as a channel message. */
  private async persistStepOutput(runId: string, stepName: string, output: string): Promise<void> {
    // 1. Write to disk
    const outputPath = path.join(this.getStepOutputDir(runId), `${stepName}.md`);
    try {
      const dir = this.getStepOutputDir(runId);
      mkdirSync(dir, { recursive: true });
      const cleaned = WorkflowRunner.stripAnsi(output);
      await writeFile(outputPath, cleaned);
    } catch {
      // Non-critical
    }
    this.recordStepToolSideEffect(stepName, {
      type: 'persist_step_output',
      detail: `Persisted step output to ${this.normalizeEvidencePath(outputPath)}`,
      raw: { path: outputPath },
    });

    // 2. Post scrubbed output as a single channel message (most recent tail only)
    const scrubbed = WorkflowRunner.scrubForChannel(output);
    if (scrubbed.length === 0) {
      this.postToChannel(`**[${stepName}]** Step completed — output written to disk`, { stepName });
      return;
    }

    const maxMsg = 2000;
    const preview = scrubbed.length > maxMsg ? scrubbed.slice(-maxMsg) : scrubbed;
    this.postToChannel(`**[${stepName}] Output:**\n\`\`\`\n${preview}\n\`\`\``, { stepName });
  }

  private async persistAgentReport(runId: string, stepName: string, report: CliSessionReport): Promise<void> {
    const reportPath = path.join(this.getStepOutputDir(runId), `${stepName}.report.json`);
    try {
      mkdirSync(this.getStepOutputDir(runId), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    } catch {
      // Non-critical
    }
  }

  /** Scan .agent-relay/step-outputs/ for the most recent run directory containing the needed steps. */
  private findMostRecentRunWithSteps(stepNames: Set<string>): string | undefined {
    try {
      const baseDir = path.join(this.cwd, '.agent-relay', 'step-outputs');
      if (!existsSync(baseDir)) return undefined;

      const entries = readdirSync(baseDir);
      let best: { name: string; mtime: number } | undefined;

      for (const entry of entries) {
        const dirPath = path.join(baseDir, entry);
        try {
          const stat = statSync(dirPath);
          if (!stat.isDirectory()) continue;

          // Check if this directory has at least one of the needed step files
          const hasAny = [...stepNames].some(name =>
            existsSync(path.join(dirPath, `${name}.md`))
          );
          if (!hasAny) continue;

          if (!best || stat.mtimeMs > best.mtime) {
            best = { name: entry, mtime: stat.mtimeMs };
          }
        } catch {
          continue;
        }
      }

      return best?.name;
    } catch {
      return undefined;
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

  /** Match the best workflow from config given a set of cached step names. */
  private matchWorkflowFromCache(
    workflows: WorkflowDefinition[],
    cachedStepNames: Set<string>
  ): WorkflowDefinition | null {
    if (workflows.length === 1) return workflows[0];

    if (cachedStepNames.size === 0) {
      // No cached steps to disambiguate — ambiguous when multiple workflows exist
      this.log('[resume] Multiple workflows in config with empty cache — cannot disambiguate');
      return null;
    }

    // Score each workflow by how many cached steps match, excluding those with unknown steps
    const scored = workflows
      .map((candidate) => ({
        workflow: candidate,
        matchedSteps: candidate.steps.filter((step) => cachedStepNames.has(step.name)).length,
        unknownSteps: [...cachedStepNames].filter(
          (name) => !candidate.steps.some((step) => step.name === name)
        ).length,
      }))
      .filter((candidate) => candidate.unknownSteps === 0)
      .sort((a, b) => b.matchedSteps - a.matchedSteps);

    return scored[0]?.workflow ?? null;
  }

  private reconstructRunFromCache(
    runId: string,
    config?: RelayYamlConfig
  ): { run: WorkflowRunRow; stepStates: Map<string, StepState> } | null {
    const stepOutputDir = this.getStepOutputDir(runId);
    if (!existsSync(stepOutputDir)) return null;

    let resumeConfig = config ?? this.currentConfig;
    if (!resumeConfig) {
      // Attempt to load config from relay.yaml on disk (resume() may call before runWorkflowCore sets currentConfig)
      const yamlPath = path.join(this.cwd, 'relay.yaml');
      if (existsSync(yamlPath)) {
        try {
          const raw = readFileSync(yamlPath, 'utf-8');
          resumeConfig = this.parseYamlString(raw, yamlPath);
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(stepOutputDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const cachedStepNames = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name.slice(0, -3))
        .filter(Boolean)
    );
    const workflows = resumeConfig.workflows ?? [];
    if (workflows.length === 0) return null;

    // Empty cache directory is valid — all steps will be re-run
    const workflow = this.matchWorkflowFromCache(workflows, cachedStepNames);
    if (!workflow) return null;

    // Use actual file modification times from cached outputs instead of synthetic timestamps
    const stepMtimes = new Map<string, string>();
    let earliestMtime = Date.now();
    for (const stepName of cachedStepNames) {
      try {
        const mdPath = path.join(stepOutputDir, `${stepName}.md`);
        const reportPath = path.join(stepOutputDir, `${stepName}.report.json`);
        const mdStat = existsSync(mdPath) ? statSync(mdPath) : null;
        const reportStat = existsSync(reportPath) ? statSync(reportPath) : null;
        // Use the latest mtime between .md and .report.json
        const mtime = Math.max(mdStat?.mtimeMs ?? 0, reportStat?.mtimeMs ?? 0);
        if (mtime > 0) {
          stepMtimes.set(stepName, new Date(mtime).toISOString());
          if (mtime < earliestMtime) earliestMtime = mtime;
        }
      } catch {
        // Fall back to current time if stat fails
      }
    }
    const fallbackTime = new Date().toISOString();

    const completedSteps = new Set(workflow.steps.filter((step) => cachedStepNames.has(step.name)).map((step) => step.name));
    // Heuristic: mark the first eligible non-completed step as failed (the likely failure point)
    const failedStepName = workflow.steps.find(
      (step) => !completedSteps.has(step.name) && (step.dependsOn ?? []).every((dep) => completedSteps.has(dep))
    )?.name;

    const runStartedAt = new Date(earliestMtime).toISOString();
    const run: WorkflowRunRow = {
      id: runId,
      workspaceId: this.workspaceId,
      workflowName: workflow.name,
      pattern: resumeConfig.swarm.pattern,
      status: 'failed',
      config: resumeConfig,
      startedAt: runStartedAt,
      createdAt: runStartedAt,
      updatedAt: fallbackTime,
    };

    const stepStates = new Map<string, StepState>();
    for (const step of workflow.steps) {
      const isNonAgent = step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration';
      const cachedOutput = completedSteps.has(step.name) ? this.loadStepOutput(runId, step.name) : undefined;
      const status: WorkflowStepStatus =
        completedSteps.has(step.name) ? 'completed' : step.name === failedStepName ? 'failed' : 'pending';

      const stepRow: WorkflowStepRow = {
        id: this.generateId(),
        runId,
        stepName: step.name,
        agentName: isNonAgent ? null : (step.agent ?? null),
        stepType: isNonAgent ? (step.type as 'deterministic' | 'worktree' | 'integration') : 'agent',
        status,
        task:
          step.type === 'deterministic'
            ? (step.command ?? '')
            : step.type === 'worktree'
              ? (step.branch ?? '')
              : step.type === 'integration'
                ? (`${step.integration}.${step.action}`)
                : (step.task ?? ''),
        dependsOn: step.dependsOn ?? [],
        output: cachedOutput,
        error: status === 'failed' ? 'Recovered from cached step outputs' : undefined,
        completedAt: status === 'completed' ? (stepMtimes.get(step.name) ?? fallbackTime) : undefined,
        retryCount: 0,
        createdAt: stepMtimes.get(step.name) ?? fallbackTime,
        updatedAt: stepMtimes.get(step.name) ?? fallbackTime,
      };
      stepStates.set(step.name, { row: stepRow });
    }

    return { run, stepStates };
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
