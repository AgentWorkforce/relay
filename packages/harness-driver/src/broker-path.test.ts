import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  delete process.env.AGENT_RELAY_INSTALL_DIR;
  delete process.env.AGENT_RELAY_HOME;
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

  describe('canonical install location', () => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const pkgName = `@agent-relay/broker-${process.platform}-${process.arch}`;
    const optionalDepBinary = path.join('/mock/node_modules', pkgName, 'bin', `agent-relay-broker${ext}`);
    const pathBinary = '/current/bin/agent-relay-broker';

    async function loadWith(existing: string[]) {
      const execFileSync = vi.fn(() => `${pathBinary}\n`);
      vi.doMock('node:fs', async () => ({
        ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
        existsSync: vi.fn((candidate: string) => existing.includes(candidate)),
      }));
      vi.doMock('node:module', async () => ({
        ...(await vi.importActual<typeof import('node:module')>('node:module')),
        createRequire: vi.fn(() => ({
          resolve: vi.fn((specifier: string) => {
            if (specifier === `${pkgName}/package.json`) {
              return path.join('/mock/node_modules', pkgName, 'package.json');
            }
            throw new Error(`unresolved ${specifier}`);
          }),
        })),
      }));
      vi.doMock('node:child_process', async () => ({
        ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
        execFileSync,
      }));
      return { mod: await loadBrokerPathModule(), execFileSync };
    }

    it('prefers ~/.agentworkforce/relay/bin over the npm optional dependency and PATH', async () => {
      const canonical = path.join(
        os.homedir(),
        '.agentworkforce',
        'relay',
        'bin',
        `agent-relay-broker${ext}`
      );
      const { mod, execFileSync } = await loadWith([canonical, optionalDepBinary]);

      expect(mod.resolveBrokerBinary()).toEqual({ path: canonical, source: 'canonical' });
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('honours AGENT_RELAY_INSTALL_DIR over AGENT_RELAY_HOME', async () => {
      process.env.AGENT_RELAY_INSTALL_DIR = '/opt/relay';
      process.env.AGENT_RELAY_HOME = '/srv/relay-home';
      const custom = path.join('/opt/relay', 'bin', `agent-relay-broker${ext}`);
      const home = path.join('/srv/relay-home', 'bin', `agent-relay-broker${ext}`);
      const { mod } = await loadWith([custom, home, optionalDepBinary]);

      expect(mod.getBrokerBinaryPath()).toBe(custom);
    });

    it('honours AGENT_RELAY_HOME when no install dir is set', async () => {
      process.env.AGENT_RELAY_HOME = '/srv/relay-home';
      const home = path.join('/srv/relay-home', 'bin', `agent-relay-broker${ext}`);
      const { mod } = await loadWith([home, optionalDepBinary]);

      expect(mod.getBrokerBinaryPath()).toBe(home);
    });

    it('keeps an explicit env override ahead of the canonical broker', async () => {
      const canonical = path.join(
        os.homedir(),
        '.agentworkforce',
        'relay',
        'bin',
        `agent-relay-broker${ext}`
      );
      process.env.BROKER_BINARY_PATH = '/custom/broker';
      const { mod } = await loadWith(['/custom/broker', canonical]);

      expect(mod.resolveBrokerBinary()).toEqual({ path: '/custom/broker', source: 'env' });
    });

    it('uses the standalone CLI bin directory when the install root was relocated', async () => {
      process.execPath = '/opt/custom-relay/bin/agent-relay';
      const sibling = path.join('/opt/custom-relay/bin', `agent-relay-broker${ext}`);
      const { mod } = await loadWith([sibling, optionalDepBinary]);

      expect(mod.resolveBrokerBinary()).toEqual({ path: sibling, source: 'standalone' });
    });

    it('falls back to the npm optional dependency when the canonical broker is missing', async () => {
      const { mod, execFileSync } = await loadWith([optionalDepBinary]);

      expect(mod.resolveBrokerBinary()).toEqual({
        path: optionalDepBinary,
        source: 'npm-optional-dependency',
      });
      expect(mod.getOptionalDepBrokerPath()).toBe(optionalDepBinary);
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('falls back to PATH when neither the canonical nor the npm broker exists', async () => {
      const { mod, execFileSync } = await loadWith([]);

      expect(mod.resolveBrokerBinary()).toEqual({ path: pathBinary, source: 'path' });
      expect(execFileSync).toHaveBeenCalledOnce();
    });
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
    expect(message).toContain('install.sh');
    expect(message).toContain(path.join('.agentworkforce', 'relay', 'bin'));
  });
});
