export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

// Standard per-1M token pricing for the short model aliases used by the CLI,
// plus a few full IDs already present elsewhere in the repo.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  '2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
  o3: { inputPer1M: 1, outputPer1M: 4 },
  'openai/o3': { inputPer1M: 1, outputPer1M: 4 },
  'opus-4': { inputPer1M: 15, outputPer1M: 75 },
  'sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
};

export const CLI_DEFAULT_MODEL = {
  claude: 'opus-4',
  codex: 'o3',
  gemini: '2.5-pro',
  aider: 'sonnet-4',
} as const;

const INPUT_TOKENS_PER_SECOND = 200;
const OUTPUT_TOKENS_PER_SECOND = 75;

function normalizeModel(model: string): string {
  const normalized = model.trim().toLowerCase();

  switch (normalized) {
    case 'gemini-2.5-pro':
    case '2.5-pro':
      return '2.5-pro';
    case 'claude-opus-4':
    case 'claude-opus-4-20250514':
    case 'opus-4':
      return 'opus-4';
    case 'claude-sonnet-4':
    case 'claude-sonnet-4-20250514':
    case 'sonnet-4':
      return 'sonnet-4';
    case 'openai/o3':
    case 'o3':
      return 'o3';
    default:
      return normalized;
  }
}

export function estimateTokensFromDuration(durationMs: number): TokenEstimate {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const seconds = durationMs / 1_000;

  return {
    inputTokens: Math.round(seconds * INPUT_TOKENS_PER_SECOND),
    outputTokens: Math.round(seconds * OUTPUT_TOKENS_PER_SECOND),
  };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[normalizeModel(model)];
  if (!pricing) {
    return 0;
  }

  const safeInputTokens = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const safeOutputTokens = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  const total =
    (safeInputTokens / 1_000_000) * pricing.inputPer1M +
    (safeOutputTokens / 1_000_000) * pricing.outputPer1M;

  return Math.round(total * 1_000_000) / 1_000_000;
}
