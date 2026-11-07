import { describe, expect, it } from 'vitest';

import { describeError } from './describe-error.js';

describe('describeError', () => {
  it('renders an Error as its message', () => {
    expect(describeError(new Error('broker refused the attach'))).toBe('broker refused the attach');
  });

  it('falls back to name and cause when an Error has no message', () => {
    expect(describeError(new Error(''))).toBe('Error');
    const named = new Error('');
    named.name = 'AttachError';
    expect(describeError(named)).toBe('AttachError');
    expect(describeError(new Error('', { cause: new Error('socket hang up') }))).toBe(
      'Error: socket hang up'
    );
  });

  it('keeps a protocol-shaped rejection readable instead of [object Object]', () => {
    expect(describeError({ status: 401 })).toBe('{"status":401}');
    expect(describeError({ status: 401, code: 'unauthorized', message: 'invalid workspace key' })).toBe(
      'invalid workspace key (status 401, code unauthorized)'
    );
    expect(describeError({ error: 'invalid api key', status: 403 })).toBe('invalid api key (status 403)');
  });

  it('unwraps a nested error object', () => {
    expect(describeError({ error: { message: 'node offline' }, code: 'node_unreachable' })).toBe(
      'node offline (code node_unreachable)'
    );
  });

  it('redacts credentials in the JSON fallback', () => {
    const described = describeError({ status: 401, workspaceKey: 'rk_live_supersecret' });
    expect(described).not.toContain('rk_live_supersecret');
    expect(described).toContain('[redacted]');
  });

  it('redacts a credential echoed back inside the message text', () => {
    // A server error payload is free to quote whatever was sent to it, and that
    // text is lifted out whole — key-name redaction cannot reach it.
    expect(describeError({ status: 401, message: 'invalid key rk_live_abcdefghij1234' })).toBe(
      'invalid key rk_live_…1234 (status 401)'
    );
    expect(describeError(new Error('enroll failed for nt_live_0123456789abcdef'))).toBe(
      'enroll failed for nt_live_…cdef'
    );
  });

  it('keeps JSON-hostile members readable', () => {
    // JSON.stringify throws on BigInt; the old fallback answered [object Object].
    expect(describeError({ status: 429, retryAfter: 30n })).toBe('{"status":429,"retryAfter":"30n"}');

    const throwingGetter = {
      get status(): number {
        throw new Error('nope');
      },
    };
    expect(describeError(throwingGetter)).toBe('[unserializable Object]');
  });

  it('tolerates cycles and truncates oversized payloads', () => {
    const cyclic: Record<string, unknown> = { status: 500 };
    cyclic.self = cyclic;
    expect(describeError(cyclic)).toContain('[circular]');

    const huge = describeError({ status: 500, blob: 'x'.repeat(5000) });
    expect(huge.length).toBeLessThanOrEqual(501);
    expect(huge.endsWith('…')).toBe(true);
  });

  it('renders primitives and empty values without going blank', () => {
    expect(describeError('connection reset')).toBe('connection reset');
    expect(describeError(404)).toBe('404');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError('')).toBe('Unknown error');
    expect(describeError({})).toBe('{}');
  });

  it('never returns the useless [object Object] rendering', () => {
    for (const value of [{ status: 401 }, {}, Object.create(null), [{ status: 401 }]]) {
      expect(describeError(value)).not.toBe('[object Object]');
    }
  });
});
