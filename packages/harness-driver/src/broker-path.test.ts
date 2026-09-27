import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const originalCwd = process.cwd();
const originalExecPath = process.execPath;
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
  process.execPath = originalExecPath;
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
    const brokerBinaryPath = makeExecutable('agent-relay-broker-custom');
    const agentRelayBin = makeExecutable('agent-relay-broker');
    process.env.BROKER_BINARY_PATH = brokerBinaryPath;
    process.env.AGENT_RELAY_BIN = agentRelayBin;

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(path.resolve(brokerBinaryPath));
  });

  it('uses AGENT_RELAY_BIN when BROKER_BINARY_PATH is not set', async () => {
    const agentRelayBin = makeExecutable('agent-relay-broker');
    process.env.AGENT_RELAY_BIN = agentRelayBin;

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(path.resolve(agentRelayBin));
  });

  it('refuses a CLI executable in the legacy override instead of trying to spawn it as broker', async () => {
    process.env.AGENT_RELAY_BIN = makeExecutable('agent-relay');
    const { getBrokerBinaryPath } = await loadBrokerPathModule();
    expect(() => getBrokerBinaryPath()).toThrow(
      /AGENT_RELAY_BIN must point to an agent-relay-broker executable/u
    );
  });

  it('refuses a CLI executable in the preferred override without falling back', async () => {
    process.env.BROKER_BINARY_PATH = makeExecutable('agent-relay');
    process.env.AGENT_RELAY_BIN = makeExecutable('agent-relay-broker');
    const { getBrokerBinaryPath } = await loadBrokerPathModule();
    expect(() => getBrokerBinaryPath()).toThrow(
      /BROKER_BINARY_PATH must point to an agent-relay-broker executable/u
    );
  });

  it('refuses a broker-named symlink that resolves to the CLI', async () => {
    const cli = makeExecutable('agent-relay');
    const link = path.join(path.dirname(cli), 'agent-relay-broker');
    symlinkSync(cli, link);
    process.env.AGENT_RELAY_BIN = link;
    const { getBrokerBinaryPath } = await loadBrokerPathModule();
    expect(() => getBrokerBinaryPath()).toThrow(/resolves to the Agent Relay CLI/u);
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

  it('canonicalizes a symlinked package-manager entry before resolving the optional package', async () => {
    const root = makeTempDir();
    const entryPath = path.join(root, 'bin', 'agent-relay');
    const canonicalEntryPath = path.join(
      root,
      'lib',
      'node_modules',
      'agent-relay',
      'dist',
      'cli',
      'index.js'
    );
    const pkgName = `@agent-relay/broker-${process.platform}-${process.arch}`;
    const ext = process.platform === 'win32' ? '.exe' : '';
    const pkgJsonPath = path.join(
      root,
      'lib',
      'node_modules',
      'agent-relay',
      'node_modules',
      pkgName,
      'package.json'
    );
    const expectedBinaryPath = path.join(path.dirname(pkgJsonPath), 'bin', `agent-relay-broker${ext}`);
    const resolvePackage = vi.fn((specifier: string) => {
      if (specifier === `${pkgName}/package.json`) return pkgJsonPath;
      throw new Error(`unresolved ${specifier}`);
    });

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn((candidate: string) => candidate === expectedBinaryPath),
      realpathSync: vi.fn((candidate: string) => (candidate === entryPath ? canonicalEntryPath : candidate)),
    }));
    vi.doMock('node:module', async () => ({
      ...(await vi.importActual<typeof import('node:module')>('node:module')),
      createRequire: vi.fn((reference: string) => ({
        resolve:
          reference === canonicalEntryPath
            ? resolvePackage
            : vi.fn(() => {
                throw new Error(`unresolved from ${reference}`);
              }),
      })),
    }));
    process.argv[1] = entryPath;

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(expectedBinaryPath);
    expect(resolvePackage).toHaveBeenCalledWith(`${pkgName}/package.json`);
  });

  it('falls back to a broker installed beside the package-manager launcher', async () => {
    const root = makeTempDir();
    const entryPath = path.join(root, 'bin', 'agent-relay');
    const expectedBinaryPath = path.join(
      root,
      'bin',
      `agent-relay-broker${process.platform === 'win32' ? '.exe' : ''}`
    );
    process.argv[1] = entryPath;

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn((candidate: string) => candidate === expectedBinaryPath),
      realpathSync: vi.fn(() => {
        throw new Error('no canonical package path');
      }),
    }));
    vi.doMock('node:module', async () => ({
      ...(await vi.importActual<typeof import('node:module')>('node:module')),
      createRequire: vi.fn(() => ({
        resolve: vi.fn(() => {
          throw new Error('optional package unavailable');
        }),
      })),
    }));
    vi.doMock('node:child_process', async () => ({
      ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
      execFileSync: vi.fn(() => {
        throw new Error('not found on PATH');
      }),
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(expectedBinaryPath);
  });

  it('falls back beside the canonical target of a symlinked package-manager launcher', async () => {
    const root = makeTempDir();
    const entryPath = path.join(root, 'shims', 'agent-relay');
    const canonicalEntryPath = path.join(root, 'installs', 'node', 'bin', 'agent-relay');
    const expectedBinaryPath = path.join(
      path.dirname(canonicalEntryPath),
      `agent-relay-broker${process.platform === 'win32' ? '.exe' : ''}`
    );
    process.argv[1] = entryPath;

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn((candidate: string) => candidate === expectedBinaryPath),
      realpathSync: vi.fn((candidate: string) => (candidate === entryPath ? canonicalEntryPath : candidate)),
    }));
    vi.doMock('node:module', async () => ({
      ...(await vi.importActual<typeof import('node:module')>('node:module')),
      createRequire: vi.fn(() => ({
        resolve: vi.fn(() => {
          throw new Error('optional package unavailable');
        }),
      })),
    }));
    vi.doMock('node:child_process', async () => ({
      ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
      execFileSync: vi.fn(() => {
        throw new Error('not found on PATH');
      }),
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(expectedBinaryPath);
  });

  it('prefers a broker on PATH over a stale user-install fallback', async () => {
    const pathBinary = '/current/bin/agent-relay-broker';
    const staleBinary = path.join(
      os.homedir(),
      '.agentworkforce',
      'relay',
      'bin',
      `agent-relay-broker${process.platform === 'win32' ? '.exe' : ''}`
    );
    const execFileSync = vi.fn(() => `${pathBinary}\n`);

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn((candidate: string) => candidate === staleBinary),
    }));
    vi.doMock('node:module', async () => ({
      ...(await vi.importActual<typeof import('node:module')>('node:module')),
      createRequire: vi.fn(() => ({
        resolve: vi.fn(() => {
          throw new Error('optional package unavailable');
        }),
      })),
    }));
    vi.doMock('node:child_process', async () => ({
      ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
      execFileSync,
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(pathBinary);
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it('falls back to the legacy standalone broker install directory', async () => {
    const expectedBinaryPath = path.join(
      os.homedir(),
      '.agent-relay',
      'bin',
      `agent-relay-broker${process.platform === 'win32' ? '.exe' : ''}`
    );

    vi.doMock('node:fs', async () => ({
      ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
      existsSync: vi.fn((candidate: string) => candidate === expectedBinaryPath),
    }));
    vi.doMock('node:module', async () => ({
      ...(await vi.importActual<typeof import('node:module')>('node:module')),
      createRequire: vi.fn(() => ({
        resolve: vi.fn(() => {
          throw new Error('optional package unavailable');
        }),
      })),
    }));
    vi.doMock('node:child_process', async () => ({
      ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
      execFileSync: vi.fn(() => {
        throw new Error('not found on PATH');
      }),
    }));

    const { getBrokerBinaryPath } = await loadBrokerPathModule();

    expect(getBrokerBinaryPath()).toBe(expectedBinaryPath);
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
