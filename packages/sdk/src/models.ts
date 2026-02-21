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
  /** OpenAI o3 - reasoning model */
  O3: 'o3',
  /** OpenAI o4-mini - smaller reasoning model */
  O4_MINI: 'o4-mini',
  /** GPT-4o - multimodal flagship */
  GPT4O: 'gpt-4o',
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
 * All models grouped by CLI tool.
 *
 * @example
 * ```typescript
 * import { Models } from '@agent-relay/sdk';
 *
 * // Use with spawn
 * await relay.claude.spawn({ model: Models.Claude.OPUS });
 * await relay.codex.spawn({ model: Models.Codex.O3 });
 * await relay.gemini.spawn({ model: Models.Gemini.FLASH });
 * ```
 */
export const Models = {
  Claude: ClaudeModels,
  Codex: CodexModels,
  Gemini: GeminiModels,
} as const;

/**
 * Supported CLI tools.
 */
export const CLIs = {
  CLAUDE: 'claude',
  CODEX: 'codex',
  GEMINI: 'gemini',
  AIDER: 'aider',
  GOOSE: 'goose',
} as const;

export type CLI = (typeof CLIs)[keyof typeof CLIs];
