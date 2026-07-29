import { describe, expect, it } from 'vitest';

import { redactCredentialValues } from './redact.js';

describe('redactCredentialValues', () => {
  it('masks a workspace key embedded in a URL path', () => {
    expect(
      redactCredentialValues(
        'Workspace resolve failed at /api/v1/workspaces/rk_live_0123456789abcdef/resolve: 404'
      )
    ).toBe('Workspace resolve failed at /api/v1/workspaces/rk_live_…cdef/resolve: 404');
  });

  it('masks a workspace key embedded in a query string', () => {
    expect(
      redactCredentialValues(
        'Workspace resolve failed at /api/v1/workspaces/active?key=rk_live_0123456789abcdef: 404 Not Found'
      )
    ).toBe('Workspace resolve failed at /api/v1/workspaces/active?key=rk_live_…cdef: 404 Not Found');
  });

  it('masks every credential kind, including server-echoed details', () => {
    expect(
      redactCredentialValues('denied for at_live_0123456789abcdef with session cld_at_0123456789abcdef')
    ).toBe('denied for at_live_…cdef with session cld_at_…cdef');
  });

  it('masks a short-bodied credential entirely instead of leaking most of it', () => {
    expect(redactCredentialValues('bad key rk_live_abcd rejected')).toBe('bad key rk_live_… rejected');
    expect(redactCredentialValues('bad key rk_live_abcde rejected')).toBe('bad key rk_live_… rejected');
  });

  it('masks a dot-chained (JWT-shaped) token through its final segment', () => {
    expect(
      redactCredentialValues('denied for cld_at_eyJhbGciOi.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4')
    ).toBe('denied for cld_at_…2QT4');
  });

  it('does not swallow a sentence period after a token', () => {
    expect(redactCredentialValues('rotate rk_live_0123456789abcdef.')).toBe('rotate rk_live_…cdef.');
  });

  it('leaves credential-free text untouched', () => {
    expect(redactCredentialValues('Workspace create failed at /api/v1/workspaces: 500 oops')).toBe(
      'Workspace create failed at /api/v1/workspaces: 500 oops'
    );
  });
});
