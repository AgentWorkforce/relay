import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function loadBrokerPathModule(): Promise<typeof import('./broker-path.js')> {
  return import('./broker-path.js');
}

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-broker-path-'));
  tempDirs.push(dir);
  return dir;
}

function makeExecutable(fileName = 'agent-relay-broker'): string {
  const dir = makeTempDir();
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  chmodSync(filePath, 0o755);
  return filePath;
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  delete process.env.BROKER_BINARY_PATH;
  delete process.env.AGENT_RELAY_BIN;
  process.argv = [...originalArgv];
});

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.doUnmock('node:module');
  vi.resetModules();
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
  process.chdir(originalCwd);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('broker binary path resolution', () => {
  it('formats platform optional dependency package names', async () => {
    const { getOptionalDepPackageName } = await loadBrokerPathModule();

    expect(getOptionalDepPackageName('linux', 'x64')).toBe('@agent-relay/broker-linux-x64');
    expect(getOptionalDepPackageName('darwin', 'arm64')).toBe('@agent-relay/broker-darwin-arm64');
  });

  it('prefers BROKER_BINARY_PATH over AGENT_RELAY_BIN', async () => {
    const brokerBinaryPath = makeExecutable('broker-override');
    const agentRelayBin = makeExecutable('agent-relay-bin');
    process.env.BROKER_BINARY_PATH = brokerBinaryPath;
    process.env.AGENT_RELAY_BIN = agentRelayBin;

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(path.resolve(brokerBinaryPath));
  });

  it('uses AGENT_RELAY_BIN when BROKER_BINARY_PATH is not set', async () => {
    const agentRelayBin = makeExecutable('agent-relay-bin');
    process.env.AGENT_RELAY_BIN = agentRelayBin;

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(path.resolve(agentRelayBin));
  });

  it('resolves the broker from the platform optional dependency package', async () => {
    const pkgName = `@agent-relay/broker-${process.platform}-${process.arch}`;
    const ext = process.platform === 'win32' ? '.exe' : '';
    const pkgJsonPath = path.join('/mock/project/node_modules', pkgName, 'package.json');
    const expectedBinaryPath = path.join(path.dirname(pkgJsonPath), 'bin', `agent-relay-broker${ext}`);
    const existsSync = vi.fn((candidate: string) => candidate === expectedBinaryPath);
    const resolve = vi.fn((specifier: string) => {
      if (specifier === `${pkgName}/package.json`) return pkgJsonPath;
      throw new Error(`unresolved ${specifier}`);
    });

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync,
    }));
    vi.doMock('node:module', async () => ({
      ...(await vi.importActual<typeof import('node:module')>('node:module')),
      createRequire: vi.fn(() => ({ resolve })),
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(expectedBinaryPath);
    expect(resolve).toHaveBeenCalledWith(`${pkgName}/package.json`);
  });

  it('falls back to PATH lookup after env, optional package, and development paths miss', async () => {
    const pathBinary = '/usr/local/bin/agent-relay-broker';
    const execFileSync = vi.fn(() => `${pathBinary}\n`);

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn(() => false),
    }));
    vi.doMock('node:child_process', async () => ({
      ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
      execFileSync,
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(pathBinary);
    expect(execFileSync).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'where' : 'which',
      ['agent-relay-broker'],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
  });

  it('returns null when every resolver misses', async () => {
    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn(() => false),
    }));
    vi.doMock('node:child_process', async () => ({
      ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
      execFileSync: vi.fn(() => {
        throw new Error('not found');
      }),
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBeNull();
  });

  it('explains missing optional dependency packages', async () => {
    const { formatBrokerNotFoundError, getOptionalDepPackageName } = await loadBrokerPathModule();
    const message = formatBrokerNotFoundError();

    expect(message).toContain(`${process.platform}-${process.arch}`);
    expect(message).toContain(getOptionalDepPackageName());
    expect(message).toContain('--include=optional');
  });
});
