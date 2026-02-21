/**
 * Model Constants
 *
 * Pre-defined model names for each supported CLI tool.
 * Use these constants when spawning agents to ensure valid model names.
 *
 * @example
 * ```typescript
 * import { AgentRelay, Models } from '@agent-relay/sdk';
 *
 * const relay = new AgentRelay();
 * await relay.claude.spawn({ name: 'Worker', model: Models.Claude.SONNET });
 * ```
 */

/**
 * Claude model identifiers.
 * These map to Claude Code's /model command.
 */
export const ClaudeModels = {
  /** Claude Opus 4 - most capable, best for complex reasoning */
  OPUS: 'opus',
  /** Claude Sonnet 4 - balanced performance and speed (default) */
  SONNET: 'sonnet',
  /** Claude Haiku - fastest, best for simple tasks */
  HAIKU: 'haiku',
} as const;

export type ClaudeModel = (typeof ClaudeModels)[keyof typeof ClaudeModels];

/**
 * Codex (OpenAI) model identifiers.
 */
export const CodexModels = {
  /** Codex 5.3 - latest codex model */
  CODEX_5_3: 'codex-5.3',
} as const;

export type CodexModel = (typeof CodexModels)[keyof typeof CodexModels];

/**
 * Gemini (Google) model identifiers.
 */
export const GeminiModels = {
  /** Gemini 2.0 Flash - fast and capable */
  FLASH: 'gemini-2.0-flash',
  /** Gemini 2.0 Pro - most capable */
  PRO: 'gemini-2.0-pro',
} as const;

export type GeminiModel = (typeof GeminiModels)[keyof typeof GeminiModels];

/**
 * Cursor model identifiers.
 */
export const CursorModels = {
  /** Claude Sonnet via Cursor */
  CLAUDE_SONNET: 'claude-sonnet',
  /** GPT-4o via Cursor */
  GPT4O: 'gpt-4o',
} as const;

export type CursorModel = (typeof CursorModels)[keyof typeof CursorModels];

/**
 * All models grouped by CLI tool.
 *
 * @example
 * ```typescript
 * import { Models } from '@agent-relay/sdk';
 *
 * // Use with spawn
 * await relay.claude.spawn({ model: Models.Claude.OPUS });
 * await relay.codex.spawn({ model: Models.Codex.CODEX_5_3 });
 * await relay.gemini.spawn({ model: Models.Gemini.FLASH });
 * await relay.cursor.spawn({ model: Models.Cursor.CLAUDE_SONNET });
 * ```
 */
export const Models = {
  Claude: ClaudeModels,
  Codex: CodexModels,
  Gemini: GeminiModels,
  Cursor: CursorModels,
} as const;

/**
 * Supported CLI tools.
 */
export const CLIs = {
  CLAUDE: 'claude',
  CODEX: 'codex',
  GEMINI: 'gemini',
  CURSOR: 'cursor',
  AIDER: 'aider',
  GOOSE: 'goose',
} as const;

export type CLI = (typeof CLIs)[keyof typeof CLIs];

/**
 * Swarm patterns for multi-agent workflows.
 * Use these constants when setting workflow patterns.
 */
export const SwarmPatterns = {
  /** Central coordinator distributes tasks to workers */
  HUB_SPOKE: 'hub-spoke',
  /** Directed acyclic graph with dependencies */
  DAG: 'dag',
  /** Parallel execution across multiple agents */
  FAN_OUT: 'fan-out',
  /** Sequential processing through stages */
  PIPELINE: 'pipeline',
  /** Agents reach agreement before proceeding */
  CONSENSUS: 'consensus',
  /** Fully connected peer-to-peer communication */
  MESH: 'mesh',
  /** Sequential handoff between agents */
  HANDOFF: 'handoff',
  /** Cascading delegation */
  CASCADE: 'cascade',
  /** Agents debate to reach conclusion */
  DEBATE: 'debate',
  /** Tree-structured coordination */
  HIERARCHICAL: 'hierarchical',
} as const;
