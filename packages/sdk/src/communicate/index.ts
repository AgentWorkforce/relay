export * from './types.js';
export { Relay } from './core.js';
export { onPiRelay, onClaudeRelay } from './adapters/index.js';

import { onRelay as onPiRelay } from './adapters/pi.js';
import { onRelay as onClaudeRelay } from './adapters/claude-sdk.js';
import { Relay } from './core.js';

/**
 * Auto-detect the agent framework and apply the appropriate relay adapter.
 *
 * Requires a `framework` discriminator to avoid ambiguous detection.
 * If you know which framework you're using, prefer importing the
 * adapter directly: `onPiRelay` or `onClaudeRelay`.
 *
 * @param nameOrAgent - Agent name (string) or the agent/config object directly.
 * @param configOrOptions - Config/options object when first arg is a name.
 * @param maybeRelay - Optional pre-configured Relay instance.
 * @returns The augmented agent config or options.
 */
export function onRelay(
  nameOrAgent: string | Record<string, unknown>,
  configOrOptions?: Record<string, unknown>,
  maybeRelay?: Relay
): Record<string, unknown> {
  const isStringName = typeof nameOrAgent === 'string';
  const name = isStringName ? nameOrAgent : ((nameOrAgent as Record<string, unknown>).name as string) || 'Agent';
  const target: unknown = isStringName ? configOrOptions : nameOrAgent;
  const relay = (isStringName ? maybeRelay : configOrOptions) as Relay | undefined;

  const relayInstance = relay || new Relay(name);

  if (typeof target !== 'object' || target === null) {
    throw new Error(
      `onRelay() received a non-object target for ${name}. ` +
      'Pass the framework config/options object, or use onPiRelay / onClaudeRelay directly.'
    );
  }

  const obj = target as Record<string, unknown>;

  // Detect Pi: has customTools or Agent constructor
  if ('customTools' in obj || obj.constructor?.name === 'Agent') {
    return onPiRelay(name, target as Parameters<typeof onPiRelay>[1], relayInstance);
  }

  // Detect Claude SDK: has mcpServers or hooks
  if ('mcpServers' in obj || 'hooks' in obj) {
    return onClaudeRelay(name, target as Parameters<typeof onClaudeRelay>[1], relayInstance);
  }

  throw new Error(
    `onRelay() could not auto-detect framework for ${name}. ` +
    'Use the framework-specific adapter instead: onPiRelay or onClaudeRelay.'
  );
}

/** Alias for onRelay — spec uses both names */
export const withRelay = onRelay;
