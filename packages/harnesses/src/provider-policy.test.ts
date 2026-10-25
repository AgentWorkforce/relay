import { describe, expect, it } from 'vitest';

import { assertProviderActive, providerRemovedMessage, removedProvider } from './provider-policy.js';

describe('removed provider policy', () => {
  it.each(['gemini', 'aider', 'goose', 'droid'])(
    'returns a stable provider_removed migration error for %s',
    (provider) => {
      expect(providerRemovedMessage(provider)).toBe(
        `provider_removed: provider '${provider}' has been removed; switch to a supported native provider (claude, codex, or opencode).`
      );
      expect(() => assertProviderActive(provider)).toThrow(/^provider_removed:/);
    }
  );

  it.each(['cursor', 'cursor-agent', '/usr/local/bin/cursor-agent', String.raw`C:\Tools\cursor-agent.exe`])(
    'routes the local Cursor alias %s to Cursor Cloud',
    (provider) => {
      expect(removedProvider(provider)).toBe('cursor');
      expect(providerRemovedMessage(provider)).toContain("use 'cursor-cloud'");
    }
  );

  it('normalizes a quoted executable path containing spaces', () => {
    expect(removedProvider('"C:\\Program Files\\Cursor\\cursor-agent.exe" --resume')).toBe('cursor');
  });

  it('leaves active and custom providers alone', () => {
    expect(providerRemovedMessage('codex')).toBeUndefined();
    expect(providerRemovedMessage('my-native-provider')).toBeUndefined();
  });
});
