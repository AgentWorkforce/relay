import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS,
  withAgentRegistrationDeadline,
} from './agent-registration.js';

describe('withAgentRegistrationDeadline', () => {
  it('resolves with the register() result when it completes before the deadline', async () => {
    const result = await withAgentRegistrationDeadline(async () => 'token', 'chief', 50);
    expect(result).toBe('token');
  });

  it('rejects once the deadline elapses without register() settling', async () => {
    vi.useFakeTimers();
    try {
      const pending = withAgentRegistrationDeadline(() => new Promise(() => {}), 'chief', 50);
      const assertion = expect(pending).rejects.toThrow(/did not complete within 50ms/);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default timeout for a non-finite timeoutMs instead of firing near-instantly', async () => {
    vi.useFakeTimers();
    try {
      const pending = withAgentRegistrationDeadline(
        () => new Promise(() => {}),
        'chief',
        Number.POSITIVE_INFINITY
      );
      const assertion = expect(pending).rejects.toThrow(
        new RegExp(`did not complete within ${DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS}ms`)
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default timeout for a non-positive timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const pending = withAgentRegistrationDeadline(() => new Promise(() => {}), 'chief', -5);
      const assertion = expect(pending).rejects.toThrow(
        new RegExp(`did not complete within ${DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS}ms`)
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps an oversized timeoutMs to the max setTimeout delay instead of overflowing', async () => {
    vi.useFakeTimers();
    try {
      const pending = withAgentRegistrationDeadline(
        () => new Promise(() => {}),
        'chief',
        Number.MAX_SAFE_INTEGER
      );
      const assertion = expect(pending).rejects.toThrow(/did not complete within 2147483647ms/);
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shell-escapes a name containing command substitution syntax in the recovery command', async () => {
    vi.useFakeTimers();
    try {
      const maliciousName = '$(rm -rf /)`whoami`';
      const pending = withAgentRegistrationDeadline(() => new Promise(() => {}), maliciousName, 50);
      const assertion = pending.catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(50);
      const message = await assertion;
      // The recovery commands must wrap the name in single quotes so a shell
      // treats it as a literal argument rather than executing it.
      expect(message).toContain(`agent-relay agent rotate '$(rm -rf /)\`whoami\`'`);
      expect(message).not.toMatch(/rotate \$\(rm -rf \/\)/);
    } finally {
      vi.useRealTimers();
    }
  });
});
