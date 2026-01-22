/**
 * Memory Hooks
 *
 * Provides memory-aware lifecycle hooks that automatically:
 * - Load relevant context on session start
 * - Prompt for memory save on session end
 * - Handle @memory: pattern output
 */

import type {
  LifecycleHooks,
  SessionStartContext,
  SessionEndContext,
  OutputContext,
  HookResult,
} from '@agent-relay/hooks';
import type {
  MemoryAdapter,
  MemoryConfig,
  MemoryEntry,
} from './types.js';
import { createMemoryAdapter } from './factory.js';

/**
 * Options for memory hooks
 */
export interface MemoryHooksOptions {
  /** Pre-configured memory adapter */
  adapter?: MemoryAdapter;
  /** Configuration for creating a new adapter */
  config?: Partial<MemoryConfig>;
  /** Agent ID for memory operations */
  agentId?: string;
  /** Project ID for memory operations */
  projectId?: string;
  /** Whether to inject relevant memories on session start */
  injectOnStart?: boolean;
  /** Maximum memories to inject on start */
  maxStartMemories?: number;
  /** Search query for session start (default: project-based) */
  startSearchQuery?: string;
  /** Whether to prompt for memory save on session end */
  promptOnEnd?: boolean;
  /** Whether to auto-save important learnings from output */
  autoSave?: boolean;
  /** Whether to auto-save session summary on graceful end */
  autoSaveOnEnd?: boolean;
  /** Patterns that indicate content worth saving */
  savePatterns?: RegExp[];
}

/**
 * State for memory hooks
 */
interface MemoryHooksState {
  adapter: MemoryAdapter | null;
  adapterPromise: Promise<MemoryAdapter> | null;
  options: Required<Omit<MemoryHooksOptions, 'adapter' | 'config'>> & {
    config?: Partial<MemoryConfig>;
  };
  sessionId?: string;
  /** Collected learnings from output during session */
  sessionLearnings: string[];
}

/**
 * Default patterns that indicate content worth auto-saving
 *
 * Categories:
 * - Learnings: discoveries, realizations, insights
 * - Decisions: significant choices made
 * - Breakthroughs: problems solved, aha moments
 * - Failures: things that went wrong, errors encountered
 * - Preferences: user/project preferences
 * - Retrospectives: end-of-task reflections
 */
const DEFAULT_SAVE_PATTERNS = [
  // Learnings and discoveries
  /(?:learned|discovered|found out|realized|important|remember|note to self)/i,
  /(?:key insight|takeaway|lesson learned|now I understand)/i,

  // Significant decisions
  /(?:decided to|decision:|chose to|going with|settled on|approach:|strategy:)/i,
  /(?:trade-?off|weighing|considering|opting for)/i,

  // Breakthroughs and solutions
  /(?:breakthrough|finally|solved|figured out|the fix was|root cause)/i,
  /(?:aha|eureka|that's why|the issue was|problem was)/i,

  // Failures and problems
  /(?:failed because|mistake was|should have|shouldn't have|next time)/i,
  /(?:went wrong|broke because|error was due to|caused by)/i,
  /(?:avoid|don't repeat|pitfall|gotcha|watch out)/i,

  // User/project preferences
  /(?:user prefers?|preference|always use|never use|don't use)/i,
  /(?:project uses?|codebase uses?|this repo|this project)/i,
  /(?:convention|pattern|style guide|best practice)/i,

  // Retrospectives
  /(?:in retrospect|looking back|reflecting|summary:|recap:)/i,
  /(?:what worked|what didn't|improvements for next time)/i,
];

/**
 * Create memory hooks for automatic context loading and saving
 *
 * @example
 * ```typescript
 * const hooks = createMemoryHooks({
 *   config: { type: 'supermemory', apiKey: 'xxx' },
 *   agentId: 'my-agent',
 *   projectId: 'my-project',
 * });
 *
 * registry.registerLifecycleHooks(hooks);
 * ```
 */
export function createMemoryHooks(options: MemoryHooksOptions = {}): LifecycleHooks {
  const state: MemoryHooksState = {
    adapter: options.adapter ?? null,
    adapterPromise: null,
    sessionLearnings: [],
    options: {
      agentId: options.agentId ?? 'default',
      projectId: options.projectId ?? 'default',
      injectOnStart: options.injectOnStart ?? true,
      maxStartMemories: options.maxStartMemories ?? 5,
      startSearchQuery: options.startSearchQuery ?? '',
      promptOnEnd: options.promptOnEnd ?? false,
      autoSave: options.autoSave ?? true,
      autoSaveOnEnd: options.autoSaveOnEnd ?? true,
      savePatterns: options.savePatterns ?? DEFAULT_SAVE_PATTERNS,
      config: options.config,
    },
  };

  return {
    onSessionStart: createSessionStartHook(state),
    onSessionEnd: createSessionEndHook(state),
    onOutput: createOutputHook(state),
  };
}

/**
 * Lazily get or create the memory adapter
 */
async function getAdapter(state: MemoryHooksState): Promise<MemoryAdapter | null> {
  if (state.adapter) {
    return state.adapter;
  }

  if (!state.adapterPromise) {
    state.adapterPromise = createMemoryAdapter({
      ...state.options.config,
      defaultAgentId: state.options.agentId,
      defaultProjectId: state.options.projectId,
    }).catch(error => {
      console.error('[memory-hooks] Failed to create adapter:', error);
      return null as unknown as MemoryAdapter;
    });
  }

  state.adapter = await state.adapterPromise;
  return state.adapter;
}

/**
 * Session start hook - loads relevant memories
 */
function createSessionStartHook(state: MemoryHooksState) {
  return async (ctx: SessionStartContext): Promise<HookResult | void> => {
    if (!state.options.injectOnStart) {
      return;
    }

    state.sessionId = ctx.sessionId;

    const adapter = await getAdapter(state);
    if (!adapter) {
      return;
    }

    try {
      // Build search query based on context
      const searchQuery =
        state.options.startSearchQuery ||
        `project: ${ctx.workingDir} OR agent: ${state.options.agentId}`;

      const memories = await adapter.search({
        query: searchQuery,
        limit: state.options.maxStartMemories,
        agentId: state.options.agentId,
        projectId: state.options.projectId,
      });

      if (memories.length === 0) {
        return;
      }

      const formattedMemories = formatMemoriesForInjection(memories);
      return {
        inject: `\n[CONTEXT FROM MEMORY]\n${formattedMemories}\n`,
      };
    } catch (error) {
      console.error('[memory-hooks] Failed to load memories:', error);
    }
  };
}

/**
 * Session end hook - logs learnings summary and optionally prompts for more
 */
function createSessionEndHook(state: MemoryHooksState) {
  return async (ctx: SessionEndContext): Promise<HookResult | void> => {
    // Log session summary (learnings were already saved immediately during output)
    if (state.options.autoSaveOnEnd && ctx.graceful && state.sessionLearnings.length > 0) {
      const uniqueLearnings = [...new Set(state.sessionLearnings)];
      console.log(
        `[memory-hooks] Session captured ${uniqueLearnings.length} learnings (saved during session)`
      );

      // Clear for next session
      state.sessionLearnings = [];
    }

    // Optional prompt for additional saves
    if (state.options.promptOnEnd && ctx.graceful) {
      return {
        inject: `
[SESSION ENDING]
If you learned anything important, save it for future sessions:
  @memory:save <what you learned>

Examples:
  @memory:save User prefers TypeScript over JavaScript
  @memory:save This project uses Prisma for database access
  @memory:save Auth tokens stored in httpOnly cookies
`,
      };
    }
  };
}

/**
 * Output hook - handles @memory: patterns and auto-save
 */
function createOutputHook(state: MemoryHooksState) {
  return async (ctx: OutputContext): Promise<HookResult | void> => {
    const { content } = ctx;

    // Handle @memory: patterns (explicit saves)
    const memoryMatch = content.match(/@memory:(\w+)\s+(.+)/);
    if (memoryMatch) {
      const [, action, payload] = memoryMatch;
      return handleMemoryCommand(state, action, payload.trim());
    }

    // Auto-detect and save learnings
    if (state.options.autoSave) {
      for (const pattern of state.options.savePatterns) {
        if (pattern.test(content)) {
          // Extract the relevant sentence/phrase
          const relevantContent = extractRelevantContent(content, pattern);
          if (relevantContent && relevantContent.length > 10) {
            // Collect for session-end retrospective
            if (state.options.autoSaveOnEnd) {
              state.sessionLearnings.push(relevantContent);
            }

            // Also save immediately (ensures persistence even on crash)
            const adapter = await getAdapter(state);
            if (adapter) {
              await adapter.add(relevantContent, {
                source: 'auto-detected',
                sessionId: state.sessionId,
                tags: ['auto-saved'],
              });
            }
          }
          break;
        }
      }
    }
  };
}

/**
 * Handle @memory: commands
 */
async function handleMemoryCommand(
  state: MemoryHooksState,
  action: string,
  payload: string
): Promise<HookResult | void> {
  const adapter = await getAdapter(state);
  if (!adapter) {
    return { inject: '[memory] Memory service not available' };
  }

  switch (action.toLowerCase()) {
    case 'save':
    case 'add': {
      const result = await adapter.add(payload, {
        source: 'agent-command',
        sessionId: state.sessionId,
      });
      if (result.success) {
        return { inject: `[memory] Saved: "${truncate(payload, 50)}"` };
      } else {
        return { inject: `[memory] Failed to save: ${result.error}` };
      }
    }

    case 'search':
    case 'find':
    case 'recall': {
      const memories = await adapter.search({
        query: payload,
        limit: 5,
      });

      if (memories.length === 0) {
        return { inject: '[memory] No relevant memories found' };
      }

      const formatted = formatMemoriesForInjection(memories);
      return { inject: `[memory] Found ${memories.length} memories:\n${formatted}` };
    }

    case 'forget':
    case 'delete': {
      const result = await adapter.delete(payload);
      if (result.success) {
        return { inject: `[memory] Deleted memory: ${payload}` };
      } else {
        return { inject: `[memory] Failed to delete: ${result.error}` };
      }
    }

    case 'list': {
      if (!adapter.list) {
        return { inject: '[memory] List not supported by this adapter' };
      }
      const limit = parseInt(payload) || 10;
      const memories = await adapter.list({ limit });

      if (memories.length === 0) {
        return { inject: '[memory] No memories stored' };
      }

      const formatted = formatMemoriesForInjection(memories);
      return { inject: `[memory] Recent memories:\n${formatted}` };
    }

    default:
      return {
        inject: `[memory] Unknown action: ${action}. Use: save, search, forget, list`,
      };
  }
}

/**
 * Format memories for injection into agent context
 */
function formatMemoriesForInjection(memories: MemoryEntry[]): string {
  return memories
    .map((m, i) => {
      const score = m.score ? ` (relevance: ${Math.round(m.score * 100)}%)` : '';
      const tags = m.tags?.length ? ` [${m.tags.join(', ')}]` : '';
      return `${i + 1}. ${m.content}${tags}${score}`;
    })
    .join('\n');
}

/**
 * Extract relevant content around a pattern match
 */
function extractRelevantContent(content: string, pattern: RegExp): string | null {
  const match = content.match(pattern);
  if (!match) return null;

  // Find the sentence containing the match
  const sentences = content.split(/[.!?]+/);
  for (const sentence of sentences) {
    if (pattern.test(sentence)) {
      return sentence.trim();
    }
  }

  return match[0];
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Get memory hooks with default settings
 *
 * @param agentId - Agent identifier
 * @param projectId - Project identifier
 */
export function getMemoryHooks(agentId: string, projectId: string): LifecycleHooks {
  return createMemoryHooks({ agentId, projectId });
}
