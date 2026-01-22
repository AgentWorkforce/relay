/**
 * Memory Adapter Factory
 *
 * Creates memory adapters based on configuration.
 * Supports environment variables for configuration.
 */

import type { MemoryAdapter, MemoryConfig } from './types.js';
import { InMemoryAdapter } from './adapters/inmemory.js';
import { SupermemoryAdapter } from './adapters/supermemory.js';

/**
 * Get memory configuration from environment variables
 *
 * Environment variables:
 * - AGENT_RELAY_MEMORY_TYPE: 'inmemory', 'supermemory', 'claude'
 * - AGENT_RELAY_MEMORY_API_KEY: API key for external services
 * - AGENT_RELAY_MEMORY_ENDPOINT: Custom API endpoint
 * - SUPERMEMORY_API_KEY: Supermemory-specific API key (fallback)
 */
export function getMemoryConfigFromEnv(): MemoryConfig {
  const type = process.env.AGENT_RELAY_MEMORY_TYPE ?? 'inmemory';
  const apiKey =
    process.env.AGENT_RELAY_MEMORY_API_KEY ??
    process.env.SUPERMEMORY_API_KEY;

  return {
    type,
    apiKey,
    endpoint: process.env.AGENT_RELAY_MEMORY_ENDPOINT,
    defaultAgentId: process.env.AGENT_RELAY_AGENT_ID,
    defaultProjectId: process.env.AGENT_RELAY_PROJECT_ID,
  };
}

/**
 * Create a memory adapter based on configuration
 *
 * @param config - Memory configuration (merged with env vars)
 * @returns Initialized memory adapter
 *
 * @example
 * ```typescript
 * // Use environment variables
 * const memory = await createMemoryAdapter();
 *
 * // Explicit configuration
 * const memory = await createMemoryAdapter({
 *   type: 'supermemory',
 *   apiKey: 'my-api-key',
 * });
 * ```
 */
export async function createMemoryAdapter(
  config?: Partial<MemoryConfig>
): Promise<MemoryAdapter> {
  // Merge with environment config
  const envConfig = getMemoryConfigFromEnv();
  const finalConfig: MemoryConfig = {
    type: config?.type ?? envConfig.type ?? 'inmemory',
    apiKey: config?.apiKey ?? envConfig.apiKey,
    endpoint: config?.endpoint ?? envConfig.endpoint,
    defaultAgentId: config?.defaultAgentId ?? envConfig.defaultAgentId,
    defaultProjectId: config?.defaultProjectId ?? envConfig.defaultProjectId,
    options: { ...envConfig.options, ...config?.options },
  };

  const adapterType = finalConfig.type.toLowerCase();
  let adapter: MemoryAdapter;

  switch (adapterType) {
    case 'supermemory':
    case 'supermemory.ai': {
      if (!finalConfig.apiKey) {
        throw new Error(
          'Supermemory adapter requires an API key. ' +
          'Set AGENT_RELAY_MEMORY_API_KEY or SUPERMEMORY_API_KEY environment variable, ' +
          'or provide apiKey in config.'
        );
      }

      adapter = new SupermemoryAdapter({
        apiKey: finalConfig.apiKey,
        endpoint: finalConfig.endpoint,
        defaultAgentId: finalConfig.defaultAgentId,
        defaultProjectId: finalConfig.defaultProjectId,
        container: finalConfig.options?.container as string | undefined,
        timeout: finalConfig.options?.timeout as number | undefined,
      });
      break;
    }

    case 'claude':
    case 'claude-memory': {
      // Claude memory is not yet available as a public API
      // Fall back to in-memory with a warning
      console.warn(
        '[memory] Claude memory adapter not yet available. ' +
        'Using in-memory adapter as fallback.'
      );
      adapter = new InMemoryAdapter({
        defaultAgentId: finalConfig.defaultAgentId,
        defaultProjectId: finalConfig.defaultProjectId,
        maxMemories: finalConfig.options?.maxMemories as number | undefined,
      });
      break;
    }

    case 'inmemory':
    case 'memory':
    case 'none':
    default: {
      adapter = new InMemoryAdapter({
        defaultAgentId: finalConfig.defaultAgentId,
        defaultProjectId: finalConfig.defaultProjectId,
        maxMemories: finalConfig.options?.maxMemories as number | undefined,
      });
      break;
    }
  }

  await adapter.init();
  return adapter;
}

/**
 * Check if a memory adapter type is available
 *
 * @param type - Adapter type to check
 * @returns Whether the adapter is available
 */
export function isMemoryAdapterAvailable(type: string): boolean {
  const adapterType = type.toLowerCase();

  switch (adapterType) {
    case 'inmemory':
    case 'memory':
    case 'none':
      return true;

    case 'supermemory':
    case 'supermemory.ai':
      // Available if API key is configured
      return !!(
        process.env.AGENT_RELAY_MEMORY_API_KEY ||
        process.env.SUPERMEMORY_API_KEY
      );

    case 'claude':
    case 'claude-memory':
      // Not yet available
      return false;

    default:
      return false;
  }
}

/**
 * Get list of available memory adapter types
 */
export function getAvailableMemoryAdapters(): string[] {
  const adapters: string[] = ['inmemory'];

  if (process.env.AGENT_RELAY_MEMORY_API_KEY || process.env.SUPERMEMORY_API_KEY) {
    adapters.push('supermemory');
  }

  return adapters;
}
