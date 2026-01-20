/**
 * Model Mapping
 *
 * Maps agent profile model identifiers to CLI variants.
 */

const MODEL_TO_CLI: Record<string, string> = {
  'claude-sonnet-4': 'claude:sonnet',
  'claude-opus-4': 'claude:opus',
  'codex': 'codex',
};

/**
 * Convert a model identifier into the CLI command variant.
 * Defaults to claude:sonnet when no match is found.
 */
export function mapModelToCli(model?: string): string {
  if (!model) {
    return 'claude:sonnet';
  }

  const normalized = model.trim().toLowerCase();
  return MODEL_TO_CLI[normalized] ?? 'claude:sonnet';
}
