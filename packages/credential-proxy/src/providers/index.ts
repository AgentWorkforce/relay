import { anthropicProviderAdapter } from './anthropic.js';
import { openAIProviderAdapter } from './openai.js';
import { openRouterProviderAdapter } from './openrouter.js';
import type { ProviderAdapter } from './types.js';

export { AnthropicProviderAdapter, anthropicProviderAdapter } from './anthropic.js';
export { OpenAIProviderAdapter, openAIProviderAdapter } from './openai.js';
export { OpenRouterProviderAdapter, openRouterProviderAdapter } from './openrouter.js';
export * from './types.js';

export const providerRegistry: ProviderAdapter[] = [
  anthropicProviderAdapter,
  openAIProviderAdapter,
  openRouterProviderAdapter,
];

export function resolveProviderByName(name: ProviderAdapter['name']): ProviderAdapter {
  const adapter = providerRegistry.find((candidate) => candidate.name === name);

  if (!adapter) {
    throw new Error(`Unsupported provider: ${name}`);
  }

  return adapter;
}

export function resolveProvider(path: string): ProviderAdapter {
  const adapter = providerRegistry.find((candidate) => candidate.matchesPath(path));

  if (!adapter) {
    throw new Error(`Unsupported provider path: ${path}`);
  }

  return adapter;
}
