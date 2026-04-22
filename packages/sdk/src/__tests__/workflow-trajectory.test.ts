/**
 * WorkflowTrajectory unit tests.
 *
 * Tests trajectory recording, chapter management, reflections, decisions,
 * confidence computation, and the disabled/enabled toggle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkflowTrajectory, type StepOutcome } from '../workflows/trajectory.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let originalTrajectoriesDataDir: string | undefined;
let originalWorkflowId: string | undefined;

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `wf-traj-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function findFirstJsonFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstJsonFile(entryPath);
      if (nested) return nested;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) return entryPath;
  }
  return null;
}

function readTrajectoryFile(dir: string): any {
  const file = findFirstJsonFile(path.join(dir, '.trajectories', 'active'));
  return file ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

function readCompletedTrajectoryFile(dir: string): any {
  const file = findFirstJsonFile(path.join(dir, '.trajectories', 'completed'));
  return file ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

function readTrajectoryFileAt(dataDir: string, status: 'active' | 'completed'): any {
  const file = findFirstJsonFile(path.join(dataDir, status));
  return file ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowTrajectory', () => {
  beforeEach(() => {
    originalTrajectoriesDataDir = process.env.TRAJECTORIES_DATA_DIR;
    originalWorkflowId = process.env.TRAJECTORIES_WORKFLOW_ID;
    delete process.env.TRAJECTORIES_DATA_DIR;
    delete process.env.TRAJECTORIES_WORKFLOW_ID;
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (originalTrajectoriesDataDir === undefined) {
      delete process.env.TRAJECTORIES_DATA_DIR;
    } else {
      process.env.TRAJECTORIES_DATA_DIR = originalTrajectoriesDataDir;
    }
    if (originalWorkflowId === undefined) {
      delete process.env.TRAJECTORIES_WORKFLOW_ID;
    } else {
      process.env.TRAJECTORIES_WORKFLOW_ID = originalWorkflowId;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  // ── Disabled mode ──────────────────────────────────────────────────────

  describe('disabled', () => {
    it('should not create files when trajectories is false', async () => {
      const traj = new WorkflowTrajectory(false, 'run-1', tmpDir);
      await traj.start('test-workflow', 3);

      expect(traj.isEnabled()).toBe(false);
      expect(traj.getTrajectoryId()).toBeNull();
      expect(existsSync(path.join(tmpDir, '.trajectories'))).toBe(false);
    });

    it('should not create files when enabled is false', async () => {
      const traj = new WorkflowTrajectory({ enabled: false }, 'run-1', tmpDir);
      await traj.start('test-workflow', 3);

      expect(traj.isEnabled()).toBe(false);
    });

    it('should be enabled by default', () => {
      const traj = new WorkflowTrajectory(undefined, 'run-1', tmpDir);
      expect(traj.isEnabled()).toBe(true);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should create a trajectory file on start', async () => {
      const traj = new WorkflowTrajectory({}, 'run-abc', tmpDir);
      await traj.start('my-workflow', 5);

      expect(traj.getTrajectoryId()).toBeTruthy();
      expect(traj.getTrajectoryId()!.startsWith('traj_')).toBe(true);

      const data = readTrajectoryFile(tmpDir);
      expect(data).toBeTruthy();
      expect(data.status).toBe('active');
      expect(data.task.title).toContain('my-workflow');
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].name).toBe('orchestrator');
      expect(data.commits).toEqual([]);
      expect(data.filesChanged).toEqual([]);
      expect(data.tags).toEqual([]);
    });

    it('should create Planning chapter on start', async () => {
      const traj = new WorkflowTrajectory({}, 'run-abc', tmpDir);
      await traj.start('my-workflow', 3, '3 parallel tracks, 2 barriers');

      const data = readTrajectoryFile(tmpDir);
      expect(data.chapters).toHaveLength(1);
      expect(data.chapters[0].title).toBe('Planning');
      expect(data.chapters[0].events.length).toBeGreaterThanOrEqual(1);
    });

    it('should complete trajectory and move to completed dir', async () => {
      const traj = new WorkflowTrajectory({}, 'run-abc', tmpDir);
      await traj.start('my-workflow', 2);
      await traj.complete('All done', 0.95);

      const active = readTrajectoryFile(tmpDir);
      expect(active).toBeNull(); // Moved out of active

      const completed = readCompletedTrajectoryFile(tmpDir);
      expect(completed).toBeTruthy();
      expect(completed.status).toBe('completed');
      expect(completed.retrospective.summary).toBe('All done');
      expect(completed.retrospective.confidence).toBe(0.95);
    });

    it('should abandon trajectory and move to completed dir', async () => {
      const traj = new WorkflowTrajectory({}, 'run-abc', tmpDir);
      await traj.start('my-workflow', 2);
      await traj.abandon('Something went wrong');

      const completed = readCompletedTrajectoryFile(tmpDir);
      expect(completed).toBeTruthy();
      expect(completed.status).toBe('abandoned');
    });

    it('should stamp workflowId from TRAJECTORIES_WORKFLOW_ID on start', async () => {
      process.env.TRAJECTORIES_WORKFLOW_ID = 'wf-env-123';
      const traj = new WorkflowTrajectory({}, 'run-abc', tmpDir);
      await traj.start('my-workflow', 1);

      const data = readTrajectoryFile(tmpDir);
      expect(data.workflowId).toBe('wf-env-123');
    });

    it('should write to TRAJECTORIES_DATA_DIR when set', async () => {
      const customDataDir = path.join(tmpDir, 'custom-root', '.trajectories');
      process.env.TRAJECTORIES_DATA_DIR = customDataDir;

      const traj = new WorkflowTrajectory({}, 'run-abc', tmpDir);
      await traj.start('my-workflow', 1);

      expect(readTrajectoryFile(tmpDir)).toBeNull();
      expect(readTrajectoryFileAt(customDataDir, 'active')).toBeTruthy();
    });
  });

  // ── Step events ────────────────────────────────────────────────────────

  describe('step events', () => {
    it('should record step started', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 2);
      await traj.stepStarted({ name: 'build', agent: 'builder', task: 'Build it' }, 'builder-agent');

      const data = readTrajectoryFile(tmpDir);
      expect(data.agents).toHaveLength(2); // orchestrator + builder-agent
      const events = data.chapters.flatMap((c: any) => c.events);
      expect(events.some((e: any) => e.content.includes('build'))).toBe(true);
    });

    it('should record step completed', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 1);
      await traj.stepCompleted({ name: 'test', agent: 'tester', task: 'Run tests' }, 'All tests passing', 1);

      const data = readTrajectoryFile(tmpDir);
      const events = data.chapters.flatMap((c: any) => c.events);
      expect(events.some((e: any) => e.type === 'finding')).toBe(true);
    });

    it('should record step failed', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 1);
      await traj.stepFailed(
        { name: 'deploy', agent: 'deployer', task: 'Deploy' },
        'Connection refused',
        1,
        3
      );

      const data = readTrajectoryFile(tmpDir);
      const events = data.chapters.flatMap((c: any) => c.events);
      expect(events.some((e: any) => e.type === 'error')).toBe(true);
    });

    it('should record step skipped', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 2);
      await traj.stepSkipped({ name: 'integration', agent: 'tester', task: 'Test' }, 'Upstream failed');

      const data = readTrajectoryFile(tmpDir);
      const events = data.chapters.flatMap((c: any) => c.events);
      expect(events.some((e: any) => e.content.includes('skipped'))).toBe(true);
    });
  });

  // ── Chapters ───────────────────────────────────────────────────────────

  describe('chapters', () => {
    it('should create track chapters', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 3);
      await traj.beginTrack('backend');

      const data = readTrajectoryFile(tmpDir);
      expect(data.chapters.length).toBeGreaterThanOrEqual(2);
      expect(data.chapters.some((c: any) => c.title === 'Execution: backend')).toBe(true);
    });

    it('should create convergence chapters', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 3);
      await traj.beginConvergence('all-tracks-done');

      const data = readTrajectoryFile(tmpDir);
      expect(data.chapters.some((c: any) => c.title === 'Convergence: all-tracks-done')).toBe(true);
    });

    it('should close previous chapter when opening new one', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 3);
      await traj.beginTrack('track-a');
      await traj.beginTrack('track-b');

      const data = readTrajectoryFile(tmpDir);
      // Planning chapter should have endedAt
      expect(data.chapters[0].endedAt).toBeTruthy();
      // First track chapter should have endedAt
      expect(data.chapters[1].endedAt).toBeTruthy();
    });
  });

  // ── Reflections ────────────────────────────────────────────────────────

  describe('reflections', () => {
    it('should record reflect events', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 2);
      await traj.reflect('All parallel tracks complete', 0.85, ['step-a: completed', 'step-b: completed']);

      const data = readTrajectoryFile(tmpDir);
      const events = data.chapters.flatMap((c: any) => c.events);
      const reflection = events.find((e: any) => e.type === 'reflection');
      expect(reflection).toBeTruthy();
      expect(reflection.significance).toBe('high');
      expect(reflection.raw.confidence).toBe(0.85);
      expect(reflection.raw.focalPoints).toHaveLength(2);
    });

    it('should synthesize and reflect at convergence', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 3);

      const outcomes: StepOutcome[] = [
        { name: 'step-a', agent: 'a', status: 'completed', attempts: 1 },
        { name: 'step-b', agent: 'b', status: 'completed', attempts: 2 },
      ];

      await traj.synthesizeAndReflect('backend-ready', outcomes, ['step-c']);

      const data = readTrajectoryFile(tmpDir);
      // Should have a convergence chapter
      expect(data.chapters.some((c: any) => c.title.includes('Convergence'))).toBe(true);
      const events = data.chapters.flatMap((c: any) => c.events);
      const reflection = events.find((e: any) => e.type === 'reflection');
      expect(reflection).toBeTruthy();
      expect(reflection.content).toContain('backend-ready');
      expect(reflection.content).toContain('step-b'); // retried
    });
  });

  // ── Decisions ──────────────────────────────────────────────────────────

  describe('decisions', () => {
    it('should record decisions', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 1);
      await traj.decide('How to handle failure', 'retry', 'Transient error detected');

      const data = readTrajectoryFile(tmpDir);
      const events = data.chapters.flatMap((c: any) => c.events);
      const decision = events.find((e: any) => e.type === 'decision');
      expect(decision).toBeTruthy();
      expect(decision.raw.chosen).toBe('retry');
    });

    it('should skip decisions when autoDecisions is false', async () => {
      const traj = new WorkflowTrajectory({ autoDecisions: false }, 'run-1', tmpDir);
      await traj.start('wf', 1);
      await traj.decide('How to handle failure', 'retry', 'Transient error');

      const data = readTrajectoryFile(tmpDir);
      const events = data.chapters.flatMap((c: any) => c.events);
      expect(events.filter((e: any) => e.type === 'decision')).toHaveLength(0);
    });
  });

  // ── Confidence computation ─────────────────────────────────────────────

  describe('computeConfidence', () => {
    it('should return 1.0 for all first-attempt verified completions', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      const outcomes: StepOutcome[] = [
        { name: 'a', agent: 'a', status: 'completed', attempts: 1, verificationPassed: true },
        { name: 'b', agent: 'b', status: 'completed', attempts: 1, verificationPassed: true },
      ];
      expect(traj.computeConfidence(outcomes)).toBe(1.0);
    });

    it('should return lower confidence for retried steps', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      const outcomes: StepOutcome[] = [
        { name: 'a', agent: 'a', status: 'completed', attempts: 1, verificationPassed: true },
        { name: 'b', agent: 'b', status: 'completed', attempts: 3, verificationPassed: true },
      ];
      const confidence = traj.computeConfidence(outcomes);
      expect(confidence).toBeLessThan(1.0);
      expect(confidence).toBeGreaterThan(0.5);
    });

    it('should return lower confidence for failed steps', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      const outcomes: StepOutcome[] = [
        { name: 'a', agent: 'a', status: 'completed', attempts: 1 },
        { name: 'b', agent: 'b', status: 'failed', attempts: 3 },
      ];
      const confidence = traj.computeConfidence(outcomes);
      expect(confidence).toBeLessThan(0.5);
    });

    it('should return 0.7 for empty outcomes', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      expect(traj.computeConfidence([])).toBe(0.7);
    });
  });

  // ── Synthesis helpers ──────────────────────────────────────────────────

  describe('buildSynthesis', () => {
    it('should produce meaningful synthesis text', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      const outcomes: StepOutcome[] = [
        { name: 'step-a', agent: 'a', status: 'completed', attempts: 1 },
        { name: 'step-b', agent: 'b', status: 'completed', attempts: 2 },
        { name: 'step-c', agent: 'c', status: 'failed', attempts: 3, error: 'timeout' },
      ];

      const synthesis = traj.buildSynthesis('barrier-1', outcomes, ['step-d']);
      expect(synthesis).toContain('barrier-1');
      expect(synthesis).toContain('2/3 steps completed');
      expect(synthesis).toContain('step-c'); // failed
      expect(synthesis).toContain('step-b'); // retried
      expect(synthesis).toContain('step-d'); // unblocked
    });

    it('should note all-first-attempt when no retries', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      const outcomes: StepOutcome[] = [
        { name: 'a', agent: 'a', status: 'completed', attempts: 1 },
        { name: 'b', agent: 'b', status: 'completed', attempts: 1 },
      ];

      const synthesis = traj.buildSynthesis('done', outcomes);
      expect(synthesis).toContain('All steps completed on first attempt');
    });
  });

  describe('buildRunSummary', () => {
    it('should produce run summary with stats', () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      const outcomes: StepOutcome[] = [
        { name: 'a', agent: 'a', status: 'completed', attempts: 1 },
        { name: 'b', agent: 'b', status: 'completed', attempts: 2 },
        { name: 'c', agent: 'c', status: 'failed', attempts: 3 },
        { name: 'd', agent: 'd', status: 'skipped', attempts: 1 },
      ];

      const summary = traj.buildRunSummary(outcomes);
      expect(summary).toContain('Failed at "c"');
      expect(summary).toContain('2/4 steps completed before failure');
      expect(summary).toContain('downstream step(s) to be skipped');
    });
  });

  // ── Non-blocking behavior ──────────────────────────────────────────────

  describe('non-blocking', () => {
    it('should not throw on flush errors', async () => {
      // Use a path that will fail (read-only or invalid)
      const traj = new WorkflowTrajectory({}, 'run-1', '/dev/null/impossible-path');
      // Should not throw
      await expect(traj.start('wf', 1)).resolves.not.toThrow();
    });

    it('should handle all methods gracefully when not started', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      // Don't call start — all methods should be no-ops
      await expect(traj.stepStarted({ name: 'x', agent: 'a', task: 't' }, 'a')).resolves.not.toThrow();
      await expect(traj.reflect('test', 0.5)).resolves.not.toThrow();
      await expect(traj.decide('q', 'c', 'r')).resolves.not.toThrow();
      await expect(traj.complete('done', 0.9)).resolves.not.toThrow();
    });

    it('should save once when completing', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 1);

      const save = vi.fn().mockResolvedValue(undefined);
      (traj as any).storage = { initialize: vi.fn().mockResolvedValue(undefined), save };
      (traj as any).storageInit = Promise.resolve();

      await traj.complete('done', 0.9);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('should save once when abandoning', async () => {
      const traj = new WorkflowTrajectory({}, 'run-1', tmpDir);
      await traj.start('wf', 1);

      const save = vi.fn().mockResolvedValue(undefined);
      (traj as any).storage = { initialize: vi.fn().mockResolvedValue(undefined), save };
      (traj as any).storageInit = Promise.resolve();

      await traj.abandon('nope');
      expect(save).toHaveBeenCalledTimes(1);
    });
  });
});
