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
  /** Claude Code v2.1.72 */
  CLAUDE: '2.1.72',
  /** Codex CLI v0.114.0 */
  CODEX: '0.114.0',
  /** Gemini CLI v0.33.0 */
  GEMINI: '0.33.0',
  /** Cursor v2026.02.27-e7d2ef6 */
  CURSOR: '2026.02.27-e7d2ef6',
  /** Droid v0.1.0 */
  DROID: '0.1.0',
  /** OpenCode v1.2.24 */
  OPENCODE: '1.2.24',
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
  DROID: 'droid',
  OPENCODE: 'opencode',
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
  /** GPT-5.4 — Latest frontier agentic coding model (default) */
  GPT_5_4: 'gpt-5.4',
  /** GPT-5.3 Codex — Frontier agentic coding model */
  GPT_5_3_CODEX: 'gpt-5.3-codex',
  /** GPT-5.3 Codex Spark — Ultra-fast coding model */
  GPT_5_3_CODEX_SPARK: 'gpt-5.3-codex-spark',
  /** GPT-5.2 Codex — Frontier agentic coding model */
  GPT_5_2_CODEX: 'gpt-5.2-codex',
  /** GPT-5.2 — Frontier model, knowledge & reasoning */
  GPT_5_2: 'gpt-5.2',
  /** GPT-5.1 Codex Max — Deep and fast reasoning */
  GPT_5_1_CODEX_MAX: 'gpt-5.1-codex-max',
  /** GPT-5.1 Codex Mini — Cheaper, faster */
  GPT_5_1_CODEX_MINI: 'gpt-5.1-codex-mini',
} as const;

export type CodexModel = (typeof CodexModels)[keyof typeof CodexModels];

/**
 * Gemini CLI model identifiers.
 */
export const GeminiModels = {
  /** Gemini 3.1 Pro Preview (default) */
  GEMINI_3_1_PRO_PREVIEW: 'gemini-3.1-pro-preview',
  /** Gemini 3 Flash Preview */
  GEMINI_3_FLASH_PREVIEW: 'gemini-3-flash-preview',
  /** Gemini 2.5 Pro */
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
  /** Claude 4.6 Opus (Thinking) (default) */
  OPUS_4_6_THINKING: 'opus-4.6-thinking',
  /** Claude 4.6 Opus */
  OPUS_4_6: 'opus-4.6',
  /** Claude 4.5 Opus */
  OPUS_4_5: 'opus-4.5',
  /** Claude 4.5 Opus (Thinking) */
  OPUS_4_5_THINKING: 'opus-4.5-thinking',
  /** Claude 4.6 Sonnet */
  SONNET_4_6: 'sonnet-4.6',
  /** Claude 4.6 Sonnet (Thinking) */
  SONNET_4_6_THINKING: 'sonnet-4.6-thinking',
  /** Claude 4.5 Sonnet */
  SONNET_4_5: 'sonnet-4.5',
  /** Claude 4.5 Sonnet (Thinking) */
  SONNET_4_5_THINKING: 'sonnet-4.5-thinking',
  /** Composer 1.5 */
  COMPOSER_1_5: 'composer-1.5',
  /** Composer 1 */
  COMPOSER_1: 'composer-1',
  /** GPT-5.4 Extra High */
  GPT_5_4_XHIGH: 'gpt-5.4-xhigh',
  /** GPT-5.4 Extra High Fast */
  GPT_5_4_XHIGH_FAST: 'gpt-5.4-xhigh-fast',
  /** GPT-5.4 High */
  GPT_5_4_HIGH: 'gpt-5.4-high',
  /** GPT-5.4 High Fast */
  GPT_5_4_HIGH_FAST: 'gpt-5.4-high-fast',
  /** GPT-5.4 */
  GPT_5_4_MEDIUM: 'gpt-5.4-medium',
  /** GPT-5.4 Fast */
  GPT_5_4_MEDIUM_FAST: 'gpt-5.4-medium-fast',
  /** GPT-5.4 Low */
  GPT_5_4_LOW: 'gpt-5.4-low',
  /** GPT-5.3 Codex Extra High */
  GPT_5_3_CODEX_XHIGH: 'gpt-5.3-codex-xhigh',
  /** GPT-5.3 Codex Extra High Fast */
  GPT_5_3_CODEX_XHIGH_FAST: 'gpt-5.3-codex-xhigh-fast',
  /** GPT-5.3 Codex High */
  GPT_5_3_CODEX_HIGH: 'gpt-5.3-codex-high',
  /** GPT-5.3 Codex High Fast */
  GPT_5_3_CODEX_HIGH_FAST: 'gpt-5.3-codex-high-fast',
  /** GPT-5.3 Codex */
  GPT_5_3_CODEX: 'gpt-5.3-codex',
  /** GPT-5.3 Codex Fast */
  GPT_5_3_CODEX_FAST: 'gpt-5.3-codex-fast',
  /** GPT-5.3 Codex Low */
  GPT_5_3_CODEX_LOW: 'gpt-5.3-codex-low',
  /** GPT-5.3 Codex Low Fast */
  GPT_5_3_CODEX_LOW_FAST: 'gpt-5.3-codex-low-fast',
  /** GPT-5.3 Codex Spark */
  GPT_5_3_CODEX_SPARK_PREVIEW: 'gpt-5.3-codex-spark-preview',
  /** GPT-5.2 Codex Extra High */
  GPT_5_2_CODEX_XHIGH: 'gpt-5.2-codex-xhigh',
  /** GPT-5.2 Codex Extra High Fast */
  GPT_5_2_CODEX_XHIGH_FAST: 'gpt-5.2-codex-xhigh-fast',
  /** GPT-5.2 Codex High */
  GPT_5_2_CODEX_HIGH: 'gpt-5.2-codex-high',
  /** GPT-5.2 Codex High Fast */
  GPT_5_2_CODEX_HIGH_FAST: 'gpt-5.2-codex-high-fast',
  /** GPT-5.2 Codex */
  GPT_5_2_CODEX: 'gpt-5.2-codex',
  /** GPT-5.2 Codex Fast */
  GPT_5_2_CODEX_FAST: 'gpt-5.2-codex-fast',
  /** GPT-5.2 Codex Low */
  GPT_5_2_CODEX_LOW: 'gpt-5.2-codex-low',
  /** GPT-5.2 Codex Low Fast */
  GPT_5_2_CODEX_LOW_FAST: 'gpt-5.2-codex-low-fast',
  /** GPT-5.2 */
  GPT_5_2: 'gpt-5.2',
  /** GPT-5.2 High */
  GPT_5_2_HIGH: 'gpt-5.2-high',
  /** GPT-5.1 Codex Max */
  GPT_5_1_CODEX_MAX: 'gpt-5.1-codex-max',
  /** GPT-5.1 Codex Max High */
  GPT_5_1_CODEX_MAX_HIGH: 'gpt-5.1-codex-max-high',
  /** GPT-5.1 Codex Mini */
  GPT_5_1_CODEX_MINI: 'gpt-5.1-codex-mini',
  /** GPT-5.1 High */
  GPT_5_1_HIGH: 'gpt-5.1-high',
  /** Gemini 3.1 Pro */
  GEMINI_3_1_PRO: 'gemini-3.1-pro',
  /** Gemini 3 Pro */
  GEMINI_3_PRO: 'gemini-3-pro',
  /** Gemini 3 Flash */
  GEMINI_3_FLASH: 'gemini-3-flash',
  /** Grok */
  GROK: 'grok',
  /** Kimi K2.5 */
  KIMI_K2_5: 'kimi-k2.5',
} as const;

export type CursorModel = (typeof CursorModels)[keyof typeof CursorModels];

/**
 * Droid model identifiers.
 */
export const DroidModels = {
  /** Opus 4.6 Fast Mode (12x) (default) */
  OPUS_4_6_FAST: 'opus-4.6-fast',
  /** Opus 4.5 (2x) */
  OPUS_4_5: 'opus-4.5',
  /** Sonnet 4.5 (1.2x) */
  SONNET_4_5: 'sonnet-4.5',
  /** Haiku 4.5 (0.4x) */
  HAIKU_4_5: 'haiku-4.5',
  /** GPT-5.2 (0.7x) */
  GPT_5_2: 'gpt-5.2',
  /** GPT-5.2 Codex (0.7x) */
  GPT_5_2_CODEX: 'gpt-5.2-codex',
  /** Gemini 3 Flash (0.2x) */
  GEMINI_3_FLASH: 'gemini-3-flash',
  /** Droid Core (GLM-4.7) (0.25x) */
  DROID_CORE: 'droid-core-glm-4.7',
} as const;

export type DroidModel = (typeof DroidModels)[keyof typeof DroidModels];

/**
 * OpenCode model identifiers.
 */
export const OpencodeModels = {
  /** Big Pickle */
  OPENCODE_BIG_PICKLE: 'opencode/big-pickle',
  /** GPT-5 Nano (OpenCode) */
  OPENCODE_GPT_5_NANO: 'opencode/gpt-5-nano',
  /** Mimo V2 Flash Free */
  OPENCODE_MIMO_V2_FLASH_FREE: 'opencode/mimo-v2-flash-free',
  /** MiniMax M2.5 Free */
  OPENCODE_MINIMAX_M2_5_FREE: 'opencode/minimax-m2.5-free',
  /** Codex Mini Latest */
  OPENAI_CODEX_MINI_LATEST: 'openai/codex-mini-latest',
  /** GPT-3.5 Turbo */
  OPENAI_GPT_3_5_TURBO: 'openai/gpt-3.5-turbo',
  /** GPT-4 */
  OPENAI_GPT_4: 'openai/gpt-4',
  /** GPT-4 Turbo */
  OPENAI_GPT_4_TURBO: 'openai/gpt-4-turbo',
  /** GPT-4.1 */
  OPENAI_GPT_4_1: 'openai/gpt-4.1',
  /** GPT-4.1 Mini */
  OPENAI_GPT_4_1_MINI: 'openai/gpt-4.1-mini',
  /** GPT-4.1 Nano */
  OPENAI_GPT_4_1_NANO: 'openai/gpt-4.1-nano',
  /** GPT-4o */
  OPENAI_GPT_4O: 'openai/gpt-4o',
  /** GPT-4o (2024-05-13) */
  OPENAI_GPT_4O_2024_05_13: 'openai/gpt-4o-2024-05-13',
  /** GPT-4o (2024-08-06) */
  OPENAI_GPT_4O_2024_08_06: 'openai/gpt-4o-2024-08-06',
  /** GPT-4o (2024-11-20) */
  OPENAI_GPT_4O_2024_11_20: 'openai/gpt-4o-2024-11-20',
  /** GPT-4o Mini */
  OPENAI_GPT_4O_MINI: 'openai/gpt-4o-mini',
  /** GPT-5 */
  OPENAI_GPT_5: 'openai/gpt-5',
  /** GPT-5 Codex */
  OPENAI_GPT_5_CODEX: 'openai/gpt-5-codex',
  /** GPT-5 Mini */
  OPENAI_GPT_5_MINI: 'openai/gpt-5-mini',
  /** GPT-5 Nano */
  OPENAI_GPT_5_NANO: 'openai/gpt-5-nano',
  /** GPT-5 Pro */
  OPENAI_GPT_5_PRO: 'openai/gpt-5-pro',
  /** GPT-5.1 */
  OPENAI_GPT_5_1: 'openai/gpt-5.1',
  /** GPT-5.1 Chat Latest */
  OPENAI_GPT_5_1_CHAT_LATEST: 'openai/gpt-5.1-chat-latest',
  /** GPT-5.1 Codex */
  OPENAI_GPT_5_1_CODEX: 'openai/gpt-5.1-codex',
  /** GPT-5.1 Codex Max */
  OPENAI_GPT_5_1_CODEX_MAX: 'openai/gpt-5.1-codex-max',
  /** GPT-5.1 Codex Mini */
  OPENAI_GPT_5_1_CODEX_MINI: 'openai/gpt-5.1-codex-mini',
  /** GPT-5.2 (default) */
  OPENAI_GPT_5_2: 'openai/gpt-5.2',
  /** GPT-5.2 Chat Latest */
  OPENAI_GPT_5_2_CHAT_LATEST: 'openai/gpt-5.2-chat-latest',
  /** GPT-5.2 Codex */
  OPENAI_GPT_5_2_CODEX: 'openai/gpt-5.2-codex',
  /** GPT-5.2 Pro */
  OPENAI_GPT_5_2_PRO: 'openai/gpt-5.2-pro',
  /** GPT-5.3 Codex */
  OPENAI_GPT_5_3_CODEX: 'openai/gpt-5.3-codex',
  /** GPT-5.3 Codex Spark */
  OPENAI_GPT_5_3_CODEX_SPARK: 'openai/gpt-5.3-codex-spark',
  /** GPT-5.4 */
  OPENAI_GPT_5_4: 'openai/gpt-5.4',
  /** GPT-5.4 Pro */
  OPENAI_GPT_5_4_PRO: 'openai/gpt-5.4-pro',
  /** O1 */
  OPENAI_O1: 'openai/o1',
  /** O1 Mini */
  OPENAI_O1_MINI: 'openai/o1-mini',
  /** O1 Preview */
  OPENAI_O1_PREVIEW: 'openai/o1-preview',
  /** O1 Pro */
  OPENAI_O1_PRO: 'openai/o1-pro',
  /** O3 */
  OPENAI_O3: 'openai/o3',
  /** O3 Deep Research */
  OPENAI_O3_DEEP_RESEARCH: 'openai/o3-deep-research',
  /** O3 Mini */
  OPENAI_O3_MINI: 'openai/o3-mini',
  /** O3 Pro */
  OPENAI_O3_PRO: 'openai/o3-pro',
  /** O4 Mini */
  OPENAI_O4_MINI: 'openai/o4-mini',
  /** O4 Mini Deep Research */
  OPENAI_O4_MINI_DEEP_RESEARCH: 'openai/o4-mini-deep-research',
} as const;

export type OpencodeModel = (typeof OpencodeModels)[keyof typeof OpencodeModels];

/** Reasoning effort levels supported by model providers. */
export const ReasoningEfforts = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
} as const;

export type ReasoningEffort = (typeof ReasoningEfforts)[keyof typeof ReasoningEfforts];

/** Model option type for UI dropdowns and model capability metadata. */
export interface ModelOption {
  value: string;
  label: string;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
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
  { value: 'gpt-5.4', label: 'GPT-5.4 — Latest frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark — Ultra-fast coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.2', label: 'GPT-5.2 — Frontier model, knowledge & reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max — Deep and fast reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini — Cheaper, faster', reasoningEfforts: ["medium","high"], defaultReasoningEffort: 'high' },
];

/**
 * Gemini CLI model options for UI dropdowns.
 */
export const GEMINI_MODEL_OPTIONS: ModelOption[] = [
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
];

/**
 * Cursor model options for UI dropdowns.
 */
export const CURSOR_MODEL_OPTIONS: ModelOption[] = [
  { value: 'opus-4.6-thinking', label: 'Claude 4.6 Opus (Thinking)' },
  { value: 'opus-4.6', label: 'Claude 4.6 Opus' },
  { value: 'opus-4.5', label: 'Claude 4.5 Opus' },
  { value: 'opus-4.5-thinking', label: 'Claude 4.5 Opus (Thinking)' },
  { value: 'sonnet-4.6', label: 'Claude 4.6 Sonnet' },
  { value: 'sonnet-4.6-thinking', label: 'Claude 4.6 Sonnet (Thinking)' },
  { value: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
  { value: 'sonnet-4.5-thinking', label: 'Claude 4.5 Sonnet (Thinking)' },
  { value: 'composer-1.5', label: 'Composer 1.5' },
  { value: 'composer-1', label: 'Composer 1' },
  { value: 'gpt-5.4-xhigh', label: 'GPT-5.4 Extra High' },
  { value: 'gpt-5.4-xhigh-fast', label: 'GPT-5.4 Extra High Fast' },
  { value: 'gpt-5.4-high', label: 'GPT-5.4 High' },
  { value: 'gpt-5.4-high-fast', label: 'GPT-5.4 High Fast' },
  { value: 'gpt-5.4-medium', label: 'GPT-5.4' },
  { value: 'gpt-5.4-medium-fast', label: 'GPT-5.4 Fast' },
  { value: 'gpt-5.4-low', label: 'GPT-5.4 Low' },
  { value: 'gpt-5.3-codex-xhigh', label: 'GPT-5.3 Codex Extra High' },
  { value: 'gpt-5.3-codex-xhigh-fast', label: 'GPT-5.3 Codex Extra High Fast' },
  { value: 'gpt-5.3-codex-high', label: 'GPT-5.3 Codex High' },
  { value: 'gpt-5.3-codex-high-fast', label: 'GPT-5.3 Codex High Fast' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-fast', label: 'GPT-5.3 Codex Fast' },
  { value: 'gpt-5.3-codex-low', label: 'GPT-5.3 Codex Low' },
  { value: 'gpt-5.3-codex-low-fast', label: 'GPT-5.3 Codex Low Fast' },
  { value: 'gpt-5.3-codex-spark-preview', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.2-codex-xhigh', label: 'GPT-5.2 Codex Extra High' },
  { value: 'gpt-5.2-codex-xhigh-fast', label: 'GPT-5.2 Codex Extra High Fast' },
  { value: 'gpt-5.2-codex-high', label: 'GPT-5.2 Codex High' },
  { value: 'gpt-5.2-codex-high-fast', label: 'GPT-5.2 Codex High Fast' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'gpt-5.2-codex-fast', label: 'GPT-5.2 Codex Fast' },
  { value: 'gpt-5.2-codex-low', label: 'GPT-5.2 Codex Low' },
  { value: 'gpt-5.2-codex-low-fast', label: 'GPT-5.2 Codex Low Fast' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.2-high', label: 'GPT-5.2 High' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { value: 'gpt-5.1-codex-max-high', label: 'GPT-5.1 Codex Max High' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  { value: 'gpt-5.1-high', label: 'GPT-5.1 High' },
  { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { value: 'grok', label: 'Grok' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5' },
];

/**
 * Droid model options for UI dropdowns.
 */
export const DROID_MODEL_OPTIONS: ModelOption[] = [
  { value: 'opus-4.6-fast', label: 'Opus 4.6 Fast Mode (12x)' },
  { value: 'opus-4.5', label: 'Opus 4.5 (2x)' },
  { value: 'sonnet-4.5', label: 'Sonnet 4.5 (1.2x)' },
  { value: 'haiku-4.5', label: 'Haiku 4.5 (0.4x)' },
  { value: 'gpt-5.2', label: 'GPT-5.2 (0.7x)' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex (0.7x)' },
  { value: 'gemini-3-flash', label: 'Gemini 3 Flash (0.2x)' },
  { value: 'droid-core-glm-4.7', label: 'Droid Core (GLM-4.7) (0.25x)' },
];

/**
 * OpenCode model options for UI dropdowns.
 */
export const OPENCODE_MODEL_OPTIONS: ModelOption[] = [
  { value: 'opencode/big-pickle', label: 'Big Pickle' },
  { value: 'opencode/gpt-5-nano', label: 'GPT-5 Nano (OpenCode)' },
  { value: 'opencode/mimo-v2-flash-free', label: 'Mimo V2 Flash Free' },
  { value: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5 Free' },
  { value: 'openai/codex-mini-latest', label: 'Codex Mini Latest' },
  { value: 'openai/gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  { value: 'openai/gpt-4', label: 'GPT-4' },
  { value: 'openai/gpt-4-turbo', label: 'GPT-4 Turbo' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
  { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { value: 'openai/gpt-4.1-nano', label: 'GPT-4.1 Nano' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-2024-05-13', label: 'GPT-4o (2024-05-13)' },
  { value: 'openai/gpt-4o-2024-08-06', label: 'GPT-4o (2024-08-06)' },
  { value: 'openai/gpt-4o-2024-11-20', label: 'GPT-4o (2024-11-20)' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'openai/gpt-5', label: 'GPT-5' },
  { value: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'openai/gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'openai/gpt-5-pro', label: 'GPT-5 Pro' },
  { value: 'openai/gpt-5.1', label: 'GPT-5.1' },
  { value: 'openai/gpt-5.1-chat-latest', label: 'GPT-5.1 Chat Latest' },
  { value: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { value: 'openai/gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { value: 'openai/gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  { value: 'openai/gpt-5.2', label: 'GPT-5.2' },
  { value: 'openai/gpt-5.2-chat-latest', label: 'GPT-5.2 Chat Latest' },
  { value: 'openai/gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'openai/gpt-5.2-pro', label: 'GPT-5.2 Pro' },
  { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { value: 'openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
  { value: 'openai/o1', label: 'O1' },
  { value: 'openai/o1-mini', label: 'O1 Mini' },
  { value: 'openai/o1-preview', label: 'O1 Preview' },
  { value: 'openai/o1-pro', label: 'O1 Pro' },
  { value: 'openai/o3', label: 'O3' },
  { value: 'openai/o3-deep-research', label: 'O3 Deep Research' },
  { value: 'openai/o3-mini', label: 'O3 Mini' },
  { value: 'openai/o3-pro', label: 'O3 Pro' },
  { value: 'openai/o4-mini', label: 'O4 Mini' },
  { value: 'openai/o4-mini-deep-research', label: 'O4 Mini Deep Research' },
];

/**
 * Claude Code model metadata keyed by model id.
 */
export const CLAUDE_MODEL_METADATA: Record<ClaudeModel, ModelOption> = {
  'sonnet': { value: 'sonnet', label: 'Sonnet' },
  'opus': { value: 'opus', label: 'Opus' },
  'haiku': { value: 'haiku', label: 'Haiku' },
};

/**
 * Codex CLI model metadata keyed by model id.
 */
export const CODEX_MODEL_METADATA: Record<CodexModel, ModelOption> = {
  'gpt-5.4': { value: 'gpt-5.4', label: 'GPT-5.4 — Latest frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.3-codex': { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.3-codex-spark': { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark — Ultra-fast coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.2-codex': { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.2': { value: 'gpt-5.2', label: 'GPT-5.2 — Frontier model, knowledge & reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.1-codex-max': { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max — Deep and fast reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.1-codex-mini': { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini — Cheaper, faster', reasoningEfforts: ["medium","high"], defaultReasoningEffort: 'high' },
};

/**
 * Gemini CLI model metadata keyed by model id.
 */
export const GEMINI_MODEL_METADATA: Record<GeminiModel, ModelOption> = {
  'gemini-3.1-pro-preview': { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
  'gemini-3-flash-preview': { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  'gemini-2.5-pro': { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash': { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  'gemini-2.5-flash-lite': { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
};

/**
 * Cursor model metadata keyed by model id.
 */
export const CURSOR_MODEL_METADATA: Record<CursorModel, ModelOption> = {
  'opus-4.6-thinking': { value: 'opus-4.6-thinking', label: 'Claude 4.6 Opus (Thinking)' },
  'opus-4.6': { value: 'opus-4.6', label: 'Claude 4.6 Opus' },
  'opus-4.5': { value: 'opus-4.5', label: 'Claude 4.5 Opus' },
  'opus-4.5-thinking': { value: 'opus-4.5-thinking', label: 'Claude 4.5 Opus (Thinking)' },
  'sonnet-4.6': { value: 'sonnet-4.6', label: 'Claude 4.6 Sonnet' },
  'sonnet-4.6-thinking': { value: 'sonnet-4.6-thinking', label: 'Claude 4.6 Sonnet (Thinking)' },
  'sonnet-4.5': { value: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
  'sonnet-4.5-thinking': { value: 'sonnet-4.5-thinking', label: 'Claude 4.5 Sonnet (Thinking)' },
  'composer-1.5': { value: 'composer-1.5', label: 'Composer 1.5' },
  'composer-1': { value: 'composer-1', label: 'Composer 1' },
  'gpt-5.4-xhigh': { value: 'gpt-5.4-xhigh', label: 'GPT-5.4 Extra High' },
  'gpt-5.4-xhigh-fast': { value: 'gpt-5.4-xhigh-fast', label: 'GPT-5.4 Extra High Fast' },
  'gpt-5.4-high': { value: 'gpt-5.4-high', label: 'GPT-5.4 High' },
  'gpt-5.4-high-fast': { value: 'gpt-5.4-high-fast', label: 'GPT-5.4 High Fast' },
  'gpt-5.4-medium': { value: 'gpt-5.4-medium', label: 'GPT-5.4' },
  'gpt-5.4-medium-fast': { value: 'gpt-5.4-medium-fast', label: 'GPT-5.4 Fast' },
  'gpt-5.4-low': { value: 'gpt-5.4-low', label: 'GPT-5.4 Low' },
  'gpt-5.3-codex-xhigh': { value: 'gpt-5.3-codex-xhigh', label: 'GPT-5.3 Codex Extra High' },
  'gpt-5.3-codex-xhigh-fast': { value: 'gpt-5.3-codex-xhigh-fast', label: 'GPT-5.3 Codex Extra High Fast' },
  'gpt-5.3-codex-high': { value: 'gpt-5.3-codex-high', label: 'GPT-5.3 Codex High' },
  'gpt-5.3-codex-high-fast': { value: 'gpt-5.3-codex-high-fast', label: 'GPT-5.3 Codex High Fast' },
  'gpt-5.3-codex': { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  'gpt-5.3-codex-fast': { value: 'gpt-5.3-codex-fast', label: 'GPT-5.3 Codex Fast' },
  'gpt-5.3-codex-low': { value: 'gpt-5.3-codex-low', label: 'GPT-5.3 Codex Low' },
  'gpt-5.3-codex-low-fast': { value: 'gpt-5.3-codex-low-fast', label: 'GPT-5.3 Codex Low Fast' },
  'gpt-5.3-codex-spark-preview': { value: 'gpt-5.3-codex-spark-preview', label: 'GPT-5.3 Codex Spark' },
  'gpt-5.2-codex-xhigh': { value: 'gpt-5.2-codex-xhigh', label: 'GPT-5.2 Codex Extra High' },
  'gpt-5.2-codex-xhigh-fast': { value: 'gpt-5.2-codex-xhigh-fast', label: 'GPT-5.2 Codex Extra High Fast' },
  'gpt-5.2-codex-high': { value: 'gpt-5.2-codex-high', label: 'GPT-5.2 Codex High' },
  'gpt-5.2-codex-high-fast': { value: 'gpt-5.2-codex-high-fast', label: 'GPT-5.2 Codex High Fast' },
  'gpt-5.2-codex': { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  'gpt-5.2-codex-fast': { value: 'gpt-5.2-codex-fast', label: 'GPT-5.2 Codex Fast' },
  'gpt-5.2-codex-low': { value: 'gpt-5.2-codex-low', label: 'GPT-5.2 Codex Low' },
  'gpt-5.2-codex-low-fast': { value: 'gpt-5.2-codex-low-fast', label: 'GPT-5.2 Codex Low Fast' },
  'gpt-5.2': { value: 'gpt-5.2', label: 'GPT-5.2' },
  'gpt-5.2-high': { value: 'gpt-5.2-high', label: 'GPT-5.2 High' },
  'gpt-5.1-codex-max': { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  'gpt-5.1-codex-max-high': { value: 'gpt-5.1-codex-max-high', label: 'GPT-5.1 Codex Max High' },
  'gpt-5.1-codex-mini': { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  'gpt-5.1-high': { value: 'gpt-5.1-high', label: 'GPT-5.1 High' },
  'gemini-3.1-pro': { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  'gemini-3-pro': { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  'gemini-3-flash': { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  'grok': { value: 'grok', label: 'Grok' },
  'kimi-k2.5': { value: 'kimi-k2.5', label: 'Kimi K2.5' },
};

/**
 * Droid model metadata keyed by model id.
 */
export const DROID_MODEL_METADATA: Record<DroidModel, ModelOption> = {
  'opus-4.6-fast': { value: 'opus-4.6-fast', label: 'Opus 4.6 Fast Mode (12x)' },
  'opus-4.5': { value: 'opus-4.5', label: 'Opus 4.5 (2x)' },
  'sonnet-4.5': { value: 'sonnet-4.5', label: 'Sonnet 4.5 (1.2x)' },
  'haiku-4.5': { value: 'haiku-4.5', label: 'Haiku 4.5 (0.4x)' },
  'gpt-5.2': { value: 'gpt-5.2', label: 'GPT-5.2 (0.7x)' },
  'gpt-5.2-codex': { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex (0.7x)' },
  'gemini-3-flash': { value: 'gemini-3-flash', label: 'Gemini 3 Flash (0.2x)' },
  'droid-core-glm-4.7': { value: 'droid-core-glm-4.7', label: 'Droid Core (GLM-4.7) (0.25x)' },
};

/**
 * OpenCode model metadata keyed by model id.
 */
export const OPENCODE_MODEL_METADATA: Record<OpencodeModel, ModelOption> = {
  'opencode/big-pickle': { value: 'opencode/big-pickle', label: 'Big Pickle' },
  'opencode/gpt-5-nano': { value: 'opencode/gpt-5-nano', label: 'GPT-5 Nano (OpenCode)' },
  'opencode/mimo-v2-flash-free': { value: 'opencode/mimo-v2-flash-free', label: 'Mimo V2 Flash Free' },
  'opencode/minimax-m2.5-free': { value: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5 Free' },
  'openai/codex-mini-latest': { value: 'openai/codex-mini-latest', label: 'Codex Mini Latest' },
  'openai/gpt-3.5-turbo': { value: 'openai/gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  'openai/gpt-4': { value: 'openai/gpt-4', label: 'GPT-4' },
  'openai/gpt-4-turbo': { value: 'openai/gpt-4-turbo', label: 'GPT-4 Turbo' },
  'openai/gpt-4.1': { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
  'openai/gpt-4.1-mini': { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  'openai/gpt-4.1-nano': { value: 'openai/gpt-4.1-nano', label: 'GPT-4.1 Nano' },
  'openai/gpt-4o': { value: 'openai/gpt-4o', label: 'GPT-4o' },
  'openai/gpt-4o-2024-05-13': { value: 'openai/gpt-4o-2024-05-13', label: 'GPT-4o (2024-05-13)' },
  'openai/gpt-4o-2024-08-06': { value: 'openai/gpt-4o-2024-08-06', label: 'GPT-4o (2024-08-06)' },
  'openai/gpt-4o-2024-11-20': { value: 'openai/gpt-4o-2024-11-20', label: 'GPT-4o (2024-11-20)' },
  'openai/gpt-4o-mini': { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  'openai/gpt-5': { value: 'openai/gpt-5', label: 'GPT-5' },
  'openai/gpt-5-codex': { value: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
  'openai/gpt-5-mini': { value: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
  'openai/gpt-5-nano': { value: 'openai/gpt-5-nano', label: 'GPT-5 Nano' },
  'openai/gpt-5-pro': { value: 'openai/gpt-5-pro', label: 'GPT-5 Pro' },
  'openai/gpt-5.1': { value: 'openai/gpt-5.1', label: 'GPT-5.1' },
  'openai/gpt-5.1-chat-latest': { value: 'openai/gpt-5.1-chat-latest', label: 'GPT-5.1 Chat Latest' },
  'openai/gpt-5.1-codex': { value: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  'openai/gpt-5.1-codex-max': { value: 'openai/gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  'openai/gpt-5.1-codex-mini': { value: 'openai/gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
  'openai/gpt-5.2': { value: 'openai/gpt-5.2', label: 'GPT-5.2' },
  'openai/gpt-5.2-chat-latest': { value: 'openai/gpt-5.2-chat-latest', label: 'GPT-5.2 Chat Latest' },
  'openai/gpt-5.2-codex': { value: 'openai/gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  'openai/gpt-5.2-pro': { value: 'openai/gpt-5.2-pro', label: 'GPT-5.2 Pro' },
  'openai/gpt-5.3-codex': { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  'openai/gpt-5.3-codex-spark': { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  'openai/gpt-5.4': { value: 'openai/gpt-5.4', label: 'GPT-5.4' },
  'openai/gpt-5.4-pro': { value: 'openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
  'openai/o1': { value: 'openai/o1', label: 'O1' },
  'openai/o1-mini': { value: 'openai/o1-mini', label: 'O1 Mini' },
  'openai/o1-preview': { value: 'openai/o1-preview', label: 'O1 Preview' },
  'openai/o1-pro': { value: 'openai/o1-pro', label: 'O1 Pro' },
  'openai/o3': { value: 'openai/o3', label: 'O3' },
  'openai/o3-deep-research': { value: 'openai/o3-deep-research', label: 'O3 Deep Research' },
  'openai/o3-mini': { value: 'openai/o3-mini', label: 'O3 Mini' },
  'openai/o3-pro': { value: 'openai/o3-pro', label: 'O3 Pro' },
  'openai/o4-mini': { value: 'openai/o4-mini', label: 'O4 Mini' },
  'openai/o4-mini-deep-research': { value: 'openai/o4-mini-deep-research', label: 'O4 Mini Deep Research' },
};

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
  Droid: DroidModels,
  Opencode: OpencodeModels,
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
  Droid: DROID_MODEL_OPTIONS,
  Opencode: OPENCODE_MODEL_OPTIONS,
} as const;

/**
 * All model metadata grouped by CLI tool and keyed by model id.
 */
export const ModelMetadata = {
  Claude: CLAUDE_MODEL_METADATA,
  Codex: CODEX_MODEL_METADATA,
  Gemini: GEMINI_MODEL_METADATA,
  Cursor: CURSOR_MODEL_METADATA,
  Droid: DROID_MODEL_METADATA,
  Opencode: OPENCODE_MODEL_METADATA,
} as const;

const MODEL_METADATA_BY_CLI: Record<CLI, Record<string, ModelOption>> = {
  claude: CLAUDE_MODEL_METADATA,
  codex: CODEX_MODEL_METADATA,
  gemini: GEMINI_MODEL_METADATA,
  cursor: CURSOR_MODEL_METADATA,
  droid: DROID_MODEL_METADATA,
  opencode: OPENCODE_MODEL_METADATA,
  aider: {},
  goose: {},
};

/**
 * Look up metadata for a specific CLI/model pair.
 */
export function getModelMetadata(cli: CLI, model: string): ModelOption | undefined {
  return MODEL_METADATA_BY_CLI[cli]?.[model];
}

/**
 * Supported reasoning effort values for a specific CLI/model pair.
 */
export function getSupportedReasoningEfforts(
  cli: CLI,
  model: string
): ReasoningEffort[] | undefined {
  return getModelMetadata(cli, model)?.reasoningEfforts;
}

/**
 * Default reasoning effort for a specific CLI/model pair.
 */
export function getDefaultReasoningEffort(
  cli: CLI,
  model: string
): ReasoningEffort | undefined {
  return getModelMetadata(cli, model)?.defaultReasoningEffort;
}

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
    version: '2.1.72',
    install: 'npm install -g @anthropic-ai/claude-code',
    npmLink: 'https://www.npmjs.com/package/@anthropic-ai',
  },
  codex: {
    name: 'Codex CLI',
    package: '@openai/codex',
    version: '0.114.0',
    install: 'npm install -g @openai/codex',
    npmLink: 'https://www.npmjs.com/package/@openai/codex',
  },
  gemini: {
    name: 'Gemini CLI',
    package: '@google/gemini-cli',
    version: '0.33.0',
    install: 'npm install -g @google/gemini-cli',
    npmLink: 'https://www.npmjs.com/package/@google/gemini-cli',
  },
  cursor: {
    name: 'Cursor',
    package: 'cursor',
    version: '2026.02.27-e7d2ef6',
    install: 'Download from cursor.com',
    npmLink: undefined,
  },
  droid: {
    name: 'Droid',
    package: 'droid',
    version: '0.1.0',
    install: 'Download from droid.dev',
    npmLink: undefined,
  },
  opencode: {
    name: 'OpenCode',
    package: 'opencode-ai',
    version: '1.2.24',
    install: 'npm install -g opencode-ai',
    npmLink: 'https://www.npmjs.com/package/opencode-ai',
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
  codex: 'gpt-5.4',
  gemini: 'gemini-3.1-pro-preview',
  cursor: 'opus-4.6-thinking',
  droid: 'opus-4.6-fast',
  opencode: 'openai/gpt-5.2',
} as const;
