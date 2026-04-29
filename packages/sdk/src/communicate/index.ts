export * from './types.js';
export { Relay } from './core.js';
export { onPiRelay, onClaudeRelay, onCodexRelay } from './adapters/index.js';

import { onRelay as onPiRelay } from './adapters/pi.js';
import { onRelay as onClaudeRelay } from './adapters/claude-sdk.js';
import { onRelay as onCodexRelay, type CodexAdapterOptions, type CodexHandle } from './adapters/codex.js';
import { Relay } from './core.js';

/**
 * Auto-detect the agent framework and apply the appropriate relay adapter.
 *
 * Requires a `framework` discriminator to avoid ambiguous detection.
 * If you know which framework you're using, prefer importing the
 * adapter directly: `onPiRelay`, `onClaudeRelay`, or `onCodexRelay`.
 *
 * @param nameOrAgent - Agent name (string) or the agent/config object directly.
 * @param configOrOptions - Config/options object when first arg is a name.
 * @param maybeRelay - Optional pre-configured Relay instance.
 * @returns The augmented agent config or options.
 */
export function onRelay(
  nameOrAgent: string,
  configOrOptions: CodexAdapterOptions & { framework: 'codex' },
  maybeRelay?: Relay
): CodexHandle;
export function onRelay(
  nameOrAgent: string | Record<string, unknown>,
  configOrOptions?: Record<string, unknown>,
  maybeRelay?: Relay
): Record<string, unknown>;
export function onRelay(
  nameOrAgent: string | Record<string, unknown>,
  configOrOptions?: Record<string, unknown> | CodexAdapterOptions | Relay,
  maybeRelay?: Relay
): Record<string, unknown> | CodexHandle {
  const isStringName = typeof nameOrAgent === 'string';
  const name = isStringName
    ? nameOrAgent
    : ((nameOrAgent as Record<string, unknown>).name as string) || 'Agent';
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

  // Detect Codex app-server adapter via explicit discriminator.
  if (obj.framework === 'codex') {
    return onCodexRelay(name, target as Parameters<typeof onCodexRelay>[1], relayInstance);
  }

  // Detect Pi: has customTools or Agent constructor
  if ('customTools' in obj || obj.constructor?.name === 'Agent') {
    return onPiRelay(name, target as Parameters<typeof onPiRelay>[1], relayInstance);
  }

  // Detect Claude SDK: has mcpServers or hooks, or is a plain empty options object
  if ('mcpServers' in obj || 'hooks' in obj || Object.keys(obj).length === 0) {
    return onClaudeRelay(name, target as Parameters<typeof onClaudeRelay>[1], relayInstance);
  }

  throw new Error(
    `onRelay() could not auto-detect framework for ${name}. ` +
      'Use the framework-specific adapter instead: onPiRelay, onClaudeRelay, or onCodexRelay.'
  );
}

/** Alias for onRelay — spec uses both names */
export const withRelay = onRelay;
