import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultApiUrl } from './types.js';

afterEach(() => vi.unstubAllEnvs());

describe('defaultApiUrl environment isolation', () => {
  it('does not inherit an ambient host when an explicit environment omits it', () => {
    vi.stubEnv('CLOUD_API_URL', 'https://ambient.example.test');
    expect(defaultApiUrl({})).toBe('https://agentrelay.com/cloud');
    expect(defaultApiUrl({ CLOUD_API_URL: '  ' })).toBe('https://agentrelay.com/cloud');
    expect(defaultApiUrl({ CLOUD_API_URL: ' https://isolated.example.test ' })).toBe(
      'https://isolated.example.test'
    );
  });

  it('preserves the ambient override for callers without an explicit environment', () => {
    vi.stubEnv('CLOUD_API_URL', 'https://ambient.example.test');
    expect(defaultApiUrl()).toBe('https://ambient.example.test');
  });
});
