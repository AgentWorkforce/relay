/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Generated from packages/shared/cli-registry.yaml
 * Run: npm run codegen:models
 */

/**
 * CLI tool versions.
 * Update packages/shared/cli-registry.yaml to change versions.
 */
export const CLIVersions = {
  /** Claude Code v1.0.24 */
  CLAUDE: '1.0.24',
  /** Codex CLI v0.1.2504301707 */
  CODEX: '0.1.2504301707',
  /** Gemini CLI v0.1.17 */
  GEMINI: '0.1.17',
  /** Cursor v0.48.6 */
  CURSOR: '0.48.6',
  /** Aider v0.72.1 */
  AIDER: '0.72.1',
  /** Goose v1.0.16 */
  GOOSE: '1.0.16',
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
 * Claude Code model identifiers.
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
 * Codex CLI model identifiers.
 */
export const CodexModels = {
  /** Codex 5.3 - latest codex model (default) */
  CODEX_5_3: 'codex-5.3',
} as const;

export type CodexModel = (typeof CodexModels)[keyof typeof CodexModels];

/**
 * Gemini CLI model identifiers.
 */
export const GeminiModels = {
  /** Gemini 2.0 Flash - fast and capable (default) */
  FLASH: 'gemini-2.0-flash',
  /** Gemini 2.0 Pro - most capable */
  PRO: 'gemini-2.0-pro',
} as const;

export type GeminiModel = (typeof GeminiModels)[keyof typeof GeminiModels];

/**
 * Cursor model identifiers.
 */
export const CursorModels = {
  /** Claude Sonnet via Cursor (default) */
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
 * await relay.claude.spawn({ model: Models.Claude.OPUS });
 * await relay.codex.spawn({ model: Models.Codex.CODEX_5_3 });
 * ```
 */
export const Models = {
  Claude: ClaudeModels,
  Codex: CodexModels,
  Gemini: GeminiModels,
  Cursor: CursorModels,
} as const;

/**
 * Swarm patterns for multi-agent workflows.
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

/**
 * Full CLI registry for relay-cloud and other services.
 */
export const CLIRegistry = {
  claude: {
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    version: '1.0.24',
    install: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    name: 'Codex CLI',
    package: '@openai/codex',
    version: '0.1.2504301707',
    install: 'npm install -g @openai/codex',
  },
  gemini: {
    name: 'Gemini CLI',
    package: '@anthropic-ai/gemini-cli',
    version: '0.1.17',
    install: 'npm install -g @google/gemini-cli',
  },
  cursor: {
    name: 'Cursor',
    package: 'cursor',
    version: '0.48.6',
    install: 'Download from cursor.com',
  },
  aider: {
    name: 'Aider',
    package: 'aider-chat',
    version: '0.72.1',
    install: 'pip install aider-chat',
  },
  goose: {
    name: 'Goose',
    package: 'goose-ai',
    version: '1.0.16',
    install: 'pip install goose-ai',
  },
} as const;
