import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function () {
    return {
      capture: posthogMocks.capture,
      shutdown: posthogMocks.shutdown,
    };
  }),
}));

import { initTelemetry, shutdown } from './client.js';

describe('telemetry client events', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-telemetry-client-'));
    vi.stubEnv('AGENT_RELAY_DATA_DIR', dataDir);
    vi.stubEnv('POSTHOG_API_KEY', 'test-key');
    vi.stubEnv('AGENT_RELAY_POSTHOG_KEY', '');
    vi.stubEnv('POSTHOG_HOST', '');
    vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    posthogMocks.capture.mockClear();
    posthogMocks.shutdown.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('tracks cli_install on first telemetry initialization only', async () => {
    initTelemetry({
      cliVersion: '1.2.3',
      orchestratorHarness: 'claude/opus-48',
    });

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: expect.any(String),
        event: 'cli_install',
        properties: expect.objectContaining({
          cli_version: '1.2.3',
          orchestrator_harness: 'claude/opus-48',
          version: '1.2.3',
          success: true,
        }),
      })
    );

    await shutdown();
    posthogMocks.capture.mockClear();

    initTelemetry({
      cliVersion: '1.2.3',
      orchestratorHarness: 'claude/opus-48',
    });

    expect(posthogMocks.capture).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'cli_install' }));
  });
});
