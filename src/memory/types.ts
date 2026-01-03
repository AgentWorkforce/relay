/**
 * Agent Relay Memory Types
 *
 * Core types for the memory adapter system. Memory adapters provide
 * semantic storage and retrieval of agent learnings and context.
 */

/**
 * A memory entry stored in the system
 */
export interface MemoryEntry {
  /** Unique identifier for the memory */
  id: string;
  /** The actual content of the memory */
  content: string;
  /** Timestamp when memory was created */
  createdAt: number;
  /** Timestamp when memory was last accessed */
  lastAccessedAt?: number;
  /** Optional metadata tags */
  tags?: string[];
  /** Source of the memory (e.g., 'agent', 'user', 'session') */
  source?: string;
  /** Agent that created the memory */
  agentId?: string;
  /** Project associated with this memory */
  projectId?: string;
  /** Session ID where memory was created */
  sessionId?: string;
  /** Relevance score (when returned from search) */
  score?: number;
  /** Additional structured metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Query options for searching memories
 */
export interface MemorySearchQuery {
  /** Semantic search query text */
  query: string;
  /** Maximum number of results to return */
  limit?: number;
  /** Minimum relevance score threshold (0-1) */
  minScore?: number;
  /** Filter by tags */
  tags?: string[];
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by project ID */
  projectId?: string;
  /** Filter by memories created after this timestamp */
  since?: number;
  /** Filter by memories created before this timestamp */
  before?: number;
}

/**
 * Options for adding a memory
 */
export interface AddMemoryOptions {
  /** Optional tags for the memory */
  tags?: string[];
  /** Source of the memory */
  source?: string;
  /** Agent creating the memory */
  agentId?: string;
  /** Project context */
  projectId?: string;
  /** Session context */
  sessionId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a memory operation
 */
export interface MemoryResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** ID of the affected memory (if applicable) */
  id?: string;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Memory adapter interface
 *
 * All memory backends must implement this interface to be used
 * with the agent-relay memory system.
 */
export interface MemoryAdapter {
  /** Unique identifier for this adapter type */
  readonly type: string;

  /**
   * Initialize the adapter (connect to backend, etc.)
   */
  init(): Promise<void>;

  /**
   * Add a new memory to the system
   * @param content - The content to remember
   * @param options - Optional metadata and context
   * @returns Result with the new memory's ID
   */
  add(content: string, options?: AddMemoryOptions): Promise<MemoryResult>;

  /**
   * Search for relevant memories
   * @param query - Search parameters
   * @returns Array of matching memories, ordered by relevance
   */
  search(query: MemorySearchQuery): Promise<MemoryEntry[]>;

  /**
   * Get a specific memory by ID
   * @param id - The memory ID
   * @returns The memory entry or null if not found
   */
  get(id: string): Promise<MemoryEntry | null>;

  /**
   * Delete a memory
   * @param id - The memory ID to delete
   * @returns Result indicating success/failure
   */
  delete(id: string): Promise<MemoryResult>;

  /**
   * Update an existing memory
   * @param id - The memory ID
   * @param content - New content
   * @param options - Optional updated metadata
   * @returns Result indicating success/failure
   */
  update?(id: string, content: string, options?: Partial<AddMemoryOptions>): Promise<MemoryResult>;

  /**
   * List recent memories
   * @param options - Filter options
   * @returns Array of recent memories
   */
  list?(options?: {
    limit?: number;
    agentId?: string;
    projectId?: string;
  }): Promise<MemoryEntry[]>;

  /**
   * Clear all memories matching criteria
   * @param options - Filter for what to clear
   */
  clear?(options?: {
    agentId?: string;
    projectId?: string;
    before?: number;
  }): Promise<MemoryResult>;

  /**
   * Get statistics about stored memories
   */
  stats?(): Promise<{
    totalCount: number;
    byAgent?: Record<string, number>;
    byProject?: Record<string, number>;
  }>;

  /**
   * Close the adapter and release resources
   */
  close?(): Promise<void>;
}

/**
 * Configuration for memory adapters
 */
export interface MemoryConfig {
  /** Adapter type: 'inmemory', 'supermemory', 'claude', etc. */
  type: string;
  /** API key for external services */
  apiKey?: string;
  /** API endpoint URL (for supermemory, etc.) */
  endpoint?: string;
  /** Default agent ID to use */
  defaultAgentId?: string;
  /** Default project ID to use */
  defaultProjectId?: string;
  /** Additional adapter-specific options */
  options?: Record<string, unknown>;
}

/**
 * Memory service interface for hooks
 *
 * This is a simplified interface exposed to hooks for memory operations.
 */
export interface MemoryService {
  /** Add a memory */
  add(content: string, options?: AddMemoryOptions): Promise<MemoryResult>;
  /** Search for memories */
  search(query: string | MemorySearchQuery): Promise<MemoryEntry[]>;
  /** Delete a memory */
  delete(id: string): Promise<MemoryResult>;
  /** List recent memories */
  list(limit?: number): Promise<MemoryEntry[]>;
  /** Check if memory service is available */
  isAvailable(): boolean;
}
