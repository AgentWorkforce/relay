/**
 * Trajectory Integration Module
 *
 * Integrates with the agent-trajectories package to provide
 * PDERO paradigm tracking within agent-relay.
 *
 * This module provides a bridge between agent-relay and the
 * external `trail` CLI / agent-trajectories library.
 */

import { spawn } from 'node:child_process';
import { getProjectPaths } from '../utils/project-namespace.js';

/**
 * PDERO phases for agent work lifecycle
 */
export type PDEROPhase = 'plan' | 'design' | 'execute' | 'review' | 'observe';

/**
 * Options for starting a trajectory
 */
export interface StartTrajectoryOptions {
  task: string;
  taskId?: string;
  source?: string;
  agentName: string;
  phase?: PDEROPhase;
}

/**
 * Options for completing a trajectory
 */
export interface CompleteTrajectoryOptions {
  summary?: string;
  confidence?: number;
  challenges?: string[];
  learnings?: string[];
}

/**
 * Options for recording a decision
 */
export interface DecisionOptions {
  choice: string;
  question?: string;
  alternatives?: string[];
  reasoning?: string;
  confidence?: number;
}

/**
 * Run a trail CLI command
 */
async function runTrail(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('trail', args, {
      cwd: getProjectPaths().projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: `Failed to run trail: ${err.message}` });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() });
      } else {
        resolve({ success: false, output: stdout.trim(), error: stderr.trim() || `Exit code: ${code}` });
      }
    });
  });
}

/**
 * Check if trail CLI is available
 */
export async function isTrailAvailable(): Promise<boolean> {
  const result = await runTrail(['--version']);
  return result.success;
}

/**
 * Start a new trajectory
 */
export async function startTrajectory(options: StartTrajectoryOptions): Promise<{ success: boolean; trajectoryId?: string; error?: string }> {
  const args = ['start', options.task];

  if (options.taskId) {
    args.push('--task-id', options.taskId);
  }
  if (options.source) {
    args.push('--source', options.source);
  }
  if (options.agentName) {
    args.push('--agent', options.agentName);
  }
  if (options.phase) {
    args.push('--phase', options.phase);
  }
  args.push('--json');

  const result = await runTrail(args);
  if (result.success) {
    try {
      const data = JSON.parse(result.output);
      return { success: true, trajectoryId: data.id };
    } catch {
      return { success: true, trajectoryId: undefined };
    }
  }
  return { success: false, error: result.error };
}

/**
 * Get current trajectory status
 */
export async function getTrajectoryStatus(): Promise<{ active: boolean; trajectoryId?: string; phase?: PDEROPhase; task?: string }> {
  const result = await runTrail(['status', '--json']);
  if (result.success) {
    try {
      const data = JSON.parse(result.output);
      return {
        active: data.status === 'active',
        trajectoryId: data.id,
        phase: data.currentPhase,
        task: data.task?.title,
      };
    } catch {
      return { active: false };
    }
  }
  return { active: false };
}

/**
 * Transition to a new PDERO phase
 */
export async function transitionPhase(phase: PDEROPhase, reason?: string, agentName?: string): Promise<{ success: boolean; error?: string }> {
  const args = ['phase', phase];

  if (reason) {
    args.push('--reason', reason);
  }
  if (agentName) {
    args.push('--agent', agentName);
  }

  const result = await runTrail(args);
  return { success: result.success, error: result.error };
}

/**
 * Record a decision
 */
export async function recordDecision(options: DecisionOptions): Promise<{ success: boolean; error?: string }> {
  const args = ['decision', options.choice];

  if (options.question) {
    args.push('--question', options.question);
  }
  if (options.alternatives && options.alternatives.length > 0) {
    args.push('--alternatives', options.alternatives.join(','));
  }
  if (options.reasoning) {
    args.push('--reasoning', options.reasoning);
  }
  if (options.confidence !== undefined) {
    args.push('--confidence', options.confidence.toString());
  }

  const result = await runTrail(args);
  return { success: result.success, error: result.error };
}

/**
 * Record an event/observation
 */
export async function recordEvent(
  content: string,
  type: 'tool_call' | 'observation' | 'checkpoint' | 'error' = 'observation',
  agentName?: string
): Promise<{ success: boolean; error?: string }> {
  const args = ['event', content, '--type', type];

  if (agentName) {
    args.push('--agent', agentName);
  }

  const result = await runTrail(args);
  return { success: result.success, error: result.error };
}

/**
 * Record a message (sent or received)
 */
export async function recordMessage(
  direction: 'sent' | 'received',
  from: string,
  to: string,
  body: string
): Promise<{ success: boolean; error?: string }> {
  const content = `Message ${direction}: ${direction === 'sent' ? `→ ${to}` : `← ${from}`}: ${body.slice(0, 100)}${body.length > 100 ? '...' : ''}`;
  return recordEvent(content, 'observation');
}

/**
 * Complete the current trajectory
 */
export async function completeTrajectory(options: CompleteTrajectoryOptions = {}): Promise<{ success: boolean; error?: string }> {
  const args = ['complete'];

  if (options.summary) {
    args.push('--summary', options.summary);
  }
  if (options.confidence !== undefined) {
    args.push('--confidence', options.confidence.toString());
  }
  if (options.challenges && options.challenges.length > 0) {
    args.push('--challenges', options.challenges.join(','));
  }
  if (options.learnings && options.learnings.length > 0) {
    args.push('--learnings', options.learnings.join(','));
  }

  const result = await runTrail(args);
  return { success: result.success, error: result.error };
}

/**
 * Abandon the current trajectory
 */
export async function abandonTrajectory(reason?: string): Promise<{ success: boolean; error?: string }> {
  const args = ['abandon'];

  if (reason) {
    args.push('--reason', reason);
  }

  const result = await runTrail(args);
  return { success: result.success, error: result.error };
}

/**
 * Detect PDERO phase from content
 */
export function detectPhaseFromContent(content: string): PDEROPhase | undefined {
  const lowerContent = content.toLowerCase();

  const phasePatterns: Array<{ phase: PDEROPhase; patterns: string[] }> = [
    { phase: 'plan', patterns: ['planning', 'analyzing requirements', 'breaking down', 'creating plan', 'task list', 'todo', 'outline'] },
    { phase: 'design', patterns: ['designing', 'architecting', 'choosing pattern', 'interface design', 'schema design', 'architecture'] },
    { phase: 'execute', patterns: ['implementing', 'writing', 'coding', 'building', 'creating file', 'modifying', 'editing'] },
    { phase: 'review', patterns: ['testing', 'reviewing', 'validating', 'checking', 'verifying', 'running tests', 'test passed', 'test failed'] },
    { phase: 'observe', patterns: ['observing', 'monitoring', 'reflecting', 'documenting', 'retrospective', 'learnings', 'summary'] },
  ];

  for (const { phase, patterns } of phasePatterns) {
    for (const pattern of patterns) {
      if (lowerContent.includes(pattern)) {
        return phase;
      }
    }
  }

  return undefined;
}

/**
 * TrajectoryIntegration class for managing trajectory state
 */
export class TrajectoryIntegration {
  private projectId: string;
  private agentName: string;
  private trailAvailable: boolean | null = null;
  private currentPhase: PDEROPhase | null = null;

  constructor(projectId: string, agentName: string) {
    this.projectId = projectId;
    this.agentName = agentName;
  }

  /**
   * Check if trail is available (cached)
   */
  async isAvailable(): Promise<boolean> {
    if (this.trailAvailable === null) {
      this.trailAvailable = await isTrailAvailable();
    }
    return this.trailAvailable;
  }

  /**
   * Start tracking a trajectory
   */
  async start(task: string, taskId?: string, source?: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    const result = await startTrajectory({
      task,
      taskId,
      source,
      agentName: this.agentName,
      phase: 'plan',
    });

    if (result.success) {
      this.currentPhase = 'plan';
    }

    return result.success;
  }

  /**
   * Record a message
   */
  async message(direction: 'sent' | 'received', from: string, to: string, body: string): Promise<void> {
    if (!(await this.isAvailable())) return;

    await recordMessage(direction, from, to, body);

    // Check for phase transition based on content
    const detectedPhase = detectPhaseFromContent(body);
    if (detectedPhase && detectedPhase !== this.currentPhase) {
      await this.transition(detectedPhase, 'Auto-detected from message content');
    }
  }

  /**
   * Transition to a new phase
   */
  async transition(phase: PDEROPhase, reason?: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    if (phase === this.currentPhase) return true;

    const result = await transitionPhase(phase, reason, this.agentName);
    if (result.success) {
      this.currentPhase = phase;
    }
    return result.success;
  }

  /**
   * Record a decision
   */
  async decision(choice: string, options?: Partial<DecisionOptions>): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    const result = await recordDecision({
      choice,
      ...options,
    });
    return result.success;
  }

  /**
   * Record an event
   */
  async event(content: string, type: 'tool_call' | 'observation' | 'checkpoint' | 'error' = 'observation'): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    const result = await recordEvent(content, type, this.agentName);

    // Check for phase transition
    const detectedPhase = detectPhaseFromContent(content);
    if (detectedPhase && detectedPhase !== this.currentPhase) {
      await this.transition(detectedPhase, 'Auto-detected from event content');
    }

    return result.success;
  }

  /**
   * Complete the trajectory
   */
  async complete(options?: CompleteTrajectoryOptions): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    const result = await completeTrajectory(options);
    if (result.success) {
      this.currentPhase = null;
    }
    return result.success;
  }

  /**
   * Abandon the trajectory
   */
  async abandon(reason?: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    const result = await abandonTrajectory(reason);
    if (result.success) {
      this.currentPhase = null;
    }
    return result.success;
  }

  /**
   * Get current phase
   */
  getPhase(): PDEROPhase | null {
    return this.currentPhase;
  }
}

/**
 * Global trajectory integration instances
 */
const instances = new Map<string, TrajectoryIntegration>();

/**
 * Get or create a TrajectoryIntegration instance
 */
export function getTrajectoryIntegration(projectId: string, agentName: string): TrajectoryIntegration {
  const key = `${projectId}:${agentName}`;
  let instance = instances.get(key);
  if (!instance) {
    instance = new TrajectoryIntegration(projectId, agentName);
    instances.set(key, instance);
  }
  return instance;
}
