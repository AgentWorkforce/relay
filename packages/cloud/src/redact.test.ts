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

  it('leaves credential-free text untouched', () => {
    expect(redactCredentialValues('Workspace create failed at /api/v1/workspaces: 500 oops')).toBe(
      'Workspace create failed at /api/v1/workspaces: 500 oops'
    );
  });
});
