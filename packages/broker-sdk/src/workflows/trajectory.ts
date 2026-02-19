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

  constructor(
    config: TrajectoryConfig | false | undefined,
    runId: string,
    cwd: string,
  ) {
    const cfg = config === false ? { enabled: false } : (config ?? {});
    this.enabled = cfg.enabled !== false;
    this.reflectOnBarriers = cfg.reflectOnBarriers !== false;
    this.reflectOnConverge = cfg.reflectOnConverge !== false;
    this.autoDecisions = cfg.autoDecisions !== false;

    this.runId = runId;
    this.dataDir = process.env.TRAJECTORIES_DATA_DIR
      ?? path.join(cwd, '.trajectories');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the trajectory (called at run:started). */
  async start(workflowName: string, stepCount: number, trackInfo?: string): Promise<void> {
    if (!this.enabled) return;

    this.startTime = Date.now();
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

    // Open Planning chapter
    this.openChapter('Planning', 'orchestrator');
    this.addEvent('note', `Workflow "${workflowName}" started with ${stepCount} steps`);
    if (trackInfo) {
      this.addEvent('note', trackInfo);
    }

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

  /** Record step started. */
  async stepStarted(step: WorkflowStep, agent: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    // Register agent if not seen
    if (!this.trajectory.agents.some((a) => a.name === agent)) {
      this.trajectory.agents.push({
        name: agent,
        role: step.agent,
        joinedAt: new Date().toISOString(),
      });
    }

    this.addEvent('note', `Step "${step.name}" assigned to agent "${agent}"`);
    await this.flush();
  }

  /** Record step completed with output summary. */
  async stepCompleted(step: WorkflowStep, output: string, attempt: number): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    const suffix = attempt > 1 ? ` (attempt ${attempt})` : '';
    const summary = output.length > 200 ? output.slice(0, 200) + '...' : output;
    this.addEvent('finding', `Step "${step.name}" completed${suffix}: ${summary}`, 'medium');
    await this.flush();
  }

  /** Record step failed. */
  async stepFailed(step: WorkflowStep, error: string, attempt: number, maxRetries: number): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.addEvent(
      'error',
      `Step "${step.name}" failed (attempt ${attempt}/${maxRetries + 1}): ${error}`,
      'high',
    );
    await this.flush();
  }

  /** Record step skipped. */
  async stepSkipped(step: WorkflowStep, reason: string): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.addEvent('note', `Skipped step "${step.name}": ${reason}`);
    await this.flush();
  }

  /** Record step retrying. */
  async stepRetrying(step: WorkflowStep, attempt: number, maxRetries: number): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.addEvent('note', `Retrying step "${step.name}" (attempt ${attempt}/${maxRetries + 1})`);
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
  async synthesizeAndReflect(
    label: string,
    outcomes: StepOutcome[],
    unblocks?: string[],
  ): Promise<void> {
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
    meta?: { learnings?: string[]; challenges?: string[] },
  ): Promise<void> {
    if (!this.enabled || !this.trajectory) return;

    this.openRetrospective();

    const elapsed = Date.now() - this.startTime;
    const elapsedStr = elapsed > 60_000
      ? `${Math.round(elapsed / 60_000)} minutes`
      : `${Math.round(elapsed / 1_000)} seconds`;

    this.addEvent('reflection', `${summary} (completed in ${elapsedStr})`, 'high');

    this.trajectory.status = 'completed';
    this.trajectory.completedAt = new Date().toISOString();
    this.trajectory.retrospective = {
      summary,
      approach: 'workflow-runner DAG execution',
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

    const parts: string[] = [
      `${label} resolved.`,
      `${completed.length}/${outcomes.length} steps completed.`,
    ];

    if (failed.length > 0) {
      parts.push(`${failed.length} step(s) failed: ${failed.map((s) => s.name).join(', ')}.`);
    }

    if (retried.length > 0) {
      parts.push(
        `${retried.length} step(s) required retries: ${retried.map((s) => s.name).join(', ')}.`,
      );
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
    return Math.min(
      1.0,
      0.5 * completionRate +
        (firstAttempt / total) * 0.25 +
        (verified / total) * 0.25,
    );
  }

  buildRunSummary(outcomes: StepOutcome[]): string {
    const completed = outcomes.filter((o) => o.status === 'completed').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    const totalRetries = outcomes.reduce((sum, o) => sum + Math.max(0, o.attempts - 1), 0);

    const elapsed = Date.now() - this.startTime;
    const elapsedStr = elapsed > 60_000
      ? `${Math.round(elapsed / 60_000)} minutes`
      : `${Math.round(elapsed / 1_000)} seconds`;

    const parts = [`Workflow completed in ${elapsedStr}.`];
    parts.push(`${completed}/${outcomes.length} steps passed.`);

    if (failed > 0) parts.push(`${failed} failed.`);
    if (skipped > 0) parts.push(`${skipped} skipped.`);
    if (totalRetries > 0) parts.push(`${totalRetries} total retries.`);

    return parts.join(' ');
  }

  extractLearnings(outcomes: StepOutcome[]): string[] {
    const learnings: string[] = [];
    const retried = outcomes.filter((o) => o.attempts > 1 && o.status === 'completed');
    if (retried.length > 0) {
      learnings.push(
        `Steps requiring retries: ${retried.map((o) => `${o.name} (${o.attempts} attempts)`).join(', ')}`,
      );
    }
    return learnings;
  }

  extractChallenges(outcomes: StepOutcome[]): string[] {
    const challenges: string[] = [];
    const failed = outcomes.filter((o) => o.status === 'failed');
    for (const step of failed) {
      challenges.push(`${step.name}: ${step.error ?? 'unknown error'}`);
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
    raw?: Record<string, unknown>,
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
