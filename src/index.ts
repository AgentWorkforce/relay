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
} from '@agent-relay/storage/adapter';

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
  // Context compaction
  ContextCompactor,
  createContextCompactor,
  estimateTokens,
  estimateContextTokens,
  type CompactionConfig,
  type CompactionResult,
} from './memory/index.js';

// Dead Letter Queue adapters
export {
  type DLQStorageAdapter,
  type DeadLetter,
  type DLQConfig,
  type DLQStats,
  type DLQQuery,
  SQLiteDLQAdapter,
  PostgresDLQAdapter,
  InMemoryDLQAdapter,
  createDLQAdapter,
  DEFAULT_DLQ_CONFIG,
} from '@agent-relay/storage/dlq-adapter';
