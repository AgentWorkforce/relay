/**
 * Agent Registry (public entrypoint)
 * Persists agent metadata across daemon restarts.
 *
 * This file mirrors docs/TMUX_IMPROVEMENTS.md guidance and re-exports the
 * implementation from agent-registry.ts so both import paths work.
 */
export { AgentRegistry, type AgentRecord } from './agent-registry.js';
