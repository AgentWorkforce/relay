/** WorkflowTrajectory records canonical workflow trajectories via agent-trajectories. */
import { dirname, join } from 'node:path';
import {
  FileStorage,
  abandonTrajectory,
  addChapter as appendChapter,
  addEvent as appendEvent,
  completeTrajectory,
  createTrajectory,
  type EventSignificance,
  type Trajectory,
  type TrajectoryEventType,
} from 'agent-trajectories';
import type { StepCompletionDecision, TrajectoryConfig, WorkflowStep } from './types.js';

type WorkflowTrajectoryEventType =
  | TrajectoryEventType
  | 'review-completed'
  | 'completion-marker'
  | 'completion-evidence';

type WorkflowTrajectoryAgent = {
  name: string;
  role: string;
  joinedAt: string;
  leftAt?: string;
};

// agent-trajectories runtime accepts workflow metadata and open-ended roles,
// while some published declaration aliases are narrower.
type WorkflowTrajectoryData = Omit<Trajectory, 'agents'> & {
  agents: WorkflowTrajectoryAgent[];
  workflowId?: string;
};

interface StepParticipants {
  role?: string;
  owner?: string;
  specialist?: string;
  reviewer?: string;
}
export interface StepOutcome {
  name: string;
  agent: string;
  status: 'completed' | 'failed' | 'skipped';
  attempts: number;
  output?: string;
  error?: string;
  verificationPassed?: boolean;
  verificationValue?: string;
  nonInteractive?: boolean;
  durationMs?: number;
  completionMode?: StepCompletionDecision['mode'];
}

type FailureCause =
  | 'timeout'
  | 'verification_mismatch'
  | 'spawn_failed'
  | 'exit_nonzero'
  | 'aborted'
  | 'unknown';

function classifyFailure(error: string): FailureCause {
  const e = error.toLowerCase();
  if (e.includes('timed out') || e.includes('timeout')) return 'timeout';
  if (e.includes('output does not contain') || e.includes('verification failed'))
    return 'verification_mismatch';
  if (e.includes('failed to spawn') || e.includes('enoent')) return 'spawn_failed';
  if (e.includes('exit code') || e.includes('exited with')) return 'exit_nonzero';
  if (e.includes('aborted') || e.includes('cancelled')) return 'aborted';
  return 'unknown';
}

function diagnosisFor(cause: FailureCause, outcome: StepOutcome): string {
  switch (cause) {
    case 'timeout':
      return outcome.nonInteractive
        ? 'Non-interactive agent timed out — the task is likely too large or complex for a single subprocess call. Consider pre-reading large files in a deterministic step and injecting only the relevant excerpt via {{steps.X.output}}.'
        : 'Interactive agent timed out — it may have gone idle, failed to self-terminate, or the task scope was too broad. Check if the agent was waiting for relay signals that never arrived.';
    case 'verification_mismatch':
      return `Agent completed but did not output the expected sentinel "${outcome.verificationValue ?? '(unknown)'}". The task prompt may not clearly specify the required output format, or the agent produced correct work but did not emit the signal.`;
    case 'spawn_failed':
      return 'The agent process could not be started — the CLI binary may be missing from PATH or the working directory is incorrect.';
    case 'exit_nonzero':
      return 'The agent process exited with a non-zero exit code. Check stderr for the root cause.';
    case 'aborted':
      return 'The step was cancelled (user interrupt or upstream abort).';
    default:
      return 'Unexpected failure. Review the error and step definition.';
  }
}

function buildSynthesis(label: string, outcomes: StepOutcome[], unblocks?: string[]): string {
  const completed = outcomes.filter((o) => o.status === 'completed');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const retried = outcomes.filter((o) => o.attempts > 1 && o.status !== 'failed');
  const parts: string[] = [`${label} resolved.`, `${completed.length}/${outcomes.length} steps completed.`];
  if (failed.length > 0)
    parts.push(`${failed.length} step(s) failed: ${failed.map((s) => s.name).join(', ')}.`);
  if (retried.length > 0)
    parts.push(`${retried.length} step(s) required retries: ${retried.map((s) => s.name).join(', ')}.`);
  else if (failed.length === 0) parts.push('All steps completed on first attempt.');
  if (unblocks?.length) parts.push(`Unblocking: ${unblocks.join(', ')}.`);
  return parts.join(' ');
}

function computeConfidence(outcomes: StepOutcome[]): number {
  if (outcomes.length === 0) return 0.7;
  const total = outcomes.length;
  const completed = outcomes.filter((o) => o.status === 'completed').length;
  const firstAttempt = outcomes.filter((o) => o.attempts === 1 && o.status === 'completed').length;
  const verified = outcomes.filter((o) => o.verificationPassed).length;
  return Math.min(1, 0.5 * (completed / total) + 0.25 * (firstAttempt / total) + 0.25 * (verified / total));
}

function formatElapsed(elapsed: number, long: boolean): string {
  return elapsed > 60_000
    ? `${Math.round(elapsed / 60_000)}${long ? ' minutes' : 'min'}`
    : `${Math.round(elapsed / 1_000)}${long ? ' seconds' : 's'}`;
}

function buildRunSummary(outcomes: StepOutcome[], startTime: number): string {
  const completed = outcomes.filter((o) => o.status === 'completed');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const elapsedStr = formatElapsed(Date.now() - startTime, false);
  if (failed.length === 0) {
    const retried = completed.filter((o) => o.attempts > 1);
    const base = `All ${completed.length} steps completed in ${elapsedStr}.`;
    return retried.length > 0
      ? `${base} ${retried.length} step(s) needed retries: ${retried.map((o) => o.name).join(', ')}.`
      : base;
  }
  const firstFailure = failed[0];
  const cause = classifyFailure(firstFailure.error ?? '');
  const cascaded =
    skipped.length > 0
      ? ` Caused ${skipped.length} downstream step(s) to be skipped: ${skipped.map((o) => o.name).join(', ')}.`
      : '';
  return `Failed at "${firstFailure.name}" [${cause}] after ${elapsedStr}.${cascaded} ${completed.length}/${outcomes.length} steps completed before failure.`;
}

function extractLearnings(outcomes: StepOutcome[]): string[] {
  const learnings: string[] = [];
  const timeouts = outcomes.filter(
    (o) => o.status === 'failed' && classifyFailure(o.error ?? '') === 'timeout'
  );
  if (timeouts.some((o) => o.nonInteractive))
    learnings.push(
      `Non-interactive agent timeouts detected (${timeouts.map((o) => o.name).join(', ')}). Use deterministic steps to pre-read files and inject content — non-interactive agents should not discover information via tools.`
    );
  const verifyFails = outcomes.filter(
    (o) => o.status === 'failed' && classifyFailure(o.error ?? '') === 'verification_mismatch'
  );
  if (verifyFails.length > 0)
    learnings.push(
      `Verification mismatch on: ${verifyFails.map((o) => `"${o.name}" (expected "${o.verificationValue ?? '?'}")`).join(', ')}. Make the required output format more explicit in the task prompt.`
    );
  const retried = outcomes.filter((o) => o.attempts > 1 && o.status === 'completed');
  if (retried.length > 0)
    learnings.push(
      `${retried.map((o) => `"${o.name}" (${o.attempts} attempts)`).join(', ')} succeeded after retries — consider adding clearer output instructions to reduce retries.`
    );
  return learnings;
}

const extractChallenges = (outcomes: StepOutcome[]): string[] =>
  outcomes
    .filter((o) => o.status === 'failed')
    .map((step) => diagnosisFor(classifyFailure(step.error ?? ''), step));

export class WorkflowTrajectory {
  private trajectory: WorkflowTrajectoryData | null = null;
  private storage?: FileStorage;
  private storageInit?: Promise<void>;
  private readonly enabled: boolean;
  private readonly reflectOnBarriers: boolean;
  private readonly reflectOnConverge: boolean;
  private readonly autoDecisions: boolean;
  private readonly storageBaseDir: string;
  private readonly runId: string;
  private startTime = 0;
  private swarmPattern = 'dag';

  constructor(config: TrajectoryConfig | false | undefined, runId: string, cwd: string) {
    const cfg = config === false ? { enabled: false } : (config ?? {});
    this.enabled = cfg.enabled !== false;
    this.reflectOnBarriers = cfg.reflectOnBarriers !== false;
    this.reflectOnConverge = cfg.reflectOnConverge !== false;
    this.autoDecisions = cfg.autoDecisions !== false;
    this.runId = runId;
    const dataDir = process.env.TRAJECTORIES_DATA_DIR ?? join(cwd, '.trajectories');
    this.storageBaseDir = process.env.TRAJECTORIES_DATA_DIR ? dirname(dataDir) : cwd;
  }

  async start(
    workflowName: string,
    stepCount: number,
    trackInfo?: string,
    description?: string,
    pattern?: string
  ): Promise<void> {
    if (!this.enabled) return;
    this.startTime = Date.now();
    this.swarmPattern = pattern ?? 'dag';
    const trajectory = createTrajectory({
      title: workflowName,
      description,
      source: { system: 'workflow-runner', id: this.runId },
    }) as WorkflowTrajectoryData;
    const workflowId = process.env.TRAJECTORIES_WORKFLOW_ID?.trim();
    if (workflowId) trajectory.workflowId = workflowId;
    this.trajectory = trajectory;
    this.trajectory.agents.push({
      name: 'orchestrator',
      role: 'workflow-runner',
      joinedAt: new Date().toISOString(),
    });
    this.openChapter('Planning', 'orchestrator');
    if (description) this.addEvent('note', `Purpose: ${description.trim()}`);
    this.addEvent(
      'note',
      `Approach: ${stepCount}-step ${this.swarmPattern} workflow${trackInfo ? ` — ${trackInfo}` : ''}`
    );
    await this.flush();
  }

  async beginTrack(trackName: string): Promise<void> {
    if (this.enabled && this.trajectory) {
      this.openChapter(`Execution: ${trackName}`, 'orchestrator');
      await this.flush();
    }
  }
  async beginConvergence(label: string): Promise<void> {
    if (this.enabled && this.trajectory) {
      this.openChapter(`Convergence: ${label}`, 'orchestrator');
      await this.flush();
    }
  }

  async stepStarted(step: WorkflowStep, agent: string, participants?: StepParticipants): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    await this.registerAgent(agent, participants?.role ?? step.agent ?? 'deterministic');
    if (participants?.owner && participants.owner !== agent)
      await this.registerAgent(participants.owner, 'owner');
    if (participants?.specialist) await this.registerAgent(participants.specialist, 'specialist');
    if (participants?.reviewer) await this.registerAgent(participants.reviewer, 'reviewer');
    this.openChapter(`Execution: ${step.name}`, agent);
    const intent = step.task
      ? step.task
          .trim()
          .split(/\n|\.(?=\s)/)[0]
          .trim()
          .slice(0, 120)
      : `${step.type ?? 'deterministic'} step`;
    this.addEvent('note', `"${step.name}": ${intent}`, undefined, { agent });
    await this.flush();
  }

  async registerAgent(name: string, role: string): Promise<void> {
    if (!this.enabled || !this.trajectory || this.trajectory.agents.some((agent) => agent.name === name))
      return;
    this.trajectory.agents.push({ name, role, joinedAt: new Date().toISOString() });
    await this.flush();
  }

  async stepSupervisionAssigned(
    step: WorkflowStep,
    supervised: { owner: { name: string }; specialist: { name: string }; reviewer?: { name: string } }
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    await this.registerAgent(supervised.owner.name, 'owner');
    await this.registerAgent(supervised.specialist.name, 'specialist');
    if (supervised.reviewer?.name) await this.registerAgent(supervised.reviewer.name, 'reviewer');
    const reviewerNote = supervised.reviewer?.name ? `, reviewer=${supervised.reviewer.name}` : '';
    this.addEvent(
      'decision',
      `"${step.name}" supervision assigned → owner=${supervised.owner.name}, specialist=${supervised.specialist.name}${reviewerNote}`,
      'medium',
      {
        owner: supervised.owner.name,
        specialist: supervised.specialist.name,
        reviewer: supervised.reviewer?.name,
      }
    );
    await this.flush();
  }

  async ownerMonitoringEvent(
    stepName: string,
    owner: string,
    detail: string,
    raw?: Record<string, unknown>
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    this.addEvent(
      'note',
      `"${stepName}" owner ${owner}: ${detail}`,
      'medium',
      raw ? { owner, ...raw } : { owner }
    );
    await this.flush();
  }

  async reviewCompleted(
    stepName: string,
    reviewerName: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    this.addEvent('review-completed', `"${stepName}" review ${decision} by ${reviewerName}`, 'medium', {
      stepName,
      reviewer: reviewerName,
      decision,
      reason,
    });
    await this.flush();
  }

  async stepCompletionDecision(stepName: string, decision: StepCompletionDecision): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    const modeLabel = decision.mode === 'marker' ? 'marker-based' : `${decision.mode}-based`;
    const reason = decision.reason ? ` — ${decision.reason}` : '';
    const evidence = this.formatCompletionEvidenceSummary(decision.evidence);
    this.addEvent(
      decision.mode === 'marker' ? 'completion-marker' : 'completion-evidence',
      `"${stepName}" ${modeLabel} completion${reason}${evidence ? ` (${evidence})` : ''}`,
      'medium',
      { stepName, completionMode: decision.mode, reason: decision.reason, evidence: decision.evidence }
    );
    await this.flush();
  }

  async stepCompleted(
    step: WorkflowStep,
    output: string,
    attempt: number,
    decision?: StepCompletionDecision
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    if (decision) await this.stepCompletionDecision(step.name, decision);
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const lastMeaningful = lines.at(-1) ?? '';
    const completion =
      lastMeaningful.length > 0 && lastMeaningful.length < 100
        ? lastMeaningful
        : output.trim().slice(0, 120) || '(no output)';
    this.addEvent(
      'finding',
      `"${step.name}" completed${attempt > 1 ? ` (after ${attempt} attempts)` : ''}${decision ? ` [${decision.mode}]` : ''} → ${completion}`,
      'medium'
    );
    await this.flush();
  }

  async stepFailed(
    step: WorkflowStep,
    error: string,
    attempt: number,
    maxRetries: number,
    outcome?: Partial<StepOutcome>
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    const cause = classifyFailure(error);
    const diagnosis = diagnosisFor(cause, {
      name: step.name,
      agent: outcome?.agent ?? step.agent ?? '',
      status: 'failed',
      attempts: attempt,
      error,
      verificationValue: outcome?.verificationValue,
      nonInteractive: outcome?.nonInteractive,
    });
    this.addEvent('error', `"${step.name}" failed [${cause}]: ${diagnosis}`, 'high', {
      cause,
      rawError: error,
      attempt,
      maxRetries,
    });
    await this.flush();
  }

  async stepSkipped(step: WorkflowStep, reason: string): Promise<void> {
    if (this.enabled && this.trajectory) {
      this.addEvent('note', `"${step.name}" skipped — ${reason}`);
      await this.flush();
    }
  }
  async stepRetrying(step: WorkflowStep, attempt: number, maxRetries: number): Promise<void> {
    if (this.enabled && this.trajectory) {
      this.addEvent('note', `"${step.name}" retrying (attempt ${attempt}/${maxRetries + 1})`);
      await this.flush();
    }
  }

  async reflect(synthesis: string, confidence: number, focalPoints?: string[]): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    this.addEvent(
      'reflection',
      synthesis,
      'high',
      focalPoints?.length ? { confidence, focalPoints } : { confidence }
    );
    await this.flush();
  }

  async synthesizeAndReflect(label: string, outcomes: StepOutcome[], unblocks?: string[]): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    await this.beginConvergence(label);
    await this.reflect(
      buildSynthesis(label, outcomes, unblocks),
      computeConfidence(outcomes),
      outcomes.map((o) => `${o.name}: ${o.status}`)
    );
  }

  async decide(question: string, chosen: string, reasoning: string): Promise<void> {
    if (!this.enabled || !this.trajectory || !this.autoDecisions) return;
    this.addEvent('decision', `${question} → ${chosen}: ${reasoning}`, 'medium', {
      question,
      chosen,
      reasoning,
    });
    await this.flush();
  }

  async complete(
    summary: string,
    confidence: number,
    meta?: { learnings?: string[]; challenges?: string[] }
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    this.openChapter('Retrospective', 'orchestrator');
    this.addEvent(
      'reflection',
      `${summary} (completed in ${formatElapsed(Date.now() - this.startTime, true)})`,
      'high'
    );
    this.trajectory = completeTrajectory(this.trajectory as Trajectory, {
      summary,
      approach: this.buildApproach(),
      confidence,
      learnings: meta?.learnings,
      challenges: meta?.challenges,
    }) as WorkflowTrajectoryData;
    await this.flush();
  }

  async abandon(
    reason: string,
    meta?: { summary?: string; confidence?: number; learnings?: string[]; challenges?: string[] }
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;
    const summary = meta?.summary ?? `Workflow abandoned: ${reason}`;
    this.openChapter('Retrospective', 'orchestrator');
    this.addEvent(
      'reflection',
      `${summary} (abandoned after ${formatElapsed(Date.now() - this.startTime, true)})`,
      'high'
    );
    this.addEvent('error', `Workflow abandoned: ${reason}`, 'high');
    this.trajectory = {
      ...abandonTrajectory(this.trajectory as Trajectory),
      retrospective: {
        summary,
        approach: this.buildApproach(),
        confidence: meta?.confidence ?? 0,
        learnings: meta?.learnings,
        challenges: meta?.challenges,
      },
    } as WorkflowTrajectoryData;
    await this.flush();
  }

  isEnabled(): boolean {
    return this.enabled;
  }
  shouldReflectOnConverge(): boolean {
    return this.enabled && this.reflectOnConverge;
  }
  shouldReflectOnBarriers(): boolean {
    return this.enabled && this.reflectOnBarriers;
  }
  getTrajectoryId(): string | null {
    return this.trajectory?.id ?? null;
  }
  buildSynthesis(label: string, outcomes: StepOutcome[], unblocks?: string[]): string {
    return buildSynthesis(label, outcomes, unblocks);
  }
  computeConfidence(outcomes: StepOutcome[]): number {
    return computeConfidence(outcomes);
  }
  buildRunSummary(outcomes: StepOutcome[]): string {
    return buildRunSummary(outcomes, this.startTime);
  }
  extractLearnings(outcomes: StepOutcome[]): string[] {
    return extractLearnings(outcomes);
  }
  extractChallenges(outcomes: StepOutcome[]): string[] {
    return extractChallenges(outcomes);
  }

  private openChapter(title: string, agentName: string): void {
    if (!this.trajectory) return;
    this.trajectory = appendChapter(this.trajectory as Trajectory, {
      title,
      agentName,
    }) as WorkflowTrajectoryData;
  }

  private addEvent(
    type: WorkflowTrajectoryEventType,
    content: string,
    significance?: EventSignificance,
    raw?: Record<string, unknown>
  ): void {
    if (!this.trajectory) return;
    this.trajectory = appendEvent(this.trajectory as Trajectory, {
      type: type as TrajectoryEventType,
      content,
      significance,
      raw,
    }) as WorkflowTrajectoryData;
  }

  private buildApproach(): string {
    return `${this.swarmPattern} workflow (${this.trajectory?.agents.filter((a) => a.role !== 'workflow-runner').length ?? 0} agents)`;
  }

  private formatCompletionEvidenceSummary(
    evidence: StepCompletionDecision['evidence'] | undefined
  ): string | undefined {
    if (!evidence) return undefined;
    const parts: string[] = [];
    if (evidence.summary) parts.push(evidence.summary);
    if (evidence.signals?.length) parts.push(`signals=${evidence.signals.join(', ')}`);
    if (evidence.channelPosts?.length) parts.push(`channel=${evidence.channelPosts.join(' | ')}`);
    if (evidence.files?.length) parts.push(`files=${evidence.files.join(', ')}`);
    if (evidence.exitCode !== undefined) parts.push(`exit=${evidence.exitCode}`);
    return parts.length > 0 ? parts.join('; ') : undefined;
  }

  private async ensureStorage(): Promise<void> {
    this.storage ??= new FileStorage(this.storageBaseDir);
    this.storageInit ??= this.storage.initialize();
    await this.storageInit;
  }

  private async flush(): Promise<void> {
    if (!this.trajectory) return;
    try {
      await this.ensureStorage();
      await this.storage?.save(this.trajectory as Trajectory);
    } catch {
      // non-blocking: flush failures must never break the workflow
    }
  }
}
