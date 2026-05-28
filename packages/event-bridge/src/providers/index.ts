import type { ProviderAdapter } from '../types.js';
import { slackProvider, type SlackProviderOptions } from './slack.js';

export { slackProvider, type SlackProviderOptions };

/**
 * Names of the providers the bridge knows how to construct by string.
 * Extend this (and {@link createProvider}) as adapters are added — Linear,
 * Notion, etc. follow the same {@link ProviderAdapter} contract.
 */
export const KNOWN_PROVIDERS = ['slack'] as const;

export type KnownProviderName = (typeof KNOWN_PROVIDERS)[number];

/**
 * Construct a provider adapter by name with default options.
 * @throws if the provider name is not recognized.
 */
export function createProvider(name: string): ProviderAdapter {
  switch (name) {
    case 'slack':
      return slackProvider();
    default:
      throw new Error(`Unknown provider "${name}". Known providers: ${KNOWN_PROVIDERS.join(', ')}.`);
  }
}
