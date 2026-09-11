import { describe, expect, it, vi } from 'vitest';

import { RelayPlacementError } from '@agent-relay/sdk';

import { runSdk, withSdkDefaults, type SdkCommandDeps } from './sdk-command.js';

// relay#1751 CodeRabbit thread / relay#1563: `runSdk` prints a structured
// error body for `RelayPlacementError`, including `err.receipt`. That
// receipt is the raw upstream spawn invocation record and must not cross
// the CLI boundary unsanitized — only the allowlisted lifecycle-evidence
// fields (status/ids/readiness) may be echoed back.
describe('runSdk structured error output', () => {
  function deps(overrides: Partial<SdkCommandDeps> = {}): { deps: SdkCommandDeps; errors: string[] } {
    const errors: string[] = [];
    const built = withSdkDefaults({
      error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
      exit: vi.fn() as never,
      ...overrides,
    });
    return { deps: built, errors };
  }

  it('drops secret-bearing raw invocation fields from the printed receipt', async () => {
    const { deps: sdkDeps, errors } = deps();
    const receipt = {
      status: 'failed',
      invocation_id: 'inv_secret',
      // Not part of the lifecycle-evidence allowlist. A raw upstream
      // invocation record can carry broker/handler internals like this;
      // they must never cross the CLI boundary.
      api_key: 'sk_live_should_not_leak_1234567890',
      env: { RELAY_API_KEY: 'sk_live_should_not_leak_1234567890' },
    };

    await runSdk(sdkDeps, async () => {
      throw new RelayPlacementError('spawn_failed', 'Fleet spawn invocation reported a terminal failure.', {
        capability: 'spawn:codex',
        attempts: 1,
        invocationId: 'inv_secret',
        state: 'failed',
        dispatchState: 'unknown',
        receipt,
      });
    });

    expect(sdkDeps.exit).toHaveBeenCalledWith(1);
    const printed = errors.join('\n');
    expect(printed).not.toContain('sk_live_should_not_leak_1234567890');
    expect(printed).not.toContain('RELAY_API_KEY');
    expect(printed).not.toContain('api_key');

    const jsonLine = printed.split('\n').find((line) => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    // Lifecycle evidence must survive the projection...
    expect(parsed.error.receipt).toMatchObject({ status: 'failed', invocation_id: 'inv_secret' });
    // ...but the raw secret-bearing fields must not.
    expect(parsed.error.receipt).not.toHaveProperty('api_key');
    expect(parsed.error.receipt).not.toHaveProperty('env');
  });

  it('preserves lifecycle evidence (state, dispatchState, invocationId) for a non-secret receipt', async () => {
    const { deps: sdkDeps, errors } = deps();

    await runSdk(sdkDeps, async () => {
      throw new RelayPlacementError('spawn_unconfirmed', 'node accepted spawn but never reported a result.', {
        capability: 'spawn:codex',
        attempts: 1,
        invocationId: 'inv_lifecycle',
        node: 'sf-mini',
        state: 'unconfirmed_may_be_running',
        dispatchState: 'dispatched',
        receipt: { status: 'accepted', invocation_id: 'inv_lifecycle', handler_node_id: 'sf-mini' },
      });
    });

    const printed = errors.join('\n');
    const jsonLine = printed.split('\n').find((line) => line.trim().startsWith('{'));
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.error).toMatchObject({
      code: 'spawn_unconfirmed',
      state: 'unconfirmed_may_be_running',
      invocationId: 'inv_lifecycle',
      node: 'sf-mini',
      dispatchState: 'dispatched',
      receipt: { status: 'accepted', invocation_id: 'inv_lifecycle', handler_node_id: 'sf-mini' },
    });
  });

  it('does not attach a structured receipt for a plain Error', async () => {
    const { deps: sdkDeps, errors } = deps();

    await runSdk(sdkDeps, async () => {
      throw new Error('boom');
    });

    expect(sdkDeps.exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toBe('boom');
  });
});
