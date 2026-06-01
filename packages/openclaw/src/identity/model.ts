const DEFAULT_MODEL = 'openai-codex/gpt-5.3-codex';

/**
 * Normalize a raw model string into a fully-qualified "provider/model" reference.
 *
 * Examples:
 *   normalizeModelRef('gpt-5.3-codex', 'openai-codex') → 'openai-codex/gpt-5.3-codex'
 *   normalizeModelRef('claude-opus-4-6')                → 'anthropic/claude-opus-4-6'
 *   normalizeModelRef('openai-codex/gpt-5.3-codex')     → 'openai-codex/gpt-5.3-codex'
 *   normalizeModelRef(undefined)                         → 'openai-codex/gpt-5.3-codex'
 */
export function normalizeModelRef(rawModel?: string, providerHint?: string): string {
  const model = (rawModel ?? '').trim().toLowerCase();
  if (!model) return DEFAULT_MODEL;
  if (model.includes('/')) return model;
  if (model.includes('claude')) return `anthropic/${model}`;
  if (
    model.includes('codex') ||
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  ) {
    return (providerHint === 'openai-codex' ? 'openai-codex/' : 'openai/') + model;
  }
  return `openai/${model}`;
}
