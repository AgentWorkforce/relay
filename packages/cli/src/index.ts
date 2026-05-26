/**
 * Agent Relay
 * Real-time agent-to-agent communication system.
 */

export * from '@agent-relay/sdk';
export * from '@agent-relay/utils';
export * from '@agent-relay/hooks';

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
  ContextCompactor,
  createContextCompactor,
  estimateTokens,
  estimateContextTokens,
  type CompactionConfig,
  type CompactionResult,
} from '@agent-relay/memory';
