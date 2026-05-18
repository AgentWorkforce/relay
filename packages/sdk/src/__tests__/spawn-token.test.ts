import { describe, expectTypeOf, it } from 'vitest';

import type { SpawnProviderInput, SpawnPtyInput } from '../types.js';

describe('spawn input agentToken types', () => {
  it('SpawnPtyInput accepts agentToken when present or omitted', () => {
    const withoutToken = {
      name: 'worker-no-token',
      cli: 'codex',
    } satisfies SpawnPtyInput;

    const withToken = {
      name: 'worker-with-token',
      cli: 'codex',
      agentToken: 'jwt-token',
    } satisfies SpawnPtyInput;

    expectTypeOf(withoutToken).toMatchTypeOf<SpawnPtyInput>();
    expectTypeOf(withToken).toMatchTypeOf<SpawnPtyInput>();
    expectTypeOf(withToken.agentToken).toEqualTypeOf<string>();
    expectTypeOf<SpawnPtyInput['agentToken']>().toEqualTypeOf<string | undefined>();
  });

  it('SpawnProviderInput accepts agentToken when present or omitted', () => {
    const withoutToken = {
      name: 'provider-no-token',
      provider: 'claude',
    } satisfies SpawnProviderInput;

    const withToken = {
      name: 'provider-with-token',
      provider: 'claude',
      agentToken: 'jwt-token',
    } satisfies SpawnProviderInput;

    expectTypeOf(withoutToken).toMatchTypeOf<SpawnProviderInput>();
    expectTypeOf(withToken).toMatchTypeOf<SpawnProviderInput>();
    expectTypeOf(withToken.agentToken).toEqualTypeOf<string>();
    expectTypeOf<SpawnProviderInput['agentToken']>().toEqualTypeOf<string | undefined>();
  });
});
