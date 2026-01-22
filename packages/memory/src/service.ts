/**
 * Memory Service
 *
 * A simplified service wrapper around memory adapters for use in hooks.
 * Provides a consistent interface and handles common operations.
 */

import type {
  MemoryAdapter,
  MemoryEntry,
  MemorySearchQuery,
  AddMemoryOptions,
  MemoryResult,
  MemoryService,
  MemoryConfig,
} from './types.js';
import { createMemoryAdapter } from './factory.js';

/**
 * Options for creating a memory service
 */
export interface MemoryServiceOptions {
  /** Pre-configured adapter to use */
  adapter?: MemoryAdapter;
  /** Configuration for creating a new adapter */
  config?: Partial<MemoryConfig>;
  /** Default agent ID for all operations */
  agentId?: string;
  /** Default project ID for all operations */
  projectId?: string;
  /** Default session ID for all operations */
  sessionId?: string;
}

/**
 * Internal memory service implementation
 */
class MemoryServiceImpl implements MemoryService {
  private adapter: MemoryAdapter | null = null;
  private adapterPromise: Promise<MemoryAdapter | null> | null = null;
  private options: MemoryServiceOptions;
  private available = false;

  constructor(options: MemoryServiceOptions = {}) {
    this.options = options;

    if (options.adapter) {
      this.adapter = options.adapter;
      this.available = true;
    }
  }

  /**
   * Lazily initialize the adapter
   */
  private async getAdapter(): Promise<MemoryAdapter | null> {
    if (this.adapter) {
      return this.adapter;
    }

    if (!this.adapterPromise) {
      this.adapterPromise = this.initAdapter();
    }

    return this.adapterPromise;
  }

  private async initAdapter(): Promise<MemoryAdapter | null> {
    try {
      const config = this.options.config ?? {};
      this.adapter = await createMemoryAdapter({
        ...config,
        defaultAgentId: config.defaultAgentId ?? this.options.agentId,
        defaultProjectId: config.defaultProjectId ?? this.options.projectId,
      });
      this.available = true;
      return this.adapter;
    } catch (error) {
      console.error('[memory] Failed to initialize adapter:', error);
      this.available = false;
      return null;
    }
  }

  async add(content: string, options?: AddMemoryOptions): Promise<MemoryResult> {
    const adapter = await this.getAdapter();
    if (!adapter) {
      return { success: false, error: 'Memory adapter not available' };
    }

    return adapter.add(content, {
      ...options,
      agentId: options?.agentId ?? this.options.agentId,
      projectId: options?.projectId ?? this.options.projectId,
      sessionId: options?.sessionId ?? this.options.sessionId,
    });
  }

  async search(query: string | MemorySearchQuery): Promise<MemoryEntry[]> {
    const adapter = await this.getAdapter();
    if (!adapter) {
      return [];
    }

    const searchQuery: MemorySearchQuery =
      typeof query === 'string'
        ? {
            query,
            agentId: this.options.agentId,
            projectId: this.options.projectId,
          }
        : {
            ...query,
            agentId: query.agentId ?? this.options.agentId,
            projectId: query.projectId ?? this.options.projectId,
          };

    return adapter.search(searchQuery);
  }

  async delete(id: string): Promise<MemoryResult> {
    const adapter = await this.getAdapter();
    if (!adapter) {
      return { success: false, error: 'Memory adapter not available' };
    }

    return adapter.delete(id);
  }

  async list(limit?: number): Promise<MemoryEntry[]> {
    const adapter = await this.getAdapter();
    if (!adapter || !adapter.list) {
      return [];
    }

    return adapter.list({
      limit,
      agentId: this.options.agentId,
      projectId: this.options.projectId,
    });
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Get the underlying adapter (for advanced use)
   */
  getUnderlyingAdapter(): MemoryAdapter | null {
    return this.adapter;
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    if (this.adapter?.close) {
      await this.adapter.close();
    }
    this.adapter = null;
    this.adapterPromise = null;
    this.available = false;
  }
}

/**
 * Create a memory service instance
 *
 * @param options - Service configuration
 * @returns Memory service instance
 *
 * @example
 * ```typescript
 * // Create with default in-memory adapter
 * const memory = createMemoryService();
 *
 * // Create with specific adapter
 * const adapter = await createMemoryAdapter({ type: 'supermemory', apiKey });
 * const memory = createMemoryService({ adapter });
 *
 * // Create with config
 * const memory = createMemoryService({
 *   config: { type: 'supermemory' },
 *   agentId: 'my-agent',
 * });
 * ```
 */
export function createMemoryService(options?: MemoryServiceOptions): MemoryService & {
  getUnderlyingAdapter(): MemoryAdapter | null;
  close(): Promise<void>;
} {
  return new MemoryServiceImpl(options);
}
