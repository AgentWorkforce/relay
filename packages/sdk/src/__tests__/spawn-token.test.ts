import { describe, expectTypeOf, it } from 'vitest';

import type { SpawnAgentConfig, SpawnHeadlessAgentConfig, SpawnPtyAgentConfig } from '../relay.js';
import type { SpawnCliInput, SpawnHeadlessInput, SpawnPtyInput } from '../types.js';

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

  it('SpawnCliInput accepts agentToken when present or omitted', () => {
    const withoutToken = {
      name: 'cli-no-token',
      cli: 'claude',
    } satisfies SpawnCliInput;

    const withToken = {
      name: 'cli-with-token',
      cli: 'claude',
      agentToken: 'jwt-token',
    } satisfies SpawnCliInput;

    expectTypeOf(withoutToken).toMatchTypeOf<SpawnCliInput>();
    expectTypeOf(withToken).toMatchTypeOf<SpawnCliInput>();
    expectTypeOf(withToken.agentToken).toEqualTypeOf<string>();
    expectTypeOf<SpawnCliInput['agentToken']>().toEqualTypeOf<string | undefined>();
  });

  it('SpawnHeadlessInput accepts custom harness metadata and agentToken', () => {
    const withHeadlessHarness = {
      name: 'headless-with-harness',
      cli: 'custom-app-server',
      agentToken: 'jwt-token',
      harnessConfig: {
        runtime: 'headless',
        protocol: 'custom-app-server',
        endpoint: 'http://127.0.0.1:4099',
        sessionId: 'session-headless',
      },
    } satisfies SpawnHeadlessInput;

    expectTypeOf(withHeadlessHarness).toMatchTypeOf<SpawnHeadlessInput>();
    expectTypeOf(withHeadlessHarness.cli).toMatchTypeOf<string>();
    expectTypeOf<SpawnHeadlessInput['agentToken']>().toEqualTypeOf<string | undefined>();
  });

  it('SpawnAgentConfig defaults name and runtime for the high-level facade', () => {
    const minimalPty = {
      cli: 'codex',
    } satisfies SpawnPtyAgentConfig;

    expectTypeOf(minimalPty).toMatchTypeOf<SpawnAgentConfig>();
    expectTypeOf(minimalPty).toMatchTypeOf<SpawnPtyAgentConfig>();

    const withHeadlessHarness = {
      cli: 'custom-app-server',
      runtime: 'headless',
      agentToken: 'jwt-token',
      harnessConfig: {
        runtime: 'headless',
        protocol: 'custom-app-server',
        endpoint: 'http://127.0.0.1:4099',
        sessionId: 'session-headless',
      },
    } satisfies SpawnHeadlessAgentConfig;

    expectTypeOf(withHeadlessHarness).toMatchTypeOf<SpawnAgentConfig>();
    expectTypeOf(withHeadlessHarness).toMatchTypeOf<SpawnHeadlessAgentConfig>();
    expectTypeOf(withHeadlessHarness.cli).toMatchTypeOf<string>();
  });
});
