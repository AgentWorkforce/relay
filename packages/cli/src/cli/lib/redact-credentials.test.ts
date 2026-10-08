import { describe, expect, it } from 'vitest';

import { redactCredentials } from './redact-credentials.js';

describe('redactCredentials', () => {
  it('masks a whole credential even when a declared value is its prefix', () => {
    const long = 'rk_live_declaredprefix_and_more_secret_tail';
    const out = redactCredentials(`key=${long}`, ['rk_live_declaredprefix']);
    expect(out).not.toContain('declaredprefix');
    expect(out).not.toContain('and_more_secret');
  });

  it('removes declared values of any length, and query and URL credentials', () => {
    const out = redactCredentials('a=k9z https://u:p4ss@h.example/x?token=t0k&y=1', ['k9z']);
    expect(out).not.toMatch(/k9z|p4ss|t0k/);
    expect(out).toContain('?token=<redacted>&y=1');
  });
});
