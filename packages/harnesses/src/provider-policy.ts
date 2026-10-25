export const ACTIVE_NATIVE_PROVIDER_GUIDANCE = 'claude, codex, or opencode';

const REMOVED_PROVIDER_ALIASES = new Map<string, 'gemini' | 'cursor' | 'aider' | 'goose' | 'droid'>([
  ['gemini', 'gemini'],
  ['cursor', 'cursor'],
  ['cursor-agent', 'cursor'],
  ['aider', 'aider'],
  ['goose', 'goose'],
  ['droid', 'droid'],
]);

/** Stable error surfaced by every compatibility spawn path for a removed provider. */
export class ProviderRemovedError extends Error {
  readonly code = 'provider_removed' as const;
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'ProviderRemovedError';
    this.provider = provider;
  }
}

function providerBasename(value: string): string {
  const trimmed = value.trim();
  const token = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = token?.[1] ?? token?.[2] ?? token?.[3] ?? '';
  const basename = executable.replaceAll('\\', '/').split('/').at(-1) ?? executable;
  return basename.replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
}

/** Return the canonical removed provider for a CLI name/path, including legacy aliases. */
export function removedProvider(value: string): string | undefined {
  return REMOVED_PROVIDER_ALIASES.get(providerBasename(value));
}

/** Human-readable stable error contract shared by CLI, SDK, and Fleet compatibility paths. */
export function providerRemovedMessage(value: string): string | undefined {
  const provider = removedProvider(value);
  if (!provider) return undefined;
  if (provider === 'cursor') {
    return "provider_removed: local Cursor CLI spawning has been removed; use 'cursor-cloud' for Cursor Cloud agents.";
  }
  return `provider_removed: provider '${provider}' has been removed; switch to a supported native provider (${ACTIVE_NATIVE_PROVIDER_GUIDANCE}).`;
}

/** Reject a removed provider before a spawn can allocate or register anything. */
export function assertProviderActive(value: string): void {
  const message = providerRemovedMessage(value);
  if (!message) return;
  throw new ProviderRemovedError(removedProvider(value)!, message);
}
