import { describe, expect, it } from 'vitest';

import {
  currentDocsVersion,
  getDefaultDocsVersionForSlug,
  getDocsVersionForPath,
  getDocsVersionHref,
} from '../docs-versions';

describe('docs versions', () => {
  it('serves v8 at bare docs paths', () => {
    expect(currentDocsVersion).toBe('v8');
    expect(getDocsVersionForPath('/docs')).toBe('v8');
    expect(getDocsVersionForPath('/docs/cli-messaging')).toBe('v8');
    expect(getDefaultDocsVersionForSlug('cli-messaging')).toBe('v8');
  });

  it('keeps legacy-only docs in the versioned archive', () => {
    expect(getDocsVersionForPath('/docs/7.1.1/cloud')).toBe('v7.1.1');
    expect(getDefaultDocsVersionForSlug('cloud')).toBe('v7.1.1');
    expect(getDocsVersionHref('v7.1.1', '/docs/cloud')).toBe('/docs/7.1.1/cloud');
  });

  it('maps the old v8 prefix to the current bare docs path', () => {
    expect(getDocsVersionForPath('/docs/8.0.0/cli-messaging')).toBe('v8');
    expect(getDocsVersionHref('v8', '/docs/8.0.0/cli-messaging')).toBe('/docs/cli-messaging');
    expect(getDocsVersionHref('v7.1.1', '/docs/8.0.0/cli-messaging')).toBe('/docs/7.1.1/cli-messaging');
  });
});
