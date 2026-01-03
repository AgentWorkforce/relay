/**
 * Stuck Agent Detection
 *
 * Detects when an agent has received a message but hasn't responded
 * within a configurable threshold. This helps surface when agents
 * are blocked or crashed mid-response.
 */

import type { Agent } from '../types';

/** Default threshold in milliseconds (5 minutes) */
export const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60 * 1000;

export interface StuckDetectionOptions {
  /** Threshold in milliseconds before considering an agent stuck */
  thresholdMs?: number;
}

/**
 * Check if an agent is stuck (received message but no output within threshold)
 *
 * An agent is considered stuck when:
 * 1. It has received a message (lastMessageReceivedAt is set)
 * 2. It hasn't produced output since receiving that message
 *    (lastOutputAt < lastMessageReceivedAt or lastOutputAt is not set)
 * 3. The time since receiving the message exceeds the threshold
 *
 * @param agent - The agent to check
 * @param options - Detection options
 * @returns true if the agent is stuck
 */
export function isAgentStuck(
  agent: Agent,
  options: StuckDetectionOptions = {}
): boolean {
  const { thresholdMs = DEFAULT_STUCK_THRESHOLD_MS } = options;
  const now = Date.now();

  // No message received, can't be stuck waiting for response
  if (!agent.lastMessageReceivedAt) {
    return false;
  }

  // Agent has output after receiving the message - not stuck
  if (agent.lastOutputAt && agent.lastOutputAt >= agent.lastMessageReceivedAt) {
    return false;
  }

  // Check if threshold has been exceeded
  const timeSinceMessage = now - agent.lastMessageReceivedAt;
  return timeSinceMessage > thresholdMs;
}

/**
 * Calculate how long an agent has been stuck (in milliseconds)
 *
 * @param agent - The agent to check
 * @returns Time stuck in ms, or 0 if not stuck
 */
export function getStuckDuration(agent: Agent): number {
  if (!agent.lastMessageReceivedAt) {
    return 0;
  }

  // Has output after message - not stuck
  if (agent.lastOutputAt && agent.lastOutputAt >= agent.lastMessageReceivedAt) {
    return 0;
  }

  return Date.now() - agent.lastMessageReceivedAt;
}

/**
 * Format stuck duration for display
 *
 * @param durationMs - Duration in milliseconds
 * @returns Human-readable string like "5m" or "1h 30m"
 */
export function formatStuckDuration(durationMs: number): string {
  if (durationMs < 60000) {
    return '<1m';
  }

  const minutes = Math.floor(durationMs / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Enrich agents with stuck detection status
 *
 * @param agents - Array of agents to process
 * @param options - Detection options
 * @returns Agents with isStuck field computed
 */
export function enrichAgentsWithStuckStatus(
  agents: Agent[],
  options: StuckDetectionOptions = {}
): Agent[] {
  return agents.map((agent) => ({
    ...agent,
    isStuck: isAgentStuck(agent, options),
  }));
}

/**
 * Get agents that are currently stuck
 *
 * @param agents - Array of agents to filter
 * @param options - Detection options
 * @returns Only the stuck agents
 */
export function getStuckAgents(
  agents: Agent[],
  options: StuckDetectionOptions = {}
): Agent[] {
  return agents.filter((agent) => isAgentStuck(agent, options));
}

/**
 * Get stuck agent count
 *
 * @param agents - Array of agents to check
 * @param options - Detection options
 * @returns Number of stuck agents
 */
export function getStuckCount(
  agents: Agent[],
  options: StuckDetectionOptions = {}
): number {
  return agents.filter((agent) => isAgentStuck(agent, options)).length;
}
