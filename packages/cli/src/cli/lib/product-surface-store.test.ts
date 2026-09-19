import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SurfaceProvisionError,
  describeInstallFailure,
  importFromSurfaceStore,
  isCompiledStandalone,
  provisionSurfacePackage,
  surfaceInstallPath,
  type SurfacePackage,
} from './product-surface-store.js';

const PKG: SurfacePackage = { name: '@relayfile/sdk', range: '^0.10.64' };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-store-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Stand-in for `npm install`, writing the tree a real install would leave. */
function fakeInstaller(options: { body?: string; onInstall?: (directory: string) => void } = {}) {
  const calls: string[] = [];
  const install = vi.fn(async (pkg: SurfacePackage, directory: string) => {
    calls.push(directory);
    options.onInstall?.(directory);
    const moduleDir = path.join(directory, 'node_modules', ...pkg.name.split('/'));
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, 'package.json'),
      JSON.stringify({
        name: pkg.name,
        version: '0.10.64',
        type: 'module',
        exports: { './relay-cli': './relay-cli.mjs' },
      })
    );
    fs.writeFileSync(path.join(moduleDir, 'relay-cli.mjs'), options.body ?? 'export const from = "store";\n');
  });
  return { install, calls };
}

/**
 * The marker baked into the surface file of a provisioned tree.
 *
 * Which *tree* a test ended up with is a filesystem question, and reading it is
 * how these assertions stay honest: vitest resolves a bare specifier through
 * Vite and caches it globally, so a second `importFromSurfaceStore` of
 * `@relayfile/sdk/relay-cli` would hand back the first test's module no matter
 * which directory it was pointed at. Exactly one test below imports for real.
 */
function provisionedMarker(installRoot: string): string {
  const body = fs.readFileSync(
    path.join(installRoot, 'node_modules', '@relayfile', 'sdk', 'relay-cli.mjs'),
    'utf8'
  );
  return /"([^"]+)"/.exec(body)?.[1] ?? '';
}

function silent() {
  const lines: string[] = [];
  return { notify: (line: string) => lines.push(line), lines };
}

describe('surfaceInstallPath', () => {
  it('is stable for the same package and range', () => {
    expect(surfaceInstallPath(root, PKG)).toBe(surfaceInstallPath(root, { ...PKG }));
  });

  it('separates ranges that sanitize to the same name', () => {
    // `^0.10.64` and `~0.10.64` are different installs; stripping the operator
    // to make a directory name would silently serve one for the other.
    expect(surfaceInstallPath(root, PKG)).not.toBe(surfaceInstallPath(root, { ...PKG, range: '~0.10.64' }));
  });

  it('keeps the package readable in the directory name', () => {
    expect(path.basename(surfaceInstallPath(root, PKG))).toMatch(/^relayfile-sdk-0\.10\.64-[0-9a-f]{8}$/);
  });
});

describe('provisionSurfacePackage', () => {
  it('installs once into a tree the surface really imports from', async () => {
    // The only real import in this file. It proves the mechanism the whole
    // module rests on: a bare specifier resolving against the node_modules
    // beside the generated loader, from a process whose own module directory
    // is somewhere else entirely.
    const installer = fakeInstaller();
    const notices = silent();
    const installRoot = await provisionSurfacePackage(PKG, { root, install: installer.install, ...notices });

    expect(installRoot).toBe(surfaceInstallPath(root, PKG));
    const surface = (await importFromSurfaceStore(installRoot, '@relayfile/sdk/relay-cli')) as {
      from: string;
    };
    expect(surface.from).toBe('store');
  });

  it('says what it is doing before the install and how long it took after', async () => {
    // A silent multi-minute npm install is indistinguishable from a hang.
    const notices = silent();
    await provisionSurfacePackage(PKG, { root, install: fakeInstaller().install, ...notices });

    expect(notices.lines[0]).toContain('not bundled into the standalone binary');
    expect(notices.lines[0]).toContain(surfaceInstallPath(root, PKG));
    expect(notices.lines[1]).toMatch(/@relayfile\/sdk@\^0\.10\.64 ready \(\d+s\)/);
  });

  it('reuses the provisioned tree on the next run', async () => {
    const installer = fakeInstaller();
    const deps = { root, install: installer.install, ...silent() };
    await provisionSurfacePackage(PKG, deps);
    await provisionSurfacePackage(PKG, deps);

    expect(installer.install).toHaveBeenCalledTimes(1);
  });

  it('provisions a separate tree when the pinned range changes', async () => {
    const installer = fakeInstaller();
    const deps = { root, install: installer.install, ...silent() };
    const first = await provisionSurfacePackage(PKG, deps);
    const second = await provisionSurfacePackage({ ...PKG, range: '^0.11.0' }, deps);

    expect(second).not.toBe(first);
    expect(installer.install).toHaveBeenCalledTimes(2);
  });

  it('runs one install when two callers in this process race', async () => {
    // Both mounted groups can be loaded in one invocation, and a retry can
    // re-enter the loader. Two concurrent npm installs into the same
    // destination is the failure this collapses.
    const installer = fakeInstaller();
    const deps = { root, install: installer.install, ...silent() };
    const [a, b, c] = await Promise.all([
      provisionSurfacePackage(PKG, deps),
      provisionSurfacePackage(PKG, deps),
      provisionSurfacePackage(PKG, deps),
    ]);

    expect(installer.install).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([a, a, a]);
    expect(provisionedMarker(a)).toBe('store');
  });

  it('adopts another process’s tree when it publishes the same version first', async () => {
    // Two processes that both miss the cache both install: neither can see the
    // other until a rename lands. The loser must not fail, and must not clobber
    // a directory the winner may already be importing from.
    const target = surfaceInstallPath(root, PKG);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-store-other-'));

    try {
      const winnerTree = await provisionSurfacePackage(PKG, {
        root: elsewhere,
        install: fakeInstaller({ body: 'export const from = "winner";\n' }).install,
        ...silent(),
      });

      const loser = fakeInstaller({
        body: 'export const from = "loser";\n',
        // The winner's rename lands while our own install is still running.
        onInstall: () => fs.renameSync(winnerTree, target),
      });
      const installRoot = await provisionSurfacePackage(PKG, { root, install: loser.install, ...silent() });

      expect(installRoot).toBe(target);
      expect(provisionedMarker(installRoot)).toBe('winner');
      // The loser's staging tree is discarded, not parked beside the winner's.
      expect(fs.readdirSync(root)).toEqual([path.basename(target)]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('explains a failed install instead of surfacing the installer error', async () => {
    const notices = silent();
    await expect(
      provisionSurfacePackage(PKG, {
        root,
        notify: notices.notify,
        install: async () => {
          throw new Error('npm error code ENOTFOUND');
        },
      })
    ).rejects.toThrow(/ENOTFOUND[\s\S]*network access to the npm registry[\s\S]*npm i -g agent-relay/);
  });

  it('tags a failed install so the mount can print it verbatim', async () => {
    const error = await provisionSurfacePackage(PKG, {
      root,
      ...silent(),
      install: async () => {
        throw new Error('offline');
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceProvisionError);
    expect((error as { code?: string }).code).toBe('ERR_RELAY_SURFACE_PROVISION');
  });

  it('leaves no staging directory behind when the install fails', async () => {
    await provisionSurfacePackage(PKG, {
      root,
      ...silent(),
      install: async () => {
        throw new Error('offline');
      },
    }).catch(() => undefined);

    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('retries after a failure rather than caching it', async () => {
    const deps = { root, ...silent() };
    await provisionSurfacePackage(PKG, {
      ...deps,
      install: async () => {
        throw new Error('offline');
      },
    }).catch(() => undefined);

    const installer = fakeInstaller();
    await expect(provisionSurfacePackage(PKG, { ...deps, install: installer.install })).resolves.toBe(
      surfaceInstallPath(root, PKG)
    );
  });
});

describe('importFromSurfaceStore', () => {
  it('reports a damaged tree as something the operator can repair', async () => {
    const broken = path.join(root, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'load-surface.mjs'), 'export const importSurface = 42;\n');

    await expect(importFromSurfaceStore(broken, '@relayfile/sdk/relay-cli')).rejects.toThrow(
      /damaged[\s\S]*Delete that directory and retry/
    );
  });
});

describe('describeInstallFailure', () => {
  it('names a missing npm rather than echoing a spawn error', () => {
    expect(
      describeInstallFailure('npm', Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }))
    ).toBe('`npm` is not on PATH.');
  });

  it('reports a timeout as a timeout', () => {
    expect(describeInstallFailure('npm', Object.assign(new Error('killed'), { killed: true }))).toMatch(
      /timed out after 10 minutes/
    );
  });

  it("lifts npm's first error lines out of its output", () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: [
        '',
        'npm error code ENOTFOUND',
        'npm error network request to https://registry.npmjs.org/@relayfile%2fsdk failed',
        'npm error network This is a problem related to network connectivity.',
        'npm error A complete log of this run can be found in: /home/x/.npm/_logs/2026-09-18.log',
      ].join('\n'),
    });

    const described = describeInstallFailure('npm', error);
    expect(described).toContain('npm error code ENOTFOUND');
    expect(described).not.toContain('_logs');
  });

  it('falls back to the error itself when npm wrote nothing', () => {
    expect(describeInstallFailure('npm', new Error('disk on fire'))).toBe('disk on fire');
  });
});

describe('isCompiledStandalone', () => {
  const bun = process.versions as NodeJS.ProcessVersions & { bun?: string };

  afterEach(() => {
    delete bun.bun;
  });

  it('is false under Node, where the packages are real dependencies', () => {
    expect(isCompiledStandalone(['node', '/usr/lib/node_modules/agent-relay/dist/cli/index.js'])).toBe(false);
  });

  it('is false under a plain `bun` run, which still has node_modules', () => {
    bun.bun = '1.2.0';
    expect(isCompiledStandalone(['bun', '/home/x/relay/packages/cli/dist/cli/index.js'])).toBe(false);
  });

  it('is true for the compiled binary, whose entrypoint lives in the bun VFS', () => {
    bun.bun = '1.2.0';
    expect(isCompiledStandalone(['bun', '/$bunfs/root/agent-relay-standalone'])).toBe(true);
  });
});
