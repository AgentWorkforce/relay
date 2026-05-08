import { describe, expect, it } from 'vitest';

import { SlackAdapterFactory, normalizeSlackRuntimeConfig } from '../adapter.js';

describe('SlackAdapterFactory runtime selection', () => {
  it("picks 'cloud-relay' when CLOUD_API_TOKEN and CLOUD_API_URL are set, even if SLACK_BOT_TOKEN is also set", () => {
    const normalized = normalizeSlackRuntimeConfig({
      env: {
        SLACK_BOT_TOKEN: 'xoxb-local',
        CLOUD_API_TOKEN: 'rk_cli',
        CLOUD_API_URL: 'https://api.example.com',
      },
    });
    expect(normalized.runtime).toBe('cloud-relay');
  });

  it("picks 'local' when only SLACK_BOT_TOKEN is set", () => {
    const normalized = normalizeSlackRuntimeConfig({
      env: { SLACK_BOT_TOKEN: 'xoxb-local' },
    });
    expect(normalized.runtime).toBe('local');
  });

  it("picks 'noop' when no tokens are configured", () => {
    const normalized = normalizeSlackRuntimeConfig({ env: {} });
    expect(normalized.runtime).toBe('noop');
  });

  it("falls back to 'noop' when CLOUD_API_TOKEN is set but CLOUD_API_URL is missing", () => {
    const normalized = normalizeSlackRuntimeConfig({
      env: { CLOUD_API_TOKEN: 'rk_cli' },
    });
    expect(normalized.runtime).toBe('noop');
  });

  it('honors explicit runtime override over env detection', () => {
    const normalized = normalizeSlackRuntimeConfig({
      runtime: 'noop',
      env: {
        SLACK_BOT_TOKEN: 'xoxb-local',
        CLOUD_API_TOKEN: 'rk_cli',
        CLOUD_API_URL: 'https://api.example.com',
      },
    });
    expect(normalized.runtime).toBe('noop');
  });

  it("treats 'auto' the same as omitting runtime", () => {
    const normalized = normalizeSlackRuntimeConfig({
      runtime: 'auto',
      env: { SLACK_BOT_TOKEN: 'xoxb-local' },
    });
    expect(normalized.runtime).toBe('local');
  });

  it("detect() reports availability for all three runtimes", async () => {
    const detection = await SlackAdapterFactory.detect({
      env: {
        SLACK_BOT_TOKEN: 'xoxb-local',
        CLOUD_API_TOKEN: 'rk_cli',
        CLOUD_API_URL: 'https://api.example.com',
      },
    });

    expect(detection.runtime).toBe('cloud-relay');
    expect(detection.cloudRelay.available).toBe(true);
    expect(detection.local.available).toBe(true);
    expect(detection.noop.available).toBe(true);
  });

  it("create() returns a noop adapter when no tokens are configured", async () => {
    const adapter = await SlackAdapterFactory.create({ env: {} });
    expect(adapter.getRuntime()).toBe('noop');
  });
});
