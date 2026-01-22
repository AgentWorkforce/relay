/**
 * Agent Relay Memory System
 *
 * Provides semantic memory storage and retrieval with multiple backend support.
 * Memory adapters can be used standalone or integrated with the hooks system.
 *
 * @example
 * ```typescript
 * import { createMemoryAdapter } from 'agent-relay/memory';
 *
 * // Create an in-memory adapter for testing
 * const memory = await createMemoryAdapter({ type: 'inmemory' });
 *
 * // Or use supermemory.ai for production
 * const memory = await createMemoryAdapter({
 *   type: 'supermemory',
 *   apiKey: process.env.SUPERMEMORY_API_KEY,
 * });
 *
 * // Add a memory
 * await memory.add('User prefers TypeScript', { tags: ['preference'] });
 *
 * // Search for relevant memories
 * const results = await memory.search({ query: 'programming language' });
 * ```
 */

export * from './types.js';
export * from './adapters/index.js';
export { createMemoryAdapter, getMemoryConfigFromEnv } from './factory.js';
export { createMemoryService } from './service.js';
export { createMemoryHooks, getMemoryHooks } from './memory-hooks.js';
export * from './context-compaction.js';
