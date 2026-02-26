/**
 * WorkflowTrajectory — records a structured trajectory for each workflow run.
 *
 * Writes trajectory JSON files directly to `.trajectories/active/` in a format
 * compatible with `trail show`. No external CLI or package dependency required.
 *
 * Design principles:
 *   1. One trajectory per workflow run
 *   2. Chapters map to workflow phases, not individual steps
 *   3. Non-blocking — trajectory recording never fails the workflow
 *   4. Opt-in but default-on
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

import type { TrajectoryConfig, WorkflowStep } from './types.js';

// ── Trajectory file format (compatible with trail CLI) ───────────────────────

interface TrajectoryEvent {
  ts: number;
  type: string;
  content: string;
  raw?: Record<string, unknown>;
  significance?: 'low' | 'medium' | 'high';
}

interface TrajectoryChapter {
  id: string;
  title: string;
  agentName: string;
  startedAt: string;
  endedAt?: string;
  events: TrajectoryEvent[];
}

interface TrajectoryAgent {
  name: string;
  role: string;
  joinedAt: string;
}

interface TrajectoryFile {
  id: string;
  version: number;
  task: { title: string; source?: { system: string; id: string } };
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  agents: TrajectoryAgent[];
  chapters: TrajectoryChapter[];
  retrospective?: {
    summary: string;
    approach: string;
    confidence: number;
    learnings?: string[];
    challenges?: string[];
  };
}

// ── Step state for synthesis ─────────────────────────────────────────────────

export interface StepOutcome {
  name: string;
  agent: string;
  status: 'completed' | 'failed' | 'skipped';
  attempts: number;
  output?: string;
  error?: string;
  verificationPassed?: boolean;
  /** Sentinel value the step was verifying for, if any. */
  verificationValue?: string;
  /** Whether this was a non-interactive (subprocess) step. */
  nonInteractive?: boolean;
  /** Duration in ms. */
  durationMs?: number;
}

// ── Failure root-cause categories ───────────────────────────────────────────

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
      if (outcome.nonInteractive) {
        return (
          `Non-interactive agent timed out — the task is likely too large or complex for a single subprocess call. ` +
          `Consider pre-reading large files in a deterministic step and injecting only the relevant excerpt via {{steps.X.output}}.`
        );
      }
      return (
        `Interactive agent timed out — it may have gone idle, failed to self-terminate, or the task scope was too broad. ` +
        `Check if the agent was waiting for relay signals that never arrived.`
      );
    case 'verification_mismatch':
      return (
        `Agent completed but did not output the expected sentinel "${outcome.verificationValue ?? '(unknown)'}". ` +
        `The task prompt may not clearly specify the required output format, ` +
        `or the agent produced correct work but did not emit the signal.`
      );
    case 'spawn_failed':
      return `The agent process could not be started — the CLI binary may be missing from PATH or the working directory is incorrect.`;
    case 'exit_nonzero':
      return `The agent process exited with a non-zero exit code. Check stderr for the root cause.`;
    case 'aborted':
      return `The step was cancelled (user interrupt or upstream abort).`;
    default:
      return `Unexpected failure. Review the error and step definition.`;
  }
}

// ── WorkflowTrajectory ──────────────────────────────────────────────────────

export class WorkflowTrajectory {
  private trajectory: TrajectoryFile | null = null;
  private currentChapterId: string | null = null;
  private readonly enabled: boolean;
  private readonly reflectOnBarriers: boolean;
  private readonly reflectOnConverge: boolean;
  private readonly autoDecisions: boolean;
  private readonly dataDir: string;
  private readonly runId: string;
  private startTime: number = 0;
  private swarmPattern: string = 'dag';

  constructor(config: TrajectoryConfig | false | undefined, runId: string, cwd: string) {
    const cfg = config === false ? { enabled: false } : (config ?? {});
    this.enabled = cfg.enabled !== false;
    this.reflectOnBarriers = cfg.reflectOnBarriers !== false;
    this.reflectOnConverge = cfg.reflectOnConverge !== false;
    this.autoDecisions = cfg.autoDecisions !== false;

    this.runId = runId;
    this.dataDir = process.env.TRAJECTORIES_DATA_DIR ?? path.join(cwd, '.trajectories');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the trajectory (called at run:started). */
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
    const id = `traj_${Date.now()}_${randomBytes(4).toString('hex')}`;

    this.trajectory = {
      id,
      version: 1,
      task: {
        title: `${workflowName} run #${this.runId.slice(0, 8)}`,
        source: { system: 'workflow-runner', id: this.runId },
      },
      status: 'active',
      startedAt: new Date().toISOString(),
      agents: [{ name: 'orchestrator', role: 'workflow-runner', joinedAt: new Date().toISOString() }],
      chapters: [],
    };

    // Open Planning chapter — record intent, not just mechanics
    this.openChapter('Planning', 'orchestrator');

    if (description) {
      // Record why this workflow exists
      this.addEvent('note', `Purpose: ${description.trim()}`);
    }

    this.addEvent(
      'note',
      `Approach: ${stepCount}-step ${this.swarmPattern} workflow${trackInfo ? ` — ${trackInfo}` : ''}`
    );

    await this.flush();
  }

  // ── Chapters ───────────────────────────────────────────────────────────────

  /** Begin a new parallel track chapter. */
  async beginTrack(trackName: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.closeCurrentChapter();
    this.openChapter(`Execution: ${trackName}`, 'orchestrator');
    await this.flush();
  }

  /** Begin a convergence chapter (after barrier/parallel completion). */
  async beginConvergence(label: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.closeCurrentChapter();
    this.openChapter(`Convergence: ${label}`, 'orchestrator');
    await this.flush();
  }

  /** Begin the retrospective chapter. */
  private openRetrospective(): void {
    if (!this.trajectory) return;
    this.closeCurrentChapter();
    this.openChapter('Retrospective', 'orchestrator');
  }

  // ── Step events ────────────────────────────────────────────────────────────

  /** Record step started — captures intent, not just assignment. */
  async stepStarted(step: WorkflowStep, agent: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    // Register agent if not seen
    if (!this.trajectory.agents.some((a) => a.name === agent)) {
      this.trajectory.agents.push({
        name: agent,
        role: step.agent ?? 'deterministic',
        joinedAt: new Date().toISOString(),
      });
    }

    // Capture the step's purpose: first non-empty sentence of the task
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

  /** Record step completed — captures what was accomplished. */
  async stepCompleted(step: WorkflowStep, output: string, attempt: number): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    const suffix = attempt > 1 ? ` (after ${attempt} attempts)` : '';

    // Prefer the last non-empty line of output as the completion signal —
    // agents conventionally output their sentinel last (e.g. "ANALYSIS_DONE")
    const lines = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const lastMeaningful = lines.at(-1) ?? '';
    const completion =
      lastMeaningful.length > 0 && lastMeaningful.length < 100
        ? lastMeaningful
        : output.trim().slice(0, 120) || '(no output)';

    this.addEvent('finding', `"${step.name}" completed${suffix} → ${completion}`, 'medium');
    await this.flush();
  }

  /** Record step failed — categorizes root cause for actionable diagnosis. */
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

  /** Record step skipped — note the cascade impact. */
  async stepSkipped(step: WorkflowStep, reason: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.addEvent('note', `"${step.name}" skipped — ${reason}`);
    await this.flush();
  }

  /** Record step retrying. */
  async stepRetrying(step: WorkflowStep, attempt: number, maxRetries: number): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.addEvent('note', `"${step.name}" retrying (attempt ${attempt}/${maxRetries + 1})`);
    await this.flush();
  }

  // ── Reflections ────────────────────────────────────────────────────────────

  /** Record a reflection at a convergence point. */
  async reflect(synthesis: string, confidence: number, focalPoints?: string[]): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    const raw: Record<string, unknown> = { confidence };
    if (focalPoints?.length) {
      raw.focalPoints = focalPoints;
    }

    this.addEvent('reflection', synthesis, 'high', raw);
    await this.flush();
  }

  /** Synthesize and reflect after a set of steps complete (barrier or parallel convergence). */
  async synthesizeAndReflect(label: string, outcomes: StepOutcome[], unblocks?: string[]): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    const synthesis = this.buildSynthesis(label, outcomes, unblocks);
    const confidence = this.computeConfidence(outcomes);
    const focalPoints = outcomes.map((o) => `${o.name}: ${o.status}`);

    await this.beginConvergence(label);
    await this.reflect(synthesis, confidence, focalPoints);
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  /** Record an orchestrator decision. */
  async decide(question: string, chosen: string, reasoning: string): Promise<void> {
    if (!this.enabled || !this.trajectory || !this.autoDecisions) return;

    this.addEvent('decision', `${question} → ${chosen}: ${reasoning}`, 'medium', {
      question,
      chosen,
      reasoning,
    });
    await this.flush();
  }

  // ── Completion ─────────────────────────────────────────────────────────────

  /** Complete the trajectory with a summary. */
  async complete(
    summary: string,
    confidence: number,
    meta?: { learnings?: string[]; challenges?: string[] }
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.openRetrospective();

    const elapsed = Date.now() - this.startTime;
    const elapsedStr =
      elapsed > 60_000 ? `${Math.round(elapsed / 60_000)} minutes` : `${Math.round(elapsed / 1_000)} seconds`;

    this.addEvent('reflection', `${summary} (completed in ${elapsedStr})`, 'high');

    this.trajectory.status = 'completed';
    this.trajectory.completedAt = new Date().toISOString();
    this.trajectory.retrospective = {
      summary,
      approach: `${this.swarmPattern} workflow (${this.trajectory.agents.filter((a) => a.role !== 'workflow-runner').length} agents)`,
      confidence,
      learnings: meta?.learnings,
      challenges: meta?.challenges,
    };

    this.closeCurrentChapter();
    await this.flush();
    await this.moveToCompleted();
  }

  /** Abandon the trajectory. */
  async abandon(reason: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.addEvent('error', `Workflow abandoned: ${reason}`, 'high');
    this.trajectory.status = 'abandoned';
    this.trajectory.completedAt = new Date().toISOString();

    this.closeCurrentChapter();
    await this.flush();
    await this.moveToCompleted();
  }

  // ── Getters ────────────────────────────────────────────────────────────────

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

  // ── Synthesis helpers ──────────────────────────────────────────────────────

  buildSynthesis(label: string, outcomes: StepOutcome[], unblocks?: string[]): string {
    const completed = outcomes.filter((o) => o.status === 'completed');
    const failed = outcomes.filter((o) => o.status === 'failed');
    const retried = outcomes.filter((o) => o.attempts > 1 && o.status !== 'failed');

    const parts: string[] = [`${label} resolved.`, `${completed.length}/${outcomes.length} steps completed.`];

    if (failed.length > 0) {
      parts.push(`${failed.length} step(s) failed: ${failed.map((s) => s.name).join(', ')}.`);
    }

    if (retried.length > 0) {
      parts.push(`${retried.length} step(s) required retries: ${retried.map((s) => s.name).join(', ')}.`);
    } else if (failed.length === 0) {
      parts.push('All steps completed on first attempt.');
    }

    if (unblocks?.length) {
      parts.push(`Unblocking: ${unblocks.join(', ')}.`);
    }

    return parts.join(' ');
  }

  computeConfidence(outcomes: StepOutcome[]): number {
    if (outcomes.length === 0) return 0.7;

    const total = outcomes.length;
    const completed = outcomes.filter((o) => o.status === 'completed').length;
    const firstAttempt = outcomes.filter((o) => o.attempts === 1 && o.status === 'completed').length;
    const verified = outcomes.filter((o) => o.verificationPassed).length;

    // Base: 0.5 scaled by completion rate, +0.25 for first-attempt, +0.25 for verified
    const completionRate = completed / total;
    return Math.min(1.0, 0.5 * completionRate + (firstAttempt / total) * 0.25 + (verified / total) * 0.25);
  }

  buildRunSummary(outcomes: StepOutcome[]): string {
    const completed = outcomes.filter((o) => o.status === 'completed');
    const failed = outcomes.filter((o) => o.status === 'failed');
    const skipped = outcomes.filter((o) => o.status === 'skipped');

    const elapsed = Date.now() - this.startTime;
    const elapsedStr =
      elapsed > 60_000 ? `${Math.round(elapsed / 60_000)}min` : `${Math.round(elapsed / 1_000)}s`;

    if (failed.length === 0) {
      const retried = completed.filter((o) => o.attempts > 1);
      const base = `All ${completed.length} steps completed in ${elapsedStr}.`;
      return retried.length > 0
        ? `${base} ${retried.length} step(s) needed retries: ${retried.map((o) => o.name).join(', ')}.`
        : base;
    }

    // Failure narrative — focus on root cause of the first failure
    const firstFailure = failed[0];
    const cause = classifyFailure(firstFailure.error ?? '');
    const cascaded =
      skipped.length > 0
        ? ` Caused ${skipped.length} downstream step(s) to be skipped: ${skipped.map((o) => o.name).join(', ')}.`
        : '';

    return (
      `Failed at "${firstFailure.name}" [${cause}] after ${elapsedStr}.${cascaded} ` +
      `${completed.length}/${outcomes.length} steps completed before failure.`
    );
  }

  extractLearnings(outcomes: StepOutcome[]): string[] {
    const learnings: string[] = [];

    const timeouts = outcomes.filter(
      (o) => o.status === 'failed' && classifyFailure(o.error ?? '') === 'timeout'
    );
    if (timeouts.some((o) => o.nonInteractive)) {
      learnings.push(
        `Non-interactive agent timeouts detected (${timeouts.map((o) => o.name).join(', ')}). ` +
          `Use deterministic steps to pre-read files and inject content — non-interactive agents should not discover information via tools.`
      );
    }

    const verifyFails = outcomes.filter(
      (o) => o.status === 'failed' && classifyFailure(o.error ?? '') === 'verification_mismatch'
    );
    if (verifyFails.length > 0) {
      learnings.push(
        `Verification mismatch on: ${verifyFails.map((o) => `"${o.name}" (expected "${o.verificationValue ?? '?'}")`).join(', ')}. ` +
          `Make the required output format more explicit in the task prompt.`
      );
    }

    const retried = outcomes.filter((o) => o.attempts > 1 && o.status === 'completed');
    if (retried.length > 0) {
      learnings.push(
        `${retried.map((o) => `"${o.name}" (${o.attempts} attempts)`).join(', ')} succeeded after retries — ` +
          `consider adding clearer output instructions to reduce retries.`
      );
    }

    return learnings;
  }

  extractChallenges(outcomes: StepOutcome[]): string[] {
    const challenges: string[] = [];
    const failed = outcomes.filter((o) => o.status === 'failed');
    for (const step of failed) {
      const cause = classifyFailure(step.error ?? '');
      challenges.push(diagnosisFor(cause, step));
    }
    return challenges;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private openChapter(title: string, agentName: string): void {
    if (!this.trajectory) return;

    const chapter: TrajectoryChapter = {
      id: `ch_${randomBytes(4).toString('hex')}`,
      title,
      agentName,
      startedAt: new Date().toISOString(),
      events: [],
    };

    this.trajectory.chapters.push(chapter);
    this.currentChapterId = chapter.id;
  }

  private closeCurrentChapter(): void {
    if (!this.trajectory || !this.currentChapterId) return;

    const chapter = this.trajectory.chapters.find((c) => c.id === this.currentChapterId);
    if (chapter && !chapter.endedAt) {
      chapter.endedAt = new Date().toISOString();
    }
    this.currentChapterId = null;
  }

  private addEvent(
    type: string,
    content: string,
    significance?: 'low' | 'medium' | 'high',
    raw?: Record<string, unknown>
  ): void {
    if (!this.trajectory) return;

    // Find current chapter or create a default one
    let chapter = this.trajectory.chapters.find((c) => c.id === this.currentChapterId);
    if (!chapter) {
      this.openChapter('Execution', 'orchestrator');
      chapter = this.trajectory.chapters[this.trajectory.chapters.length - 1];
    }

    const event: TrajectoryEvent = {
      ts: Date.now(),
      type,
      content,
    };

    if (significance) event.significance = significance;
    if (raw) event.raw = raw;

    chapter.events.push(event);
  }

  private async flush(): Promise<void> {
    if (!this.trajectory) return;

    try {
      const activeDir = path.join(this.dataDir, 'active');
      await mkdir(activeDir, { recursive: true });

      const filePath = path.join(activeDir, `${this.trajectory.id}.json`);
      await writeFile(filePath, JSON.stringify(this.trajectory, null, 2), 'utf-8');
    } catch {
      // Non-blocking: trajectory recording failure should never break the workflow
    }
  }

  private async moveToCompleted(): Promise<void> {
    if (!this.trajectory) return;

    try {
      const activeDir = path.join(this.dataDir, 'active');
      const completedDir = path.join(this.dataDir, 'completed');
      await mkdir(completedDir, { recursive: true });

      const activePath = path.join(activeDir, `${this.trajectory.id}.json`);
      const completedPath = path.join(completedDir, `${this.trajectory.id}.json`);

      if (existsSync(activePath)) {
        await rename(activePath, completedPath);
      }
    } catch {
      // Non-blocking
    }
  }
}
