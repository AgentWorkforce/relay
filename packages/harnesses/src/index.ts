import { defineManagedHarness, definePtyHarness, type PtyHarness } from './define.js';
import { assertProviderActive } from './provider-policy.js';

export * from './define.js';
export * from './create-human.js';
export * from './observability.js';
export * from './provider-policy.js';
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

function removedPtyHarness(command: string): PtyHarness {
  const legacy = definePtyHarness({ runtime: 'pty', command });
  return {
    ...legacy,
    create: async () => {
      assertProviderActive(command);
      throw new Error('unreachable');
    },
    new: () => {
      assertProviderActive(command);
      throw new Error('unreachable');
    },
  };
}

/** @deprecated Gemini spawning was removed; use a supported native provider. */
export const gemini: PtyHarness = removedPtyHarness('gemini');

/** @deprecated Local cursor-agent spawning was removed; use Cursor Cloud. */
export const cursor: PtyHarness = removedPtyHarness('cursor-agent');

export const devin: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'devin' });

/** @deprecated Droid spawning was removed; use a supported native provider. */
export const droid: PtyHarness = removedPtyHarness('droid');

export const opencode = defineManagedHarness('opencode', { runtime: 'pty', command: 'opencode' });

export const muse: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'muse' });

/** @deprecated Aider spawning was removed; use a supported native provider. */
export const aider: PtyHarness = removedPtyHarness('aider');

/** @deprecated Goose spawning was removed; use a supported native provider. */
export const goose: PtyHarness = removedPtyHarness('goose');

export const grok: PtyHarness = definePtyHarness({ runtime: 'pty', command: 'grok' });

export const pi = defineManagedHarness('pi');

export const deepAgents = defineManagedHarness('deepagents');
