import { describe, expect, it } from 'vitest';
import { exitCode, RelayError } from './ports.js';

describe('process exit code', () => {
  it('keeps a machine-readable code, digits included', () => {
    expect(exitCode(new RelayError('relay_http_403', false))).toBe('relay_http_403');
  });

  it.each([new Error('Unexpected token < in JSON'), 'not an error'])('hides %s', (error) => {
    expect(exitCode(error)).toBe('bridge_failed');
  });
});
