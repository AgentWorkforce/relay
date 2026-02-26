/**
 * CLI Registry - AUTO-GENERATED FILE - DO NOT EDIT
 * Generated from packages/shared/cli-registry.yaml
 * Run: npm run codegen:models
 *
 * This is the single source of truth for CLI tools, versions, and models.
 * Other packages should import from @agent-relay/config.
 */

/**
 * CLI tool versions.
 * Update packages/shared/cli-registry.yaml to change versions.
 */
export const CLIVersions = {
  /** Claude Code v2.1.50 */
  CLAUDE: '2.1.50',
  /** Codex CLI v0.104.0 */
  CODEX: '0.104.0',
  /** Gemini CLI v0.29.5 */
  GEMINI: '0.29.5',
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
  /** Sonnet (default) */
  SONNET: 'sonnet',
  /** Opus */
  OPUS: 'opus',
  /** Haiku */
  HAIKU: 'haiku',
} as const;

export type ClaudeModel = (typeof ClaudeModels)[keyof typeof ClaudeModels];

/**
 * Codex CLI model identifiers.
 */
export const CodexModels = {
  /** GPT-5.2 Codex — Frontier agentic coding model (default) */
  GPT_5_2_CODEX: 'gpt-5.2-codex',
  /** GPT-5.3 Codex — Latest frontier agentic coding model */
  GPT_5_3_CODEX: 'gpt-5.3-codex',
  /** GPT-5.3 Codex Spark — Ultra-fast coding model */
  GPT_5_3_CODEX_SPARK: 'gpt-5.3-codex-spark',
  /** GPT-5.1 Codex Max — Deep and fast reasoning */
  GPT_5_1_CODEX_MAX: 'gpt-5.1-codex-max',
  /** GPT-5.2 — Frontier model, knowledge & reasoning */
  GPT_5_2: 'gpt-5.2',
  /** GPT-5.1 Codex Mini — Cheaper, faster */
  GPT_5_1_CODEX_MINI: 'gpt-5.1-codex-mini',
} as const;

export type CodexModel = (typeof CodexModels)[keyof typeof CodexModels];

/**
 * Gemini CLI model identifiers.
 */
export const GeminiModels = {
  /** Gemini 3 Pro Preview */
  GEMINI_3_PRO_PREVIEW: 'gemini-3-pro-preview',
  /** Gemini 2.5 Pro (default) */
  GEMINI_2_5_PRO: 'gemini-2.5-pro',
  /** Gemini 2.5 Flash */
  GEMINI_2_5_FLASH: 'gemini-2.5-flash',
  /** Gemini 2.5 Flash Lite */
  GEMINI_2_5_FLASH_LITE: 'gemini-2.5-flash-lite',
} as const;

export type GeminiModel = (typeof GeminiModels)[keyof typeof GeminiModels];

/**
 * Cursor model identifiers.
 */
export const CursorModels = {
  /** Claude 4.5 Opus (Thinking) (default) */
  OPUS_4_5_THINKING: 'opus-4.5-thinking',
  /** Claude 4.5 Opus */
  OPUS_4_5: 'opus-4.5',
  /** Claude 4.5 Sonnet */
  SONNET_4_5: 'sonnet-4.5',
  /** Claude 4.5 Sonnet (Thinking) */
  SONNET_4_5_THINKING: 'sonnet-4.5-thinking',
  /** GPT-5.2 Codex */
  GPT_5_2_CODEX: 'gpt-5.2-codex',
  /** GPT-5.2 Codex High */
  GPT_5_2_CODEX_HIGH: 'gpt-5.2-codex-high',
  /** GPT-5.2 Codex Low */
  GPT_5_2_CODEX_LOW: 'gpt-5.2-codex-low',
  /** GPT-5.2 Codex Extra High */
  GPT_5_2_CODEX_XHIGH: 'gpt-5.2-codex-xhigh',
  /** GPT-5.2 Codex Fast */
  GPT_5_2_CODEX_FAST: 'gpt-5.2-codex-fast',
  /** GPT-5.2 Codex High Fast */
  GPT_5_2_CODEX_HIGH_FAST: 'gpt-5.2-codex-high-fast',
  /** GPT-5.2 Codex Low Fast */
  GPT_5_2_CODEX_LOW_FAST: 'gpt-5.2-codex-low-fast',
  /** GPT-5.2 Codex Extra High Fast */
  GPT_5_2_CODEX_XHIGH_FAST: 'gpt-5.2-codex-xhigh-fast',
  /** GPT-5.1 Codex Max */
  GPT_5_1_CODEX_MAX: 'gpt-5.1-codex-max',
  /** GPT-5.1 Codex Max High */
  GPT_5_1_CODEX_MAX_HIGH: 'gpt-5.1-codex-max-high',
  /** GPT-5.2 */
  GPT_5_2: 'gpt-5.2',
  /** GPT-5.2 High */
  GPT_5_2_HIGH: 'gpt-5.2-high',
  /** GPT-5.1 High */
  GPT_5_1_HIGH: 'gpt-5.1-high',
  /** Gemini 3 Pro */
  GEMINI_3_PRO: 'gemini-3-pro',
  /** Gemini 3 Flash */
  GEMINI_3_FLASH: 'gemini-3-flash',
  /** Composer 1 */
  COMPOSER_1: 'composer-1',
  /** Grok */
  GROK: 'grok',
} as const;

export type CursorModel = (typeof CursorModels)[keyof typeof CursorModels];

/** Model option type for UI dropdowns */
export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Claude Code model options for UI dropdowns.
 */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
];

/**
 * Codex CLI model options for UI dropdowns.
 */
export const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex — Frontier agentic coding model' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex — Latest frontier agentic coding model' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark — Ultra-fast coding model' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max — Deep and fast reasoning' },
  { value: 'gpt-5.2', label: 'GPT-5.2 — Frontier model, knowledge & reasoning' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini — Cheaper, faster' },
];

/**
 * Gemini CLI model options for UI dropdowns.
 */
export const GEMINI_MODEL_OPTIONS: ModelOption[] = [
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
];

/**
 * Cursor model options for UI dropdowns.
 */
export const CURSOR_MODEL_OPTIONS: ModelOption[] = [
  { value: 'opus-4.5-thinking', label: 'Claude 4.5 Opus (Thinking)' },
  { value: 'opus-4.5', label: 'Claude 4.5 Opus' },
  { value: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
  { value: 'sonnet-4.5-thinking', label: 'Claude 4.5 Sonnet (Thinking)' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'gpt-5.2-codex-high', label: 'GPT-5.2 Codex High' },
  { value: 'gpt-5.2-codex-low', label: 'GPT-5.2 Codex Low' },
  { value: 'gpt-5.2-codex-xhigh', label: 'GPT-5.2 Codex Extra High' },
  { value: 'gpt-5.2-codex-fast', label: 'GPT-5.2 Codex Fast' },
  { value: 'gpt-5.2-codex-high-fast', label: 'GPT-5.2 Codex High Fast' },
  { value: 'gpt-5.2-codex-low-fast', label: 'GPT-5.2 Codex Low Fast' },
  { value: 'gpt-5.2-codex-xhigh-fast', label: 'GPT-5.2 Codex Extra High Fast' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { value: 'gpt-5.1-codex-max-high', label: 'GPT-5.1 Codex Max High' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.2-high', label: 'GPT-5.2 High' },
  { value: 'gpt-5.1-high', label: 'GPT-5.1 High' },
  { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { value: 'composer-1', label: 'Composer 1' },
  { value: 'grok', label: 'Grok' },
];

/**
 * All models grouped by CLI tool.
 *
 * @example
 * ```typescript
 * import { Models } from '@agent-relay/sdk';
 *
 * await relay.claude.spawn({ model: Models.Claude.OPUS });
 * await relay.codex.spawn({ model: Models.Codex.GPT_5_2_CODEX });
 * ```
 */
export const Models = {
  Claude: ClaudeModels,
  Codex: CodexModels,
  Gemini: GeminiModels,
  Cursor: CursorModels,
} as const;

/**
 * All model options grouped by CLI tool (for UI dropdowns).
 *
 * @example
 * ```typescript
 * import { ModelOptions } from '@agent-relay/sdk';
 *
 * <select>
 *   {ModelOptions.Claude.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
 * </select>
 * ```
 */
export const ModelOptions = {
  Claude: CLAUDE_MODEL_OPTIONS,
  Codex: CODEX_MODEL_OPTIONS,
  Gemini: GEMINI_MODEL_OPTIONS,
  Cursor: CURSOR_MODEL_OPTIONS,
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

// Note: SwarmPattern type is defined in workflows/types.ts to avoid duplication

/**
 * Full CLI registry for relay-cloud and other services.
 */
export const CLIRegistry = {
  claude: {
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    version: '2.1.50',
    install: 'npm install -g @anthropic-ai/claude-code',
    npmLink: 'https://www.npmjs.com/package/@anthropic-ai',
  },
  codex: {
    name: 'Codex CLI',
    package: '@openai/codex',
    version: '0.104.0',
    install: 'npm install -g @openai/codex',
    npmLink: 'https://www.npmjs.com/package/@openai/codex',
  },
  gemini: {
    name: 'Gemini CLI',
    package: '@google/gemini-cli',
    version: '0.29.5',
    install: 'npm install -g @google/gemini-cli',
    npmLink: 'https://www.npmjs.com/package/@google/gemini-cli',
  },
  cursor: {
    name: 'Cursor',
    package: 'cursor',
    version: '0.48.6',
    install: 'Download from cursor.com',
    npmLink: undefined,
  },
  aider: {
    name: 'Aider',
    package: 'aider-chat',
    version: '0.72.1',
    install: 'pip install aider-chat',
    npmLink: undefined,
  },
  goose: {
    name: 'Goose',
    package: 'goose-ai',
    version: '1.0.16',
    install: 'pip install goose-ai',
    npmLink: undefined,
  },
} as const;

/**
 * Default model for each CLI tool.
 */
export const DefaultModels = {
  claude: 'sonnet',
  codex: 'gpt-5.2-codex',
  gemini: 'gemini-2.5-pro',
  cursor: 'opus-4.5-thinking',
} as const;
