/**
 * @agent-relay/api-types
 *
 * Shared API types and Zod schemas for Agent Relay.
 * Provides type-safe API contracts between frontend and backend.
 *
 * @example
 * ```typescript
 * import { AgentSchema, type Agent } from '@agent-relay/api-types';
 *
 * // Validate API response
 * const agent = AgentSchema.parse(response.data);
 *
 * // Use inferred type
 * function displayAgent(agent: Agent) {
 *   console.log(agent.name, agent.status);
 * }
 * ```
 */

// Re-export all schemas and types
export * from './schemas/index.js';
