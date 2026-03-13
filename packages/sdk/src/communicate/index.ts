export * from './types.js';
export * from './transport.js';
export * from './core.js';
export * from './adapters/index.js';

import { onRelay as onPiRelay } from './adapters/pi.js';
import { onRelay as onClaudeRelay } from './adapters/claude-sdk.js';
import { Relay } from './core.js';

export function onRelay(nameOrAgent: any, configOrOptions?: any, maybeRelay?: any): any {
  // 1. Detection logic
  
  // If first arg is a string, it's the name (from onRelay(name, config, relay) pattern)
  // We need to look at the second arg to decide which adapter to use.
  
  const isStringName = typeof nameOrAgent === 'string';
  const name = isStringName ? nameOrAgent : (nameOrAgent.name || 'Agent');
  const target = isStringName ? configOrOptions : nameOrAgent;
  const relay = isStringName ? maybeRelay : configOrOptions;

  const relayInstance = relay || new Relay(name);

  // Pi detection: has customTools or is an Agent
  if (target?.customTools || target?.constructor?.name === 'Agent') {
    return onPiRelay(name, target, relayInstance);
  }

  // Claude SDK detection: has mcpServers or hooks
  if (target?.mcpServers || target?.hooks) {
    return onClaudeRelay(name, target, relayInstance);
  }

  // Fallback or explicit check if we can't be sure
  // If it's a plain object being passed as config/options, it might be ambiguous.
  // But usually onRelay is called on the 'agent' or 'options' object.
  
  throw new Error(`onRelay() could not auto-detect framework for ${name}.`);
}
