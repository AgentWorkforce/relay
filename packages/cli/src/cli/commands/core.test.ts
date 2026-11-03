import { Command } from 'commander';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

const isolatedWorkspaceHome = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'relay-core-test-home-'));

vi.mock('../telemetry/index.js', () => ({
  track: telemetryMocks.track,
}));

beforeEach(() => {
  telemetryMocks.track.mockClear();
});

afterAll(() => {
  nodeFs.rmSync(isolatedWorkspaceHome, { recursive: true, force: true });
});

import { registerCoreMaintenance, type CoreDependencies, type CoreFileSystem } from './core.js';
import { INSTALLER_LAUNCHER_MARKER } from '../lib/core-maintenance.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createFsMock(initialFiles: Record<string, string> = {}): CoreFileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    realpathSync: vi.fn((p: string) => p),
    statSync: vi.fn(() => ({ dev: 256n, ino: 9876n, ctimeNs: 1000000001n, mtimeNs: 1000000001n })),
    existsSync: vi.fn((filePath: string) => files.has(filePath)),
    readFileSync: vi.fn((filePath: string) => files.get(filePath) ?? ''),
    writeFileSync: vi.fn((filePath: string, data: string) => {
      files.set(filePath, String(data));
    }),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      const data = files.get(oldPath);
      files.delete(oldPath);
      if (data !== undefined) files.set(newPath, data);
    }),
    unlinkSync: vi.fn((filePath: string) => {
      files.delete(filePath);
    }),
    readdirSync: vi.fn((directory: string) =>
      [...files.keys()]
        .filter((file) => nodePath.dirname(file) === directory)
        .map((file) => nodePath.basename(file))
    ),
    mkdirSync: vi.fn(() => undefined),
    rmSync: vi.fn((filePath: string) => {
      files.delete(filePath);
    }),
    accessSync: vi.fn(() => undefined),
  };
}

function createHarness(options?: {
  fs?: CoreFileSystem;
  env?: NodeJS.ProcessEnv;
  execCommand?: CoreDependencies['execCommand'];
  execFileCommand?: CoreDependencies['execFileCommand'];
  runInheritedCommand?: CoreDependencies['runInheritedCommand'];
  fetchText?: CoreDependencies['fetchText'];
  killImpl?: CoreDependencies['killProcess'];
  execPath?: string;
  cliScript?: string;
  checkForUpdatesResult?: Awaited<ReturnType<CoreDependencies['checkForUpdates']>>;
}) {
  const fs = options?.fs ?? createFsMock();
  const env = options?.env ?? {};
  env.AGENT_RELAY_HOME ??= isolatedWorkspaceHome;

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as CoreDependencies['exit'];

  const deps: CoreDependencies = {
    getProjectPaths: vi.fn(() => ({
      projectRoot: '/tmp/project',
      dataDir: '/tmp/project/.agentworkforce/relay',
      teamDir: '/tmp/project/.agentworkforce/relay/teams',
      dbPath: '/tmp/project/.agentworkforce/relay/messages.db',
      projectId: 'project',
    })),
    execCommand: options?.execCommand ?? vi.fn(async () => ({ stdout: '', stderr: '' })),
    execFileCommand:
      options?.execFileCommand ??
      (vi.fn(async () => ({ stdout: '', stderr: '' })) as unknown as CoreDependencies['execFileCommand']),
    runInheritedCommand:
      options?.runInheritedCommand ??
      (vi.fn(async () => 0) as unknown as CoreDependencies['runInheritedCommand']),
    fetchText:
      options?.fetchText ?? (vi.fn(async () => '#!/bin/bash\n') as unknown as CoreDependencies['fetchText']),
    killProcess: options?.killImpl ?? vi.fn(() => undefined),
    fs,
    checkForUpdates: vi.fn(
      async () => options?.checkForUpdatesResult ?? { updateAvailable: false, latestVersion: '1.2.3' }
    ) as unknown as CoreDependencies['checkForUpdates'],
    getVersion: vi.fn(() => '1.2.3'),
    env,
    execPath: options?.execPath ?? '/usr/bin/node',
    cliScript: options?.cliScript ?? '/tmp/agent-relay.js',
    pid: 4242,
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    exit,
  };

  return { deps };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err: any) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    if (typeof err?.exitCode === 'number') {
      return err.exitCode;
    }
    throw err;
  }
}

describe('registerCoreMaintenance', () => {
  it('version prints current version', async () => {
    const { deps } = createHarness();
    const program = new Command();
    registerCoreMaintenance(program, deps);

    const exitCode = await runCommand(program, ['version']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('agent-relay v1.2.3');
  });

  it('update in --check mode reports available version without installing', async () => {
    const { deps } = createHarness({
      checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
    });
    const program = new Command();
    registerCoreMaintenance(program, deps);

    const exitCode = await runCommand(program, ['update', '--check']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('New version available: 2.0.0');
    expect(deps.execCommand).not.toHaveBeenCalled();
    expect(telemetryMocks.track).not.toHaveBeenCalledWith('cli_update', expect.any(Object));
  });

  describe('update', () => {
    const NPM_SCRIPT = '/usr/lib/node_modules/agent-relay/dist/cli/index.js';
    const BUN_ENTRY = '/$bunfs/root/agent-relay';
    const standaloneRoot = isolatedWorkspaceHome;
    const standaloneBinary = `${standaloneRoot}/bin/agent-relay`;
    // An older release installed a broker beside the CLI; update leaves it alone.
    const standaloneBroker = `${standaloneRoot}/bin/agent-relay-broker`;

    function versionReporter(versions: Record<string, string>): CoreDependencies['execFileCommand'] {
      return vi.fn(async (file: string, args: string[]) => {
        const key = args.length > 1 ? args[0] : file;
        if (!(key in versions)) throw new Error(`ENOENT ${key}`);
        return { stdout: `${versions[key]}\n`, stderr: '' };
      }) as unknown as CoreDependencies['execFileCommand'];
    }

    function npmHarness(overrides: Parameters<typeof createHarness>[0] = {}) {
      return createHarness({
        checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
        cliScript: NPM_SCRIPT,
        execCommand: vi.fn(async () => ({ stdout: 'changed 1 package\n', stderr: '' })),
        execFileCommand: versionReporter({ [NPM_SCRIPT]: '2.0.0' }),
        ...overrides,
      });
    }

    function standaloneHarness(
      overrides: Parameters<typeof createHarness>[0] = {},
      files: Record<string, string> = { [standaloneBroker]: 'broker' }
    ) {
      return createHarness({
        checkForUpdatesResult: { updateAvailable: true, latestVersion: '2.0.0' },
        cliScript: BUN_ENTRY,
        execPath: standaloneBinary,
        fs: createFsMock(files),
        execFileCommand: versionReporter({ [standaloneBinary]: '2.0.0', [standaloneBroker]: '1.0.0' }),
        ...overrides,
      });
    }

    async function runUpdate(deps: CoreDependencies, args: string[] = []) {
      const program = new Command();
      registerCoreMaintenance(program, deps);
      return runCommand(program, ['update', ...args]);
    }

    function logged(fn: unknown): string {
      return vi
        .mocked(fn as (...args: unknown[]) => void)
        .mock.calls.map((call) => call.join(' '))
        .join('\n');
    }

    it('--check reports the update for a standalone install without installing anything', async () => {
      const { deps } = standaloneHarness();
      const exitCode = await runUpdate(deps, ['--check']);
      expect(exitCode).toBeUndefined();
      expect(deps.fetchText).not.toHaveBeenCalled();
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
      expect(deps.execCommand).not.toHaveBeenCalled();
    });

    it('npm: installs the pinned version, verifies the running CLI and reports success', async () => {
      const { deps } = npmHarness();

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(deps.execCommand).toHaveBeenCalledWith('npm install -g --prefix /usr agent-relay@2.0.0');
      expect(deps.execFileCommand).toHaveBeenCalledWith(
        '/usr/bin/node',
        [NPM_SCRIPT, '--version'],
        expect.objectContaining({
          env: expect.not.objectContaining({ AGENT_RELAY_VERSION: expect.anything() }),
        })
      );
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
      expect(logged(deps.log)).toContain(`Successfully updated to 2.0.0 (${NPM_SCRIPT})`);
      expect(telemetryMocks.track).toHaveBeenCalledWith('cli_update', {
        from_version: '1.2.3',
        to_version: '2.0.0',
        success: true,
        install_method: 'npm',
      });
    });

    it('npm: a non-global package (no <prefix>/lib layout) uses a plain global install', async () => {
      const script = '/home/me/.npm/_npx/abc/node_modules/agent-relay/dist/cli/index.js';
      const { deps } = npmHarness({
        cliScript: script,
        execFileCommand: versionReporter({ [script]: '2.0.0' }),
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(deps.execCommand).toHaveBeenCalledWith('npm install -g agent-relay@2.0.0');
    });

    it('npm: a failed install exits 1 and tracks the failure without leaking messages', async () => {
      const { deps } = npmHarness({
        execCommand: vi.fn(async () => {
          throw new Error('registry token /tmp/private');
        }),
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.log)).not.toContain('Successfully updated');
      expect(logged(deps.log)).toContain(
        'Try running manually: npm install -g --prefix /usr agent-relay@2.0.0'
      );
      expect(telemetryMocks.track).toHaveBeenCalledWith('cli_update', {
        from_version: '1.2.3',
        to_version: '2.0.0',
        success: false,
        install_method: 'npm',
        error_class: 'UpdateError',
      });
    });

    it('npm: exits 1 when npm succeeded but the running CLI did not change (different prefix)', async () => {
      const { deps } = npmHarness({ execFileCommand: versionReporter({ [NPM_SCRIPT]: '1.2.3' }) });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.error)).toContain(`reports 1.2.3 instead of 2.0.0`);
      expect(logged(deps.log)).not.toContain('Successfully updated');
    });

    it('standalone: runs the release installer pinned to the version against the running install root', async () => {
      const { deps } = standaloneHarness({
        env: { AGENT_RELAY_HOME: standaloneRoot, PATH: '/usr/bin', AGENT_RELAY_VERSION: '9.9.9' },
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(deps.fetchText).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/AgentWorkforce/relay/v2.0.0/install.sh'
      );
      const workDir = `${standaloneRoot}/.update-4242`;
      expect(deps.fs.writeFileSync).toHaveBeenCalledWith(`${workDir}/install.sh`, '#!/bin/bash\n', 'utf-8');
      expect(deps.runInheritedCommand).toHaveBeenCalledWith('bash', [`${workDir}/install.sh`], {
        env: expect.objectContaining({
          PATH: '/usr/bin',
          AGENT_RELAY_VERSION: '2.0.0',
          AGENT_RELAY_INSTALL_DIR: standaloneRoot,
          AGENT_RELAY_INSTALL_METHOD: 'standalone',
        }),
      });
      expect(deps.fs.rmSync).toHaveBeenCalledWith(workDir, { recursive: true, force: true });
      // Verified after install: the CLI that ran. An old broker beside it is
      // neither run nor removed.
      expect(deps.execFileCommand).toHaveBeenCalledWith(standaloneBinary, ['--version'], expect.any(Object));
      expect(deps.execFileCommand).not.toHaveBeenCalledWith(
        standaloneBroker,
        expect.anything(),
        expect.anything()
      );
      expect(deps.fs.existsSync(standaloneBroker)).toBe(true);
      // Never npm.
      expect(deps.execCommand).not.toHaveBeenCalledWith(expect.stringContaining('npm'));
      expect(logged(deps.log)).toContain(`Successfully updated to 2.0.0 (${standaloneBinary})`);
      expect(telemetryMocks.track).toHaveBeenCalledWith('cli_update', {
        from_version: '1.2.3',
        to_version: '2.0.0',
        success: true,
        install_method: 'standalone',
      });
    });

    it('standalone: honours AGENT_RELAY_INSTALL_DIR for a relocated install', async () => {
      const root = '/opt/relay';
      const { deps } = standaloneHarness(
        {
          env: { AGENT_RELAY_INSTALL_DIR: root },
          execPath: `${root}/bin/agent-relay`,
          execFileCommand: versionReporter({ [`${root}/bin/agent-relay`]: '2.0.0' }),
        },
        {}
      );

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(deps.runInheritedCommand).toHaveBeenCalledWith('bash', [`${root}/.update-4242/install.sh`], {
        env: expect.objectContaining({ AGENT_RELAY_INSTALL_DIR: root }),
      });
    });

    it('standalone: a failing installer exits 1, never falls back to npm and never claims success', async () => {
      const { deps } = standaloneHarness({ runInheritedCommand: vi.fn(async () => 1) });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.error)).toContain('the installer exited with status 1');
      expect(logged(deps.log)).toContain('AGENT_RELAY_VERSION=2.0.0 bash');
      expect(logged(deps.log)).not.toContain('Successfully updated');
      expect(deps.execCommand).not.toHaveBeenCalledWith(expect.stringContaining('npm'));
      expect(deps.fs.rmSync).toHaveBeenCalledWith(`${standaloneRoot}/.update-4242`, {
        recursive: true,
        force: true,
      });
      expect(telemetryMocks.track).toHaveBeenCalledWith(
        'cli_update',
        expect.objectContaining({ success: false, install_method: 'standalone', error_class: 'UpdateError' })
      );
    });

    it('standalone: exits 1 when the installer succeeded but the running binary is still old', async () => {
      const { deps } = standaloneHarness({
        execFileCommand: versionReporter({ [standaloneBinary]: '1.2.3', [standaloneBroker]: '2.0.0' }),
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.error)).toContain(`${standaloneBinary} reports 1.2.3 instead of 2.0.0`);
      expect(logged(deps.log)).not.toContain('Successfully updated');
    });

    it('standalone: an already-current CLI beside an old broker does not reinstall', async () => {
      const { deps } = standaloneHarness({
        checkForUpdatesResult: { updateAvailable: false, latestVersion: '1.2.3' },
        execFileCommand: versionReporter({ [standaloneBinary]: '1.2.3', [standaloneBroker]: '1.0.0' }),
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(logged(deps.log)).not.toContain('broker');
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
      expect(deps.fs.existsSync(standaloneBroker)).toBe(true);
    });

    it('standalone: a current CLI does nothing', async () => {
      const { deps } = standaloneHarness({
        checkForUpdatesResult: { updateAvailable: false, latestVersion: '1.2.3' },
        execFileCommand: versionReporter({ [standaloneBinary]: '1.2.3', [standaloneBroker]: '1.2.3' }),
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
      expect(deps.fetchText).not.toHaveBeenCalled();
    });

    it('standalone: exits 1 when the installer cannot be downloaded', async () => {
      const { deps } = standaloneHarness({
        fetchText: vi.fn(async () => {
          throw new Error('HTTP 404');
        }),
      });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.error)).toContain('HTTP 404');
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
    });

    it('refuses a standalone binary outside the install directory', async () => {
      const { deps } = standaloneHarness({ execPath: '/usr/local/bin/agent-relay' });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.error)).toContain('is not in an Agent Relay install directory');
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
      expect(deps.execCommand).not.toHaveBeenCalled();
    });

    it('refuses an unrecognised install (source checkout) instead of guessing npm', async () => {
      const { deps } = npmHarness({ cliScript: '/home/me/relay/packages/cli/dist/cli/index.js' });

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBe(1);
      expect(logged(deps.error)).toContain('cannot tell how agent-relay was installed');
      expect(deps.execCommand).not.toHaveBeenCalled();
      expect(deps.runInheritedCommand).not.toHaveBeenCalled();
    });

    it('notes that prereleases are not moved along their channel', async () => {
      const { deps } = createHarness({
        checkForUpdatesResult: { updateAvailable: false, latestVersion: '1.2.0' },
      });
      vi.mocked(deps.getVersion).mockReturnValue('1.3.0-next.0');

      const exitCode = await runUpdate(deps);

      expect(exitCode).toBeUndefined();
      expect(logged(deps.log)).toContain(
        'only installs releases from the `latest` channel (currently 1.2.0)'
      );
    });
  });

  it('uninstall dry-run covers renamed and legacy installer bin directories', async () => {
    const { deps } = createHarness();
    const program = new Command();
    registerCoreMaintenance(program, deps);
    const home = os.homedir();
    const paths = [`${home}/.agentworkforce/relay/bin`, `${home}/.agent-relay/bin`];
    for (const filePath of paths) {
      deps.fs.writeFileSync(filePath, '');
    }

    const exitCode = await runCommand(program, ['uninstall', '--dry-run']);

    expect(exitCode).toBeUndefined();
    for (const filePath of paths) {
      expect(deps.log).toHaveBeenCalledWith(`[dry-run] Would remove directory: ${filePath}`);
    }
    expect(deps.execCommand).not.toHaveBeenCalled();
  });

  it('uninstall removes the installer-written relay launcher but keeps a foreign relay', async () => {
    const home = os.homedir();
    const relayPath = `${home}/.local/bin/relay`;
    const agentRelayPath = `${home}/.local/bin/agent-relay`;
    const launcher = `#!/usr/bin/env bash\n${INSTALLER_LAUNCHER_MARKER}\nexec /x/agent-relay "$@"\n`;

    const ours = createHarness();
    ours.deps.fs.writeFileSync(relayPath, launcher);
    ours.deps.fs.writeFileSync(agentRelayPath, launcher);
    const oursProgram = new Command();
    registerCoreMaintenance(oursProgram, ours.deps);
    expect(await runCommand(oursProgram, ['uninstall'])).toBeUndefined();
    expect(ours.deps.fs.existsSync(relayPath)).toBe(false);
    expect(ours.deps.fs.existsSync(agentRelayPath)).toBe(false);
    expect(ours.deps.log).toHaveBeenCalledWith(`Removed ${relayPath}`);

    const foreign = createHarness();
    foreign.deps.fs.writeFileSync(relayPath, '#!/bin/sh\necho some other relay tool\n');
    const foreignProgram = new Command();
    registerCoreMaintenance(foreignProgram, foreign.deps);
    expect(await runCommand(foreignProgram, ['uninstall'])).toBeUndefined();
    expect(foreign.deps.fs.existsSync(relayPath)).toBe(true);
    expect(foreign.deps.fs.unlinkSync).not.toHaveBeenCalledWith(relayPath);

    // A user-created symlink to a marked launcher is not ours either.
    const symlinked = createHarness();
    symlinked.deps.fs.writeFileSync(relayPath, launcher);
    symlinked.deps.fs.lstatSync = vi.fn(() => ({ isFile: () => false }));
    const symlinkedProgram = new Command();
    registerCoreMaintenance(symlinkedProgram, symlinked.deps);
    expect(await runCommand(symlinkedProgram, ['uninstall'])).toBeUndefined();
    expect(symlinked.deps.fs.existsSync(relayPath)).toBe(true);
  });
});
