/**
 * Agent Relay
 * Real-time agent-to-agent communication system.
 */

export * from './protocol/index.js';
export * from './daemon/index.js';
export * from './wrapper/index.js';
export * from './utils/index.js';

// Storage types for external consumers (e.g., agent-trajectories)
export {
  type StoredMessage,
  type MessageQuery,
  type StorageAdapter,
  type StorageConfig,
} from './storage/adapter.js';
