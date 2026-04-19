import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapEntryPath = fileURLToPath(new URL('./bootstrap.ts', import.meta.url));
const indexEntryPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const originalArgv = [...process.argv];

function mockBootstrapDependencies(parseSpy: ReturnType<typeof vi.fn>): void {
  vi.doMock('dotenv', () => ({
    config: vi.fn(),
  }));
  vi.doMock('@agent-relay/utils', () => ({
    checkForUpdatesInBackground: vi.fn(),
  }));
  vi.doMock('@agent-relay/telemetry', () => ({
    initTelemetry: vi.fn(),
    track: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./commands/agent-management.js', () => ({
    registerAgentManagementCommands: vi.fn(),
  }));
  vi.doMock('./commands/messaging.js', () => ({
    registerMessagingCommands: vi.fn(),
  }));
  vi.doMock('./commands/cloud.js', () => ({
    registerCloudCommands: vi.fn(),
  }));
  vi.doMock('./commands/monitoring.js', () => ({
    registerMonitoringCommands: vi.fn(),
  }));
  vi.doMock('./commands/auth.js', () => ({
    registerAuthCommands: vi.fn(),
  }));
  vi.doMock('./commands/setup.js', () => ({
    registerSetupCommands: vi.fn(),
  }));
  vi.doMock('./commands/core.js', () => ({
    registerCoreCommands: vi.fn(),
  }));
  vi.doMock('./commands/swarm.js', () => ({
    registerSwarmCommands: vi.fn(),
  }));
  vi.doMock('./commands/connect.js', () => ({
    registerConnectCommands: vi.fn(),
  }));
  vi.doMock('commander', async (importOriginal) => {
    const actual = await importOriginal<typeof import('commander')>();

    class MockCommand extends actual.Command {
      parse(...args: Parameters<actual.Command['parse']>) {
        parseSpy(...args);
        return this;
      }
    }

    return {
      ...actual,
      Command: MockCommand,
    };
  });
}

describe('CLI entrypoints', () => {
  beforeEach(() => {
    vi.resetModules();
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it('bootstrap stays side-effect free when imported as the invoked script', async () => {
    const parseSpy = vi.fn();
    mockBootstrapDependencies(parseSpy);
    process.argv = ['node', bootstrapEntryPath, 'status'];

    await import('./bootstrap.js');

    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('index invokes runCli exactly once when used as the entrypoint', async () => {
    const runCli = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./bootstrap.js', () => ({
      runCli,
    }));
    process.argv = ['node', indexEntryPath, 'status'];

    await import('./index.js');

    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it('publishes the CLI binary from the single index entrypoint', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin?.['agent-relay']).toBe('dist/src/cli/index.js');
  });
});
