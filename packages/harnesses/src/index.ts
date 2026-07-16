import { defineManagedHarness, definePtyHarness, type PtyHarness } from './define.js';

export * from './define.js';
export * from './create-human.js';
export * from './observability.js';
export * from './ai-sdk/index.js';

// Custom (non-PTY) harnesses are defined with the SDK's harness contract;
// re-export it here so harness authors have one import surface.
export { defineHarness, normalizeAgentIdentity, MINIMAL_AGENT_SESSION_CAPABILITIES } from '@agent-relay/sdk';
export type {
  AgentSession,
  AgentSessionCapabilities,
  HarnessConfig,
  HarnessCreateContext,
} from '@agent-relay/sdk';

export const claude = defineManagedHarness('claude', { runtime: 'pty', command: 'claude' });

export const codex = defineManagedHarness('codex', { runtime: 'pty', command: 'codex' });

export const gemini: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'gemini' });

export const cursor: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'cursor-agent' });

export const droid: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'droid' });

export const opencode = defineManagedHarness('opencode', { runtime: 'pty', command: 'opencode' });

export const aider: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'aider' });

export const goose: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'goose' });

export const grok: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'grok' });

export const pi = defineManagedHarness('pi');

export const deepAgents = defineManagedHarness('deepagents');
