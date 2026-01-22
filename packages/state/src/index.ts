/**
 * @relay/state
 *
 * Agent state persistence for non-hook CLIs (Codex, Gemini, etc.)
 * Provides state management between agent spawns.
 */

export {
  AgentStateManager,
  parseStateFromOutput,
  type AgentState,
} from './agent-state.js';
