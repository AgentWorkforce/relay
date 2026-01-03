/**
 * Agent Relay
 * Real-time agent-to-agent communication system.
 */

export * from './protocol/index.js';
export * from './daemon/index.js';
export * from './wrapper/index.js';
export * from './utils/index.js';
export * from './hooks/index.js';

// Storage types for external consumers (e.g., agent-trajectories)
export {
  type StoredMessage,
  type MessageQuery,
  type StorageAdapter,
  type StorageConfig,
} from './storage/adapter.js';

// Memory types and adapters for external consumers
export {
  type MemoryAdapter,
  type MemoryEntry,
  type MemoryConfig,
  type MemoryService,
  type MemorySearchQuery,
  type AddMemoryOptions,
  type MemoryResult,
  createMemoryAdapter,
  createMemoryService,
  createMemoryHooks,
  getMemoryHooks,
  InMemoryAdapter,
  SupermemoryAdapter,
} from './memory/index.js';
