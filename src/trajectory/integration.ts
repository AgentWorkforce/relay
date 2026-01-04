/**
 * Trajectory Integration Module
 *
 * Integrates with the agent-trajectories package to provide
 * PDERO paradigm tracking within agent-relay.
 *
 * This module provides a bridge between agent-relay and the
 * external `trail` CLI / agent-trajectories library.
 *
 * Key integration points:
 * - Auto-starts trajectory when agent is instantiated with a task
 * - Records all inter-agent messages
 * - Auto-detects PDERO phase transitions from output
 * - Provides hooks for key agent lifecycle events
 */

import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectPaths } from '../utils/project-namespace.js';
import {
  getPrimaryTrajectoriesDir,
  getAllTrajectoriesDirs,
  getTrajectoryEnvVars,
} from './config.js';

/**
 * Trajectory index file structure
 */
interface TrajectoryIndexEntry {
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  path: string;
}

interface TrajectoryIndex {
  version: number;
  lastUpdated: string;
  trajectories: Record<string, TrajectoryIndexEntry>;
}

/**
 * Full trajectory file structure
 */
interface TrajectoryFile {
  id: string;
  version: number;
  task: {
    title: string;
    source?: { system: string; id: string };
  };
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  agents: Array<{ name: string; role: string; joinedAt: string }>;
  chapters: Array<{
    id: string;
    title: string;
    agentName: string;
    startedAt: string;
    endedAt?: string;
    events: Array<{
      ts: number;
      type: string;
      content: string;
      raw?: Record<string, unknown>;
      significance?: string;
    }>;
  }>;
  retrospective?: {
    summary: string;
    approach: string;
    confidence: number;
  };
}

/**
 * Read a single trajectory index file from a directory
 */
function readSingleTrajectoryIndex(trajectoriesDir: string): TrajectoryIndex | null {
  try {
    const indexPath = join(trajectoriesDir, 'index.json');
    if (!existsSync(indexPath)) {
      return null;
    }
    const content = readFileSync(indexPath, 'utf-8');
    return JSON.parse(content) as TrajectoryIndex;
  } catch {
    return null;
  }
}

/**
 * Read and merge trajectory indexes from all locations (repo + user-level)
 * This allows reading trajectories from both places
 */
function readTrajectoryIndex(): TrajectoryIndex | null {
  const dirs = getAllTrajectoriesDirs();

  if (dirs.length === 0) {
    return null;
  }

  // Read and merge all indexes
  let mergedIndex: TrajectoryIndex | null = null;

  for (const dir of dirs) {
    const index = readSingleTrajectoryIndex(dir);
    if (!index) continue;

    if (!mergedIndex) {
      mergedIndex = index;
    } else {
      // Merge trajectories, preferring more recent entries
      for (const [id, entry] of Object.entries(index.trajectories)) {
        const existing = mergedIndex.trajectories[id];
        if (!existing) {
          mergedIndex.trajectories[id] = entry;
        } else {
          // Keep the more recently updated one
          const existingTime = new Date(existing.completedAt || existing.startedAt).getTime();
          const newTime = new Date(entry.completedAt || entry.startedAt).getTime();
          if (newTime > existingTime) {
            mergedIndex.trajectories[id] = entry;
          }
        }
      }
      // Update lastUpdated to most recent
      if (new Date(index.lastUpdated) > new Date(mergedIndex.lastUpdated)) {
        mergedIndex.lastUpdated = index.lastUpdated;
      }
    }
  }

  return mergedIndex;
}

/**
 * Read a specific trajectory file directly from filesystem
 */
function readTrajectoryFile(trajectoryPath: string): TrajectoryFile | null {
  try {
    if (!existsSync(trajectoryPath)) {
      return null;
    }
    const content = readFileSync(trajectoryPath, 'utf-8');
    return JSON.parse(content) as TrajectoryFile;
  } catch {
    return null;
  }
}

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
 * Uses config-based environment to control trajectory storage location
 */
async function runTrail(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    // Get trajectory env vars to set correct storage location
    const trajectoryEnv = getTrajectoryEnvVars();

    const proc = spawn('trail', args, {
      cwd: getProjectPaths().projectRoot,
      env: { ...process.env, ...trajectoryEnv },
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

  const result = await runTrail(args);
  if (result.success) {
    // Parse trajectory ID from output like "✓ Trajectory started: traj_xxx"
    const match = result.output.match(/traj_[a-z0-9]+/i);
    return { success: true, trajectoryId: match?.[0] };
  }
  return { success: false, error: result.error };
}

/**
 * Get current trajectory status
 * Reads directly from .trajectories/index.json instead of using CLI
 */
export async function getTrajectoryStatus(): Promise<{ active: boolean; trajectoryId?: string; phase?: PDEROPhase; task?: string }> {
  const index = readTrajectoryIndex();
  if (!index) {
    return { active: false };
  }

  // Find an active trajectory
  for (const [id, entry] of Object.entries(index.trajectories)) {
    if (entry.status === 'active') {
      // Read the full trajectory file to get phase info
      const trajectory = readTrajectoryFile(entry.path);
      let currentPhase: PDEROPhase | undefined;

      if (trajectory?.chapters?.length) {
        const lastChapter = trajectory.chapters[trajectory.chapters.length - 1];
        // Check events for phase transitions
        for (const event of [...(lastChapter.events || [])].reverse()) {
          if (event.type === 'phase_transition' || event.type === 'phase') {
            const phaseMatch = event.content?.match(/phase[:\s]+(\w+)/i);
            if (phaseMatch) {
              currentPhase = phaseMatch[1].toLowerCase() as PDEROPhase;
              break;
            }
          }
        }
      }

      return {
        active: true,
        trajectoryId: id,
        phase: currentPhase,
        task: entry.title,
      };
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
 * Trajectory step for dashboard display
 */
export interface TrajectoryStepData {
  id: string;
  timestamp: string | number;
  type: 'tool_call' | 'decision' | 'message' | 'state_change' | 'error' | 'phase_transition';
  phase?: PDEROPhase;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  duration?: number;
  status?: 'pending' | 'running' | 'success' | 'error';
}

/**
 * List trajectory steps/events
 * Returns steps for the current or specified trajectory
 * Reads directly from filesystem instead of using CLI
 */
export async function listTrajectorySteps(trajectoryId?: string): Promise<{
  success: boolean;
  steps: TrajectoryStepData[];
  error?: string;
}> {
  const index = readTrajectoryIndex();
  if (!index) {
    return { success: true, steps: [] };
  }

  // Find the trajectory to load
  let trajectoryPath: string | undefined;

  if (trajectoryId) {
    // Use specified trajectory
    const entry = index.trajectories[trajectoryId];
    if (entry) {
      trajectoryPath = entry.path;
    }
  } else {
    // Find active trajectory
    for (const [_id, entry] of Object.entries(index.trajectories)) {
      if (entry.status === 'active') {
        trajectoryPath = entry.path;
        break;
      }
    }
  }

  if (!trajectoryPath) {
    return { success: true, steps: [] };
  }

  const trajectory = readTrajectoryFile(trajectoryPath);
  if (!trajectory) {
    return { success: true, steps: [] };
  }

  // Extract events from all chapters
  const steps: TrajectoryStepData[] = [];
  let stepIndex = 0;

  for (const chapter of trajectory.chapters || []) {
    for (const event of chapter.events || []) {
      steps.push({
        id: `step-${stepIndex++}`,
        timestamp: event.ts || Date.now(),
        type: mapEventType(event.type),
        title: event.content?.slice(0, 50) || event.type || 'Event',
        description: event.content,
        metadata: event.raw,
        status: mapEventStatus(trajectory.status),
      });
    }
  }

  return { success: true, steps };
}

/**
 * Trajectory history entry for dashboard display
 */
export interface TrajectoryHistoryEntry {
  id: string;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  agents?: string[];
  summary?: string;
  confidence?: number;
}

/**
 * Get trajectory history - list all trajectories
 * Reads directly from filesystem
 */
export async function getTrajectoryHistory(): Promise<{
  success: boolean;
  trajectories: TrajectoryHistoryEntry[];
  error?: string;
}> {
  const index = readTrajectoryIndex();
  if (!index) {
    return { success: true, trajectories: [] };
  }

  const trajectories: TrajectoryHistoryEntry[] = [];

  for (const [id, entry] of Object.entries(index.trajectories)) {
    const historyEntry: TrajectoryHistoryEntry = {
      id,
      title: entry.title,
      status: entry.status,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    };

    // Try to read full trajectory for additional details
    if (entry.path) {
      const trajectory = readTrajectoryFile(entry.path);
      if (trajectory) {
        historyEntry.agents = trajectory.agents?.map(a => a.name);
        if (trajectory.retrospective) {
          historyEntry.summary = trajectory.retrospective.summary;
          historyEntry.confidence = trajectory.retrospective.confidence;
        }
      }
    }

    trajectories.push(historyEntry);
  }

  // Sort by startedAt descending (most recent first)
  trajectories.sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  return { success: true, trajectories };
}

/**
 * Map trail event type to dashboard type
 */
function mapEventType(type?: string): TrajectoryStepData['type'] {
  switch (type?.toLowerCase()) {
    case 'tool':
    case 'tool_call':
    case 'tool_use':
      return 'tool_call';
    case 'decision':
    case 'choice':
      return 'decision';
    case 'message':
    case 'observation':
      return 'message';
    case 'phase':
    case 'phase_change':
    case 'phase_transition':
      return 'phase_transition';
    case 'error':
    case 'failure':
      return 'error';
    default:
      return 'state_change';
  }
}

/**
 * Map trail status to dashboard status
 */
function mapEventStatus(status?: string): TrajectoryStepData['status'] | undefined {
  switch (status?.toLowerCase()) {
    case 'running':
    case 'in_progress':
    case 'active':
      return 'running';
    case 'success':
    case 'completed':
    case 'done':
      return 'success';
    case 'error':
    case 'failed':
    case 'abandoned':
      return 'error';
    case 'pending':
    case 'queued':
      return 'pending';
    default:
      return undefined;
  }
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
 * Detected tool call information
 */
export interface DetectedToolCall {
  tool: string;
  args?: string;
  status?: 'started' | 'completed' | 'failed';
}

/**
 * Detected error information
 */
export interface DetectedError {
  type: 'error' | 'warning' | 'failure';
  message: string;
  stack?: string;
}

/**
 * All known Claude Code tool names
 */
const TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'TaskOutput',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'AskUserQuestion',
  'KillShell', 'EnterPlanMode', 'ExitPlanMode', 'Skill', 'SlashCommand',
];

const TOOL_NAME_PATTERN = TOOL_NAMES.join('|');

/**
 * Tool call patterns for Claude Code and similar AI CLIs
 */
const TOOL_PATTERNS = [
  // Claude Code tool invocations (displayed in output with parenthesis/braces)
  new RegExp(`(?:^|\\n)\\s*(?:${TOOL_NAME_PATTERN})\\s*[({]`, 'i'),
  // Tool completion markers (checkmarks, spinners)
  new RegExp(`(?:^|\\n)\\s*(?:✓|✔|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\\s*(${TOOL_NAME_PATTERN})`, 'i'),
  // Function call patterns (explicit mentions)
  new RegExp(`(?:^|\\n)\\s*(?:Calling|Using|Invoking)\\s+(?:tool\\s+)?['"]?(${TOOL_NAME_PATTERN})['"]?`, 'i'),
  // Tool result patterns
  new RegExp(`(?:^|\\n)\\s*(?:Tool result|Result from)\\s*:?\\s*(${TOOL_NAME_PATTERN})`, 'i'),
];

/**
 * Error patterns for detecting failures in output
 * Note: Patterns are ordered from most specific to least specific
 */
const ERROR_PATTERNS = [
  // JavaScript/TypeScript runtime errors (most specific)
  /(?:^|\n)((?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError):\s*.+)/i,
  // Named Error with message (e.g., "Error: Something went wrong")
  /(?:^|\n)(Error:\s+.+)/,
  // Failed assertions
  /(?:^|\n)\s*(AssertionError:\s*.+)/i,
  // Test failures (Vitest, Jest patterns)
  /(?:^|\n)\s*(FAIL\s+\S+\.(?:ts|js|tsx|jsx))/i,
  /(?:^|\n)\s*(✗|✘|×)\s+(.+)/,
  // Command/process failures
  /(?:^|\n)\s*(Command failed[^\n]+)/i,
  /(?:^|\n)\s*((?:Exit|exit)\s+code[:\s]+[1-9]\d*)/i,
  /(?:^|\n)\s*(exited with (?:code\s+)?[1-9]\d*)/i,
  // Node.js/system errors
  /(?:^|\n)\s*(EACCES|EPERM|ENOENT|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)(?::\s*.+)?/,
  // Build/compile errors (webpack, tsc, etc.)
  /(?:^|\n)\s*(error TS\d+:\s*.+)/i,
  /(?:^|\n)\s*(error\[\S+\]:\s*.+)/i,
];

/**
 * Warning patterns for detecting potential issues
 */
const WARNING_PATTERNS = [
  /(?:^|\n)\s*(?:warning|WARN|⚠️?)\s*[:\[]?\s*(.+)/i,
  /(?:^|\n)\s*(?:deprecated|DEPRECATED):\s*(.+)/i,
];

/**
 * Detect tool calls from agent output
 *
 * @example
 * ```typescript
 * const tools = detectToolCalls(output);
 * // Returns: [{ tool: 'Read', args: 'file.ts' }, { tool: 'Bash', status: 'completed' }]
 * ```
 */
export function detectToolCalls(content: string): DetectedToolCall[] {
  const detected: DetectedToolCall[] = [];
  const seenTools = new Set<string>();
  const toolNameExtractor = new RegExp(`\\b(${TOOL_NAME_PATTERN})\\b`, 'i');

  for (const pattern of TOOL_PATTERNS) {
    const matches = content.matchAll(new RegExp(pattern.source, 'gi'));
    for (const match of matches) {
      // Extract tool name from the match
      const fullMatch = match[0];
      const toolNameMatch = fullMatch.match(toolNameExtractor);
      if (toolNameMatch) {
        const tool = toolNameMatch[1];
        // Avoid duplicates by position (same tool at same position)
        const key = `${tool}:${match.index}`;
        if (!seenTools.has(key)) {
          seenTools.add(key);
          detected.push({
            tool,
            status: fullMatch.includes('✓') || fullMatch.includes('✔') ? 'completed' : 'started',
          });
        }
      }
    }
  }

  return detected;
}

/**
 * Detect errors from agent output
 *
 * @example
 * ```typescript
 * const errors = detectErrors(output);
 * // Returns: [{ type: 'error', message: 'TypeError: Cannot read property...' }]
 * ```
 */
export function detectErrors(content: string): DetectedError[] {
  const detected: DetectedError[] = [];
  const seenMessages = new Set<string>();

  // Check for error patterns
  for (const pattern of ERROR_PATTERNS) {
    const matches = content.matchAll(new RegExp(pattern, 'gi'));
    for (const match of matches) {
      const message = match[1] || match[0];
      const cleanMessage = message.trim().slice(0, 200); // Limit length
      if (!seenMessages.has(cleanMessage)) {
        seenMessages.add(cleanMessage);
        detected.push({
          type: 'error',
          message: cleanMessage,
        });
      }
    }
  }

  // Check for warning patterns
  for (const pattern of WARNING_PATTERNS) {
    const matches = content.matchAll(new RegExp(pattern, 'gi'));
    for (const match of matches) {
      const message = match[1] || match[0];
      const cleanMessage = message.trim().slice(0, 200);
      if (!seenMessages.has(cleanMessage)) {
        seenMessages.add(cleanMessage);
        detected.push({
          type: 'warning',
          message: cleanMessage,
        });
      }
    }
  }

  return detected;
}

/**
 * TrajectoryIntegration class for managing trajectory state
 *
 * This class enforces trajectory tracking during agent lifecycle:
 * - Auto-starts trajectory when agent is instantiated with a task
 * - Records all inter-agent messages
 * - Auto-detects PDERO phase transitions
 * - Provides lifecycle hooks for tmux/pty wrappers
 */
export class TrajectoryIntegration {
  private projectId: string;
  private agentName: string;
  private trailAvailable: boolean | null = null;
  private currentPhase: PDEROPhase | null = null;
  private trajectoryId: string | null = null;
  private initialized = false;
  private task: string | null = null;

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
   * Check if trail CLI is installed synchronously
   */
  isTrailInstalledSync(): boolean {
    try {
      execSync('which trail', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize trajectory tracking for agent lifecycle
   * Called automatically when agent starts with a task
   */
  async initialize(task?: string, taskId?: string, source?: string): Promise<boolean> {
    if (this.initialized) return true;

    if (!(await this.isAvailable())) {
      return false;
    }

    // If task provided, auto-start trajectory
    if (task) {
      const success = await this.start(task, taskId, source);
      if (success) {
        this.initialized = true;
        this.task = task;
      }
      return success;
    }

    this.initialized = true;
    return true;
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
      this.trajectoryId = result.trajectoryId || null;
      this.task = task;
    }

    return result.success;
  }

  /**
   * Check if there's an active trajectory
   */
  hasActiveTrajectory(): boolean {
    return this.currentPhase !== null;
  }

  /**
   * Get the current task
   */
  getTask(): string | null {
    return this.task;
  }

  /**
   * Get trajectory ID
   */
  getTrajectoryId(): string | null {
    return this.trajectoryId;
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

/**
 * Generate trail usage instructions for agents
 */
export function getTrailInstructions(): string[] {
  return [
    '📍 TRAJECTORY TRACKING (PDERO Paradigm)',
    '',
    'You MUST use trail commands to track your work:',
    '',
    'PHASES: plan → design → execute → review → observe',
    '',
    'COMMANDS:',
    '  trail start "task"           Start trajectory for a task',
    '  trail phase <phase>          Transition to new phase',
    '  trail decision "choice"      Record key decisions',
    '  trail event "what happened"  Log significant events',
    '  trail complete               Complete with summary',
    '',
    'WHEN TO USE:',
    '  - Start: At beginning of any task',
    '  - Phase: When shifting focus (planning→implementing, etc.)',
    '  - Decision: For architecture/approach choices',
    '  - Event: For tool calls, errors, milestones',
    '  - Complete: When task is done',
    '',
    'Example workflow:',
    '  trail start "Implement auth feature"',
    '  trail phase design',
    '  trail decision "Use JWT" --reasoning "Stateless, scalable"',
    '  trail phase execute',
    '  trail event "Created auth middleware"',
    '  trail phase review',
    '  trail event "All tests passing"',
    '  trail complete --summary "Auth implemented" --confidence 0.9',
  ];
}

/**
 * Get a compact trail instruction string for injection
 */
export function getCompactTrailInstructions(): string {
  return [
    '[TRAIL] Track work with PDERO: plan→design→execute→review→observe.',
    'Commands: trail start "task" | trail phase <phase> | trail decision "choice" | trail event "log" | trail complete',
    'Use trail often to document your thought process.',
  ].join(' ');
}

/**
 * Get environment variables for trail CLI
 * If dataDir is not provided, uses config-based storage location
 */
export function getTrailEnvVars(projectId: string, agentName: string, dataDir?: string): Record<string, string> {
  // Use config-based path if dataDir not explicitly provided
  const effectiveDataDir = dataDir ?? getPrimaryTrajectoriesDir();

  return {
    TRAJECTORIES_PROJECT: projectId,
    TRAJECTORIES_DATA_DIR: effectiveDataDir,
    TRAJECTORIES_AGENT: agentName,
    TRAIL_AUTO_PHASE: '1', // Enable auto phase detection
  };
}
