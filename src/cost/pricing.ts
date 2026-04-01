import { DefaultModels } from '@agent-relay/config';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

// Per-1M token pricing. Model IDs match @agent-relay/config cli-registry.
// Pricing is approximate and should be updated as providers change rates.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic (Claude Code, Cursor, Droid) ──────────────────────
  'sonnet':                     { inputPer1M: 3,     outputPer1M: 15 },
  'opus':                       { inputPer1M: 15,    outputPer1M: 75 },
  'haiku':                      { inputPer1M: 0.80,  outputPer1M: 4 },
  'opus-4.6':                   { inputPer1M: 15,    outputPer1M: 75 },
  'opus-4.6-fast':              { inputPer1M: 15,    outputPer1M: 75 },
  'opus-4.6-thinking':          { inputPer1M: 15,    outputPer1M: 75 },
  'opus-4.5':                   { inputPer1M: 15,    outputPer1M: 75 },
  'opus-4.5-thinking':          { inputPer1M: 15,    outputPer1M: 75 },
  'sonnet-4.6':                 { inputPer1M: 3,     outputPer1M: 15 },
  'sonnet-4.6-thinking':        { inputPer1M: 3,     outputPer1M: 15 },
  'sonnet-4.5':                 { inputPer1M: 3,     outputPer1M: 15 },
  'sonnet-4.5-thinking':        { inputPer1M: 3,     outputPer1M: 15 },
  'haiku-4.5':                  { inputPer1M: 0.80,  outputPer1M: 4 },

  // ── OpenAI (Codex, Cursor, OpenCode) ────────────────────────────
  'gpt-5.4':                    { inputPer1M: 2.50,  outputPer1M: 10 },
  'gpt-5.3-codex':              { inputPer1M: 2.50,  outputPer1M: 10 },
  'gpt-5.3-codex-spark':        { inputPer1M: 1.50,  outputPer1M: 6 },
  'gpt-5.2-codex':              { inputPer1M: 2.50,  outputPer1M: 10 },
  'gpt-5.2':                    { inputPer1M: 2.50,  outputPer1M: 10 },
  'gpt-5.1-codex-max':          { inputPer1M: 2.50,  outputPer1M: 10 },
  'gpt-5.1-codex-mini':         { inputPer1M: 0.75,  outputPer1M: 3 },
  'openai/gpt-5.2':             { inputPer1M: 2.50,  outputPer1M: 10 },
  'openai/gpt-5.4':             { inputPer1M: 2.50,  outputPer1M: 10 },
  'openai/o3':                  { inputPer1M: 1,     outputPer1M: 4 },
  'openai/o3-mini':             { inputPer1M: 0.55,  outputPer1M: 2.20 },
  'openai/o4-mini':             { inputPer1M: 0.55,  outputPer1M: 2.20 },

  // ── Google (Gemini CLI) ─────────────────────────────────────────
  'gemini-3.1-pro-preview':     { inputPer1M: 1.25,  outputPer1M: 10 },
  'gemini-3-flash-preview':     { inputPer1M: 0.15,  outputPer1M: 0.60 },
  'gemini-2.5-pro':             { inputPer1M: 1.25,  outputPer1M: 10 },
  'gemini-2.5-flash':           { inputPer1M: 0.15,  outputPer1M: 0.60 },
  'gemini-2.5-flash-lite':      { inputPer1M: 0.075, outputPer1M: 0.30 },

  // ── Cursor composite models ─────────────────────────────────────
  'composer-1.5':               { inputPer1M: 3,     outputPer1M: 15 },
  'composer-1':                 { inputPer1M: 3,     outputPer1M: 15 },

  // ── Droid ───────────────────────────────────────────────────────
  'droid-core-glm-4.7':         { inputPer1M: 0.50,  outputPer1M: 2 },
};

// CLI → default model mapping from the registry
export const CLI_DEFAULT_MODEL: Record<string, string> = { ...DefaultModels };

// Rough token estimation from step duration.
// Heuristic: ~200 input tokens/sec (context loading) + ~75 output tokens/sec (generation).
const INPUT_TOKENS_PER_SECOND = 200;
const OUTPUT_TOKENS_PER_SECOND = 75;

/**
 * Normalize model ID to match MODEL_PRICING keys.
 * Handles common aliases and prefix variations.
 */
export function normalizeModel(model: string): string {
  const m = model.trim().toLowerCase();

  // Strip reasoning effort suffixes from Cursor model IDs
  // e.g. "gpt-5.4-xhigh" → "gpt-5.4", "gpt-5.3-codex-xhigh-fast" → "gpt-5.3-codex"
  const effortSuffixes = ['-xhigh-fast', '-xhigh', '-high-fast', '-high', '-medium-fast', '-medium', '-low-fast', '-low'];
  for (const suffix of effortSuffixes) {
    if (m.endsWith(suffix) && m.includes('gpt-')) {
      const base = m.slice(0, -suffix.length);
      if (MODEL_PRICING[base]) return base;
    }
  }

  // Direct match
  if (MODEL_PRICING[m]) return m;

  // Try with openai/ prefix stripped
  if (m.startsWith('openai/')) {
    const stripped = m.slice('openai/'.length);
    if (MODEL_PRICING[stripped]) return stripped;
  }

  // Try with openai/ prefix added
  if (!m.includes('/') && MODEL_PRICING[`openai/${m}`]) {
    return `openai/${m}`;
  }

  return m;
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
