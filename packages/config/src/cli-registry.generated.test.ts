import { describe, expect, it } from 'vitest';

import { CLIRegistry, CLIs, CLIVersions } from './cli-registry.generated.js';

const REMOVED_PROVIDERS = ['gemini', 'cursor', 'aider', 'goose', 'droid'] as const;

describe('generated CLI registry', () => {
  it('publishes only active spawn providers', () => {
    const advertised = Object.values(CLIs);
    for (const provider of REMOVED_PROVIDERS) {
      expect(advertised).not.toContain(provider);
      expect(CLIRegistry).not.toHaveProperty(provider);
      expect(CLIVersions).not.toHaveProperty(provider.toUpperCase());
    }
    expect(advertised).toEqual(expect.arrayContaining(['claude', 'codex', 'opencode']));
  });
});
