/**
 * Model Mapping
 *
 * Maps agent profile model identifiers to CLI variants.
 * Used for cost tracking and model selection when spawning agents.
 */

/**
 * Mapping from model identifiers to CLI command variants.
 * Keys are normalized model names, values are CLI command variants.
 */
const MODEL_TO_CLI: Record<string, string> = {
  // Claude models
  'claude-sonnet-4': 'claude:sonnet',
  'claude-opus-4': 'claude:opus',
  'claude-opus-4.5': 'claude:opus',
  'sonnet': 'claude:sonnet',
  'opus': 'claude:opus',
  'haiku': 'claude:haiku',
  // Codex (OpenAI)
  'codex': 'codex',
  'gpt-4o': 'codex',
  // Gemini (Google)
  'gemini': 'gemini',
  'gemini-2.0-flash': 'gemini',
};

/**
 * Convert a model identifier into the CLI command variant.
 * Defaults to 'claude:sonnet' when no match is found.
 *
 * @param model - Model identifier from agent profile (e.g., 'claude-opus-4', 'sonnet')
 * @returns CLI command variant (e.g., 'claude:opus', 'claude:sonnet')
 *
 * @example
 * mapModelToCli('claude-opus-4')     // Returns 'claude:opus'
 * mapModelToCli('sonnet')            // Returns 'claude:sonnet'
 * mapModelToCli('gpt-4o')            // Returns 'codex'
 * mapModelToCli(undefined)           // Returns 'claude:sonnet'
 */
export function mapModelToCli(model?: string): string {
  if (!model) {
    return 'claude:sonnet';
  }

  const normalized = model.trim().toLowerCase();
  return MODEL_TO_CLI[normalized] ?? 'claude:sonnet';
}

/**
 * Extract the base CLI name from a model-mapped CLI variant.
 *
 * @param cliVariant - CLI variant (e.g., 'claude:opus', 'claude', 'codex')
 * @returns Base CLI name (e.g., 'claude', 'codex')
 */
export function getBaseCli(cliVariant: string): string {
  return cliVariant.split(':')[0];
}
