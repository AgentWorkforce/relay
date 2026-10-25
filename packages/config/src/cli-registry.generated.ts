/**
 * CLI Registry - AUTO-GENERATED FILE - DO NOT EDIT
 * Generated from packages/utils/cli-registry.yaml
 * Run: npm run codegen:models
 *
 * This is the single source of truth for CLI tools, versions, and models.
 * Other packages should import from @agent-relay/config.
 */

/**
 * CLI tool versions.
 * Update packages/utils/cli-registry.yaml to change versions.
 */
export const CLIVersions = {
  /** Claude Code v2.1.72 */
  CLAUDE: '2.1.72',
  /** Codex CLI v0.130.0 */
  CODEX: '0.130.0',
  /** Devin v3000.10.31 */
  DEVIN: '3000.10.31',
  /** OpenCode v1.2.24 */
  OPENCODE: '1.2.24',
  /** Grok v0.1.0 */
  GROK: '0.1.0',
} as const;

/**
 * Supported CLI tools.
 */
export const CLIs = {
  CLAUDE: 'claude',
  CODEX: 'codex',
  DEVIN: 'devin',
  OPENCODE: 'opencode',
  GROK: 'grok',
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
  /** GPT-5.5 — Frontier model for complex coding, research, and real-world work. (default) */
  GPT_5_5: 'gpt-5.5',
  /** GPT-5.4 — More affordable model for complex coding and professional work. */
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
 * Devin model identifiers.
 */
export const DevinModels = {
  /** SWE-1.6 */
  SWE_1_6: 'swe-1.6',
} as const;

export type DevinModel = (typeof DevinModels)[keyof typeof DevinModels];

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
  /** GPT-5.5 */
  OPENAI_GPT_5_5: 'openai/gpt-5.5',
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

/**
 * Grok model identifiers.
 */
export const GrokModels = {
  /** Grok Build (default) */
  GROK_BUILD: 'grok-build',
  /** Grok Composer 2.5 Fast */
  GROK_COMPOSER_2_5_FAST: 'grok-composer-2.5-fast',
} as const;

export type GrokModel = (typeof GrokModels)[keyof typeof GrokModels];

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
  { value: 'gpt-5.5', label: 'GPT-5.5 — Frontier model for complex coding, research, and real-world work.', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'medium' },
  { value: 'gpt-5.4', label: 'GPT-5.4 — More affordable model for complex coding and professional work.', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark — Ultra-fast coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.2', label: 'GPT-5.2 — Frontier model, knowledge & reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max — Deep and fast reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini — Cheaper, faster', reasoningEfforts: ["medium","high"], defaultReasoningEffort: 'high' },
];

/**
 * Devin model options for UI dropdowns.
 */
export const DEVIN_MODEL_OPTIONS: ModelOption[] = [
  { value: 'swe-1.6', label: 'SWE-1.6' },
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
  { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
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
 * Grok model options for UI dropdowns.
 */
export const GROK_MODEL_OPTIONS: ModelOption[] = [
  { value: 'grok-build', label: 'Grok Build' },
  { value: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
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
  'gpt-5.5': { value: 'gpt-5.5', label: 'GPT-5.5 — Frontier model for complex coding, research, and real-world work.', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'medium' },
  'gpt-5.4': { value: 'gpt-5.4', label: 'GPT-5.4 — More affordable model for complex coding and professional work.', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.3-codex': { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.3-codex-spark': { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark — Ultra-fast coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.2-codex': { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex — Frontier agentic coding model', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.2': { value: 'gpt-5.2', label: 'GPT-5.2 — Frontier model, knowledge & reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.1-codex-max': { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max — Deep and fast reasoning', reasoningEfforts: ["low","medium","high","xhigh"], defaultReasoningEffort: 'xhigh' },
  'gpt-5.1-codex-mini': { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini — Cheaper, faster', reasoningEfforts: ["medium","high"], defaultReasoningEffort: 'high' },
};

/**
 * Devin model metadata keyed by model id.
 */
export const DEVIN_MODEL_METADATA: Record<DevinModel, ModelOption> = {
  'swe-1.6': { value: 'swe-1.6', label: 'SWE-1.6' },
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
  'openai/gpt-5.5': { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
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
 * Grok model metadata keyed by model id.
 */
export const GROK_MODEL_METADATA: Record<GrokModel, ModelOption> = {
  'grok-build': { value: 'grok-build', label: 'Grok Build' },
  'grok-composer-2.5-fast': { value: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
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
  Devin: DevinModels,
  Opencode: OpencodeModels,
  Grok: GrokModels,
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
  Devin: DEVIN_MODEL_OPTIONS,
  Opencode: OPENCODE_MODEL_OPTIONS,
  Grok: GROK_MODEL_OPTIONS,
} as const;

/**
 * All model metadata grouped by CLI tool and keyed by model id.
 */
export const ModelMetadata = {
  Claude: CLAUDE_MODEL_METADATA,
  Codex: CODEX_MODEL_METADATA,
  Devin: DEVIN_MODEL_METADATA,
  Opencode: OPENCODE_MODEL_METADATA,
  Grok: GROK_MODEL_METADATA,
} as const;

const MODEL_METADATA_BY_CLI: Record<CLI, Record<string, ModelOption>> = {
  claude: CLAUDE_MODEL_METADATA,
  codex: CODEX_MODEL_METADATA,
  devin: DEVIN_MODEL_METADATA,
  opencode: OPENCODE_MODEL_METADATA,
  grok: GROK_MODEL_METADATA,
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
    version: '0.130.0',
    install: 'npm install -g @openai/codex',
    npmLink: 'https://www.npmjs.com/package/@openai/codex',
  },
  devin: {
    name: 'Devin',
    package: 'devin',
    version: '3000.10.31',
    install: 'Install Devin CLI from https://docs.devin.ai/cli',
    npmLink: undefined,
  },
  opencode: {
    name: 'OpenCode',
    package: 'opencode-ai',
    version: '1.2.24',
    install: 'npm install -g opencode-ai',
    npmLink: 'https://www.npmjs.com/package/opencode-ai',
  },
  grok: {
    name: 'Grok',
    package: 'grok',
    version: '0.1.0',
    install: 'Install from x.ai (Grok CLI)',
    npmLink: undefined,
  },
} as const;

/**
 * Default model for each CLI tool.
 */
export const DefaultModels = {
  claude: 'sonnet',
  codex: 'gpt-5.5',
  opencode: 'openai/gpt-5.2',
  grok: 'grok-build',
} as const;
