import { describe, expect, it, vi } from 'vitest';
import { ensureTypeStrippingRuntime } from '../relayflows/cases/1593-receipt-reachability/node-runtime.mjs';

describe('receipt proof runtime selection (unit only)', () => {
  it('uses an available built-in without starting another process', () => {
    const spawn = vi.fn();
    expect(
      ensureTypeStrippingRuntime({
        moduleApi: { stripTypeScriptTypes() {} },
        scriptPath: '/case/run.mjs',
        env: {},
        spawn,
      })
    ).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([0, 7])('propagates pinned runtime exit %i when the API is unavailable', (status) => {
    const spawn = vi.fn(() => ({ status, error: undefined, signal: null }));
    expect(
      ensureTypeStrippingRuntime({
        moduleApi: {},
        scriptPath: '/case with spaces/run.mjs',
        env: { TMPDIR: '/isolated' },
        spawn,
      })
    ).toBe(status);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      'npm',
      [
        'exec',
        '--yes',
        '--ignore-scripts=false',
        '--package=node@22.14.0',
        '--',
        'node',
        '/case with spaces/run.mjs',
      ],
      {
        env: { TMPDIR: '/isolated', RELAY_PR_PROOF_NODE_BOOTSTRAPPED: '22.14.0' },
        stdio: 'inherit',
        timeout: 120_000,
      }
    );
  });

  it('fails without retry when the pinned process still lacks the API', () => {
    const spawn = vi.fn();
    expect(() =>
      ensureTypeStrippingRuntime({
        moduleApi: {},
        scriptPath: '/case/run.mjs',
        env: { RELAY_PR_PROOF_NODE_BOOTSTRAPPED: '22.14.0' },
        spawn,
      })
    ).toThrow('did not provide stripTypeScriptTypes');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves bootstrap failure as infrastructure failure', () => {
    expect(() =>
      ensureTypeStrippingRuntime({
        moduleApi: {},
        scriptPath: '/case/run.mjs',
        env: {},
        spawn: () => ({ error: new Error('timeout'), status: null }),
      })
    ).toThrow('Could not launch pinned Node.js');
    expect(() =>
      ensureTypeStrippingRuntime({
        moduleApi: {},
        scriptPath: '/case/run.mjs',
        env: {},
        spawn: () => ({ signal: 'SIGTERM', status: null }),
      })
    ).toThrow('exited without a status');
  });
});
