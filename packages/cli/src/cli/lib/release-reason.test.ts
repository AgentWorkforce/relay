import { describe, expect, it } from 'vitest';

import { attributableReleaseReason } from './release-reason.js';

describe('attributableReleaseReason', () => {
  it('preserves a caller-supplied reason and appends the actor', () => {
    expect(attributableReleaseReason('cleanup', 'chief', 'fallback reason')).toBe('cleanup (actor: chief)');
  });

  it('trims surrounding whitespace on a string reason', () => {
    expect(attributableReleaseReason('  cleanup  ', 'chief', 'fallback reason')).toBe(
      'cleanup (actor: chief)'
    );
  });

  it('falls back to the fallback reason for a non-string reason', () => {
    expect(attributableReleaseReason(undefined, 'chief', 'fallback reason')).toBe(
      'fallback reason (actor: chief)'
    );
    expect(attributableReleaseReason(42, 'chief', 'fallback reason')).toBe('fallback reason (actor: chief)');
    expect(attributableReleaseReason(null, 'chief', 'fallback reason')).toBe(
      'fallback reason (actor: chief)'
    );
  });

  it('falls back to the fallback reason for a whitespace-only reason', () => {
    expect(attributableReleaseReason('   ', 'chief', 'fallback reason')).toBe(
      'fallback reason (actor: chief)'
    );
  });

  it('never emits a null/empty reason — a missing reason always uses the fallback', () => {
    const result = attributableReleaseReason(null, undefined, 'fallback reason');
    expect(result).not.toContain('null');
    expect(result.startsWith('fallback reason')).toBe(true);
  });

  it('falls back to "unknown Agent Relay operator" for a missing or whitespace-only actor', () => {
    expect(attributableReleaseReason('cleanup', undefined, 'fallback reason')).toBe(
      'cleanup (actor: unknown Agent Relay operator)'
    );
    expect(attributableReleaseReason('cleanup', null, 'fallback reason')).toBe(
      'cleanup (actor: unknown Agent Relay operator)'
    );
    expect(attributableReleaseReason('cleanup', '   ', 'fallback reason')).toBe(
      'cleanup (actor: unknown Agent Relay operator)'
    );
  });
});
