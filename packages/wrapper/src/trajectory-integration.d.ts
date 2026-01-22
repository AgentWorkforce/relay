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
 * Check if trail CLI is available
 */
export declare function isTrailAvailable(): Promise<boolean>;
/**
 * Start a new trajectory
 */
export declare function startTrajectory(options: StartTrajectoryOptions): Promise<{
    success: boolean;
    trajectoryId?: string;
    error?: string;
}>;
/**
 * Get current trajectory status
 * Reads directly from .trajectories/index.json instead of using CLI
 */
export declare function getTrajectoryStatus(): Promise<{
    active: boolean;
    trajectoryId?: string;
    phase?: PDEROPhase;
    task?: string;
}>;
/**
 * Transition to a new PDERO phase
 */
export declare function transitionPhase(phase: PDEROPhase, reason?: string, agentName?: string): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Record a decision
 */
export declare function recordDecision(options: DecisionOptions): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Record an event/observation
 */
export declare function recordEvent(content: string, type?: 'tool_call' | 'observation' | 'checkpoint' | 'error', agentName?: string): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Record a message (sent or received)
 */
export declare function recordMessage(direction: 'sent' | 'received', from: string, to: string, body: string): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Complete the current trajectory
 */
export declare function completeTrajectory(options?: CompleteTrajectoryOptions): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Abandon the current trajectory
 */
export declare function abandonTrajectory(reason?: string): Promise<{
    success: boolean;
    error?: string;
}>;
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
export declare function listTrajectorySteps(trajectoryId?: string): Promise<{
    success: boolean;
    steps: TrajectoryStepData[];
    error?: string;
}>;
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
export declare function getTrajectoryHistory(): Promise<{
    success: boolean;
    trajectories: TrajectoryHistoryEntry[];
    error?: string;
}>;
/**
 * Detect PDERO phase from content
 */
export declare function detectPhaseFromContent(content: string): PDEROPhase | undefined;
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
 * Detect tool calls from agent output
 *
 * @example
 * ```typescript
 * const tools = detectToolCalls(output);
 * // Returns: [{ tool: 'Read', args: 'file.ts' }, { tool: 'Bash', status: 'completed' }]
 * ```
 */
export declare function detectToolCalls(content: string): DetectedToolCall[];
/**
 * Detect errors from agent output
 *
 * @example
 * ```typescript
 * const errors = detectErrors(output);
 * // Returns: [{ type: 'error', message: 'TypeError: Cannot read property...' }]
 * ```
 */
export declare function detectErrors(content: string): DetectedError[];
/**
 * TrajectoryIntegration class for managing trajectory state
 *
 * This class enforces trajectory tracking during agent lifecycle:
 * - Auto-starts trajectory when agent is instantiated with a task
 * - Records all inter-agent messages
 * - Auto-detects PDERO phase transitions
 * - Provides lifecycle hooks for tmux/pty wrappers
 */
export declare class TrajectoryIntegration {
    private projectId;
    private agentName;
    private trailAvailable;
    private currentPhase;
    private trajectoryId;
    private initialized;
    private task;
    constructor(projectId: string, agentName: string);
    /**
     * Check if trail is available (cached)
     */
    isAvailable(): Promise<boolean>;
    /**
     * Check if trail CLI is installed synchronously
     */
    isTrailInstalledSync(): boolean;
    /**
     * Initialize trajectory tracking for agent lifecycle
     * Called automatically when agent starts with a task
     */
    initialize(task?: string, taskId?: string, source?: string): Promise<boolean>;
    /**
     * Start tracking a trajectory
     */
    start(task: string, taskId?: string, source?: string): Promise<boolean>;
    /**
     * Check if there's an active trajectory
     */
    hasActiveTrajectory(): boolean;
    /**
     * Get the current task
     */
    getTask(): string | null;
    /**
     * Get trajectory ID
     */
    getTrajectoryId(): string | null;
    /**
     * Record a message
     */
    message(direction: 'sent' | 'received', from: string, to: string, body: string): Promise<void>;
    /**
     * Transition to a new phase
     */
    transition(phase: PDEROPhase, reason?: string): Promise<boolean>;
    /**
     * Record a decision
     */
    decision(choice: string, options?: Partial<DecisionOptions>): Promise<boolean>;
    /**
     * Record an event
     */
    event(content: string, type?: 'tool_call' | 'observation' | 'checkpoint' | 'error'): Promise<boolean>;
    /**
     * Complete the trajectory
     */
    complete(options?: CompleteTrajectoryOptions): Promise<boolean>;
    /**
     * Abandon the trajectory
     */
    abandon(reason?: string): Promise<boolean>;
    /**
     * Get current phase
     */
    getPhase(): PDEROPhase | null;
}
/**
 * Get or create a TrajectoryIntegration instance
 */
export declare function getTrajectoryIntegration(projectId: string, agentName: string): TrajectoryIntegration;
/**
 * Generate trail usage instructions for agents
 */
export declare function getTrailInstructions(): string[];
/**
 * Get a compact trail instruction string for injection
 */
export declare function getCompactTrailInstructions(): string;
/**
 * Get environment variables for trail CLI
 * If dataDir is not provided, uses config-based storage location
 */
export declare function getTrailEnvVars(projectId: string, agentName: string, dataDir?: string): Record<string, string>;
//# sourceMappingURL=trajectory-integration.d.ts.map