/**
 * @relay/daemon
 *
 * Relay daemon server - agent coordination and message routing.
 *
 * This package provides the core daemon infrastructure for:
 * - Per-project agent communication via RelayServer
 * - Message routing between agents
 * - Connection management and heartbeat
 * - Agent registry for discovery
 * - Multi-workspace orchestration (dashboard-first mode)
 * - Enhanced features (consensus, signing, reliability)
 */

// Core daemon infrastructure (per-project)
export * from './server.js';
export * from './router.js';
export * from './connection.js';
export * from './agent-registry.js';
export * from './registry.js';

// Multi-workspace orchestrator (dashboard-first)
export * from './types.js';
export * from './orchestrator.js';
export * from './workspace-manager.js';
export * from './agent-manager.js';

// Enhanced features (performance, reliability, coordination)
export * from './enhanced-features.js';
export * from './agent-signing.js';
export * from './consensus.js';
export * from './consensus-integration.js';

// CLI authentication (OAuth flows for workspace CLIs)
export {
  startCLIAuth,
  getAuthSession,
  cancelAuthSession,
  submitAuthCode,
  completeAuthSession,
  getSupportedProviders,
  type CLIAuthConfig,
  type PromptHandler,
  type StartCLIAuthOptions,
} from './cli-auth.js';

// Relay file watchdog (file-based message detection and processing)
export * from './relay-ledger.js';
export * from './relay-watchdog.js';

// Spawn manager (protocol-based agent spawning)
export { SpawnManager, type SpawnManagerConfig } from './spawn-manager.js';
