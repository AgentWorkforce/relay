/**
 * Trajectory Hooks
 *
 * Provides trajectory tracking hooks that integrate with the PDERO paradigm.
 * These hooks automatically track agent work when registered with a HookRegistry.
 */

import type {
  LifecycleHooks,
  SessionStartContext,
  SessionEndContext,
  OutputContext,
  MessageReceivedContext,
  MessageSentContext,
  HookResult,
} from './types.js';
import {
  TrajectoryIntegration,
  getTrajectoryIntegration,
  detectPhaseFromContent,
  getCompactTrailInstructions,
  type PDEROPhase,
} from '../trajectory/integration.js';

/**
 * Options for trajectory hooks
 */
export interface TrajectoryHooksOptions {
  /** Project identifier */
  projectId: string;
  /** Agent name */
  agentName: string;
  /** Whether to auto-detect phase transitions */
  autoDetectPhase?: boolean;
  /** Whether to inject trail instructions on session start */
  injectInstructions?: boolean;
  /** Whether to prompt for retrospective on session end */
  promptRetrospective?: boolean;
}

/**
 * State for trajectory hooks
 */
interface TrajectoryHooksState {
  trajectory: TrajectoryIntegration;
  lastDetectedPhase?: PDEROPhase;
  options: TrajectoryHooksOptions;
}

/**
 * Create trajectory hooks for automatic PDERO tracking
 *
 * @example
 * ```typescript
 * const hooks = createTrajectoryHooks({
 *   projectId: 'my-project',
 *   agentName: 'Alice',
 * });
 *
 * registry.registerLifecycleHooks(hooks);
 * ```
 */
export function createTrajectoryHooks(options: TrajectoryHooksOptions): LifecycleHooks {
  const state: TrajectoryHooksState = {
    trajectory: getTrajectoryIntegration(options.projectId, options.agentName),
    options: {
      autoDetectPhase: true,
      injectInstructions: true,
      promptRetrospective: true,
      ...options,
    },
  };

  return {
    onSessionStart: createSessionStartHook(state),
    onSessionEnd: createSessionEndHook(state),
    onOutput: createOutputHook(state),
    onMessageReceived: createMessageReceivedHook(state),
    onMessageSent: createMessageSentHook(state),
  };
}

/**
 * Session start hook - initializes trajectory tracking
 */
function createSessionStartHook(state: TrajectoryHooksState) {
  return async (ctx: SessionStartContext): Promise<HookResult | void> => {
    const { trajectory, options } = state;

    // Initialize trajectory with task if provided
    if (ctx.task) {
      const success = await trajectory.initialize(ctx.task, ctx.taskId, ctx.taskSource);
      if (success) {
        console.log(`[trajectory] Started tracking: ${ctx.task}`);
      }
    } else {
      await trajectory.initialize();
    }

    // Inject trail instructions if enabled and trail is available
    if (options.injectInstructions && trajectory.isTrailInstalledSync()) {
      const instructions = getCompactTrailInstructions();
      return { inject: `\n${instructions}\n` };
    }
  };
}

/**
 * Session end hook - completes or abandons trajectory
 */
function createSessionEndHook(state: TrajectoryHooksState) {
  return async (ctx: SessionEndContext): Promise<HookResult | void> => {
    const { trajectory, options } = state;

    if (!trajectory.hasActiveTrajectory()) {
      return;
    }

    if (ctx.graceful) {
      // Prompt for retrospective if enabled
      if (options.promptRetrospective) {
        const durationSeconds = Math.round(ctx.duration / 1000);
        const result: HookResult = {
          inject: `
[SESSION ENDING]
Complete your trajectory with a summary:
  trail complete --summary "What you accomplished" --confidence 0.9

Or if you need to document learnings:
  trail decision "Key choice" --reasoning "Why"
`,
        };

        // Also complete the trajectory
        await trajectory.complete({
          summary: `Session ended after ${durationSeconds}s`,
        });

        return result;
      } else {
        await trajectory.complete({
          summary: `Session ended gracefully`,
        });
      }
    } else {
      await trajectory.abandon('Session terminated');
    }
  };
}

/**
 * Output hook - auto-detects PDERO phase transitions
 */
function createOutputHook(state: TrajectoryHooksState) {
  return async (ctx: OutputContext): Promise<HookResult | void> => {
    const { trajectory, options } = state;

    if (!options.autoDetectPhase) {
      return;
    }

    const detectedPhase = detectPhaseFromContent(ctx.content);

    if (detectedPhase && detectedPhase !== state.lastDetectedPhase) {
      state.lastDetectedPhase = detectedPhase;
      await trajectory.transition(detectedPhase, 'Auto-detected from output');
    }
  };
}

/**
 * Message received hook - records incoming messages
 */
function createMessageReceivedHook(state: TrajectoryHooksState) {
  return async (ctx: MessageReceivedContext): Promise<HookResult | void> => {
    const { trajectory, options } = state;

    await trajectory.message('received', ctx.from, options.agentName, ctx.body);
  };
}

/**
 * Message sent hook - records outgoing messages
 */
function createMessageSentHook(state: TrajectoryHooksState) {
  return async (ctx: MessageSentContext): Promise<HookResult | void> => {
    const { trajectory, options } = state;

    await trajectory.message('sent', options.agentName, ctx.to, ctx.body);
  };
}

/**
 * Get trajectory hooks for a project/agent combination
 *
 * This is a convenience function that creates trajectory hooks
 * with default options.
 */
export function getTrajectoryHooks(projectId: string, agentName: string): LifecycleHooks {
  return createTrajectoryHooks({ projectId, agentName });
}

/**
 * Utility to check if trajectory tracking is available
 */
export function isTrajectoryTrackingAvailable(projectId: string, agentName: string): boolean {
  const trajectory = getTrajectoryIntegration(projectId, agentName);
  return trajectory.isTrailInstalledSync();
}
