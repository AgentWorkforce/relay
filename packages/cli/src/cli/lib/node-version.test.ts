import { describe, expect, it } from 'vitest';

import { assertSupportedNodeVersion, MINIMUM_NODE_MAJOR } from './node-version.js';

describe('Node runtime baseline', () => {
  it('accepts Node 22 and newer', () => {
    expect(MINIMUM_NODE_MAJOR).toBe(22);
    expect(() => assertSupportedNodeVersion('22.0.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.1.0')).not.toThrow();
  });

  it('rejects old and malformed versions with upgrade guidance', () => {
    expect(() => assertSupportedNodeVersion('20.19.0')).toThrow(/requires Node\.js 22 or newer/);
    expect(() => assertSupportedNodeVersion('unknown')).toThrow(/Upgrade Node\.js/);
  });
});
