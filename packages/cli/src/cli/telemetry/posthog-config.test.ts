import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('lets the process override beat the release-injected key', () => {
    vi.stubEnv('AGENT_RELAY_POSTHOG_KEY', 'release-key');
    vi.stubEnv('POSTHOG_API_KEY', 'debug-key');

    expect(getPostHogConfig()?.apiKey).toBe('debug-key');
  });

  it('treats a blank key as unset', () => {
    vi.stubEnv('AGENT_RELAY_POSTHOG_KEY', '   ');
    expect(getPostHogConfig()).toBeNull();
  });
});

/**
 * The bun `--define` used for the standalone binary substitutes the *literal*
 * expression `process.env.AGENT_RELAY_POSTHOG_KEY`. A computed lookup like
 * `process.env[name]` is a different expression and is silently left alone —
 * which is how every standalone binary shipped with telemetry disabled despite
 * the define being present. This guards the regression.
 */
describe('build-time key substitution contract', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));

  it('reads the env keys as static literals, not computed lookups', () => {
    const source = fs.readFileSync(path.join(dir, 'posthog-config.ts'), 'utf8');
    // Strip comments — the module doc names the anti-pattern on purpose.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).toContain('process.env.AGENT_RELAY_POSTHOG_KEY');
    expect(code).toContain('process.env.POSTHOG_API_KEY');
    expect(code).not.toMatch(/process\.env\[/);
  });

  it('keeps posthog-key.ts in the exact shape the injection script rewrites', () => {
    const source = fs.readFileSync(path.join(dir, 'posthog-key.ts'), 'utf8');

    // Mirrors EXPORT_PATTERN in scripts/inject-posthog-key.mjs. If this drifts,
    // the release step fails loudly rather than shipping a keyless CLI.
    expect(source).toMatch(/export const BUILD_TIME_POSTHOG_KEY = (['"])(.*?)\1;/);
  });
});
