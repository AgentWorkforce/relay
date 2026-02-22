/**
 * Agent Relay
 * Real-time agent-to-agent communication system.
 */

export * from '@agent-relay/sdk';
export * from './utils/index.js';
export * from './hooks/index.js';

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
