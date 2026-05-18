import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { checkPrereqs, resolvePrereqPaths } from './prereqs.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  spawnSyncMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.chdir('/var/tmp');
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolvePrereqPaths', () => {
  it('prefers an existing parent relayauth directory over a missing cwd candidate', () => {
    const root = makeTempDir('relay-prereqs-');
    const workspace = path.join(root, 'workspace', 'project');
    const parentRelayauth = path.join(root, 'workspace', 'relayauth');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(parentRelayauth, { recursive: true });
    mkdirSync(path.join(root, 'workspace', 'relayfile'), { recursive: true });
    process.chdir(workspace);

    const resolved = resolvePrereqPaths();

    expect(resolved.relayauthRoot).toBe(realpathSync(parentRelayauth));
    expect(resolved.relayfileRoot).toBe(realpathSync(path.join(root, 'workspace', 'relayfile')));
  });

  it('prefers explicit config over discovered paths', () => {
    const root = makeTempDir('relay-prereqs-');
    const workspace = path.join(root, 'workspace');
    const relayauth = path.join(root, 'custom-relayauth');
    const relayfile = path.join(root, 'custom-relayfile');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(relayauth, { recursive: true });
    mkdirSync(relayfile, { recursive: true });
    process.chdir(workspace);

    const resolved = resolvePrereqPaths({ relayauthRoot: relayauth, relayfileRoot: relayfile });

    expect(resolved).toEqual({ relayauthRoot: relayauth, relayfileRoot: relayfile });
  });
});

describe('checkPrereqs', () => {
  it('returns ok when all tools and files are present', async () => {
    const root = makeTempDir('relay-prereqs-');
    const relayauth = path.join(root, 'relayauth');
    const relayfile = path.join(root, 'relayfile');
    mkdirSync(path.join(relayauth, '.wrangler', 'state', 'v3', 'd1'), { recursive: true });
    mkdirSync(path.join(relayauth, 'packages', 'sdk', 'dist'), { recursive: true });
    mkdirSync(path.join(relayfile, 'bin'), { recursive: true });
    writeFileSync(path.join(relayauth, 'packages', 'sdk', 'dist', 'index.js'), 'export {}\n');
    writeFileSync(path.join(relayfile, 'bin', 'relayfile'), '');
    spawnSyncMock.mockReturnValue({ status: 0 });

    const result = await checkPrereqs({}, { relayauthRoot: relayauth, relayfileRoot: relayfile });

    expect(result).toEqual({ ok: true, missing: [] });
    expect(spawnSyncMock).toHaveBeenCalledWith('node', ['--version'], { stdio: 'ignore' });
    expect(spawnSyncMock).toHaveBeenCalledWith('npx', ['wrangler', '--version'], { stdio: 'ignore' });
  });

  it('reports missing items and records sdk build failure', async () => {
    const root = makeTempDir('relay-prereqs-');
    const relayauth = path.join(root, 'relayauth');
    const relayfile = path.join(root, 'relayfile');
    mkdirSync(relayauth, { recursive: true });
    mkdirSync(relayfile, { recursive: true });

    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'npx' && Array.isArray(args) && args[0] === 'turbo') {
        return { status: 1 };
      }
      return { status: 1 };
    });

    const result = await checkPrereqs({}, { relayauthRoot: relayauth, relayfileRoot: relayfile });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining([
      'node',
      'npx',
      'go',
      'wrangler',
      'relayfile binary',
      'D1 database',
      'relayauth SDK build (run `npx turbo build` in relayauth root)',
    ]));
  });
});
