import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPostHogConfig } from './posthog-config.js';

describe('PostHog telemetry config', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_RELAY_POSTHOG_KEY', '');
    vi.stubEnv('POSTHOG_API_KEY', '');
    vi.stubEnv('POSTHOG_HOST', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the hosted Agent Relay ingestion proxy by default', () => {
    vi.stubEnv('AGENT_RELAY_POSTHOG_KEY', 'relay-key');

    expect(getPostHogConfig()).toEqual({
      apiKey: 'relay-key',
      host: 'https://i.agentrelay.com',
    });
  });

  it('allows POSTHOG_HOST to override the hosted proxy', () => {
    vi.stubEnv('POSTHOG_API_KEY', 'debug-key');
    vi.stubEnv('POSTHOG_HOST', 'https://posthog.example.test');

    expect(getPostHogConfig()).toEqual({
      apiKey: 'debug-key',
      host: 'https://posthog.example.test',
    });
  });

  it('does not configure telemetry without a key', () => {
    expect(getPostHogConfig()).toBeNull();
  });
});
