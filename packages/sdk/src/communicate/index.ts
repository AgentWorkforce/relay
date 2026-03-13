export * from './types.js';
export * from './transport.js';
export * from './core.js';
export * from './adapters/index.js';

import { onRelay as onPiRelay } from './adapters/pi.js';
import { onRelay as onClaudeRelay } from './adapters/claude-sdk.js';
import { Relay } from './core.js';

/** Structural check for Pi-like config (has customTools or Agent constructor). */
function isPiConfig(target: unknown): target is Record<string, unknown> {
  if (typeof target !== 'object' || target === null) return false;
  const obj = target as Record<string, unknown>;
  return 'customTools' in obj || obj.constructor?.name === 'Agent';
}

/** Structural check for Claude SDK-like options (has mcpServers or hooks). */
function isClaudeOptions(target: unknown): target is Record<string, unknown> {
  if (typeof target !== 'object' || target === null) return false;
  const obj = target as Record<string, unknown>;
  return 'mcpServers' in obj || 'hooks' in obj;
}

/**
 * Auto-detect the agent framework and apply the appropriate relay adapter.
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

  if (isPiConfig(target)) {
    return onPiRelay(name, target as Parameters<typeof onPiRelay>[1], relayInstance);
  }

  if (isClaudeOptions(target)) {
    return onClaudeRelay(name, target as Parameters<typeof onClaudeRelay>[1], relayInstance);
  }

  throw new Error(`onRelay() could not auto-detect framework for ${name}.`);
}

/** Alias for onRelay — spec uses both names */
export const withRelay = onRelay;
