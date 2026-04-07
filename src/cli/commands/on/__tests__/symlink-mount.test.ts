import {
  symlinkSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSymlinkMount } from '../symlink-mount.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSymlinkMount', () => {
  it('copies files with expected permissions, syncs writable changes, and cleans up', async () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');

    mkdirSync(path.join(projectDir, 'src', 'nested'), { recursive: true });
    mkdirSync(path.join(projectDir, 'empty', 'child'), { recursive: true });
    mkdirSync(path.join(projectDir, 'ignored-dir'), { recursive: true });

    const writableFile = path.join(projectDir, 'src', 'writable.txt');
    const untouchedFile = path.join(projectDir, 'src', 'untouched.txt');
    const readonlyFile = path.join(projectDir, 'src', 'readonly.txt');
    const nestedWritableFile = path.join(projectDir, 'src', 'nested', 'keep.ts');
    const nestedIgnoredFile = path.join(projectDir, 'src', 'nested', 'secret.env');
    const ignoredFile = path.join(projectDir, 'ignored-dir', 'skip.txt');

    writeFileSync(writableFile, 'alpha\n');
    chmodSync(writableFile, 0o640);
    writeFileSync(untouchedFile, 'steady\n');
    chmodSync(untouchedFile, 0o644);
    writeFileSync(readonlyFile, 'locked\n');
    chmodSync(readonlyFile, 0o600);
    writeFileSync(nestedWritableFile, 'export const value = 1;\n');
    writeFileSync(nestedIgnoredFile, 'SECRET=true\n');
    writeFileSync(ignoredFile, 'ignore me\n');

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: ['ignored-dir', 'src/**/*.env'],
      readonlyPatterns: ['src/readonly.txt'],
      excludeDirs: [],
    });

    const mountedWritable = path.join(mountDir, 'src', 'writable.txt');
    const mountedReadonly = path.join(mountDir, 'src', 'readonly.txt');
    const mountedNestedWritable = path.join(mountDir, 'src', 'nested', 'keep.ts');

    expect(handle.mountDir).toBe(mountDir);
    expect(existsSync(path.join(mountDir, 'src'))).toBe(true);
    expect(existsSync(path.join(mountDir, 'src', 'nested'))).toBe(true);
    expect(existsSync(path.join(mountDir, 'empty', 'child'))).toBe(true);

    expect(lstatSync(mountedWritable).isSymbolicLink()).toBe(false);
    expect(readFileSync(mountedWritable, 'utf8')).toBe('alpha\n');
    expect(statSync(mountedWritable).mode & 0o777).toBe(0o640);

    expect(readFileSync(mountedReadonly, 'utf8')).toBe('locked\n');
    expect(statSync(mountedReadonly).mode & 0o777).toBe(0o444);

    expect(existsSync(path.join(mountDir, 'ignored-dir'))).toBe(false);
    expect(existsSync(path.join(mountDir, 'src', 'nested', 'secret.env'))).toBe(false);

    const permissionsDoc = readFileSync(path.join(mountDir, '_PERMISSIONS.md'), 'utf8');
    expect(permissionsDoc).toContain('# Workspace Permissions');
    expect(permissionsDoc).toContain('src/readonly.txt');
    expect(permissionsDoc).toContain('ignored-dir');
    expect(permissionsDoc).toContain('src/**/*.env');

    writeFileSync(mountedWritable, 'beta\n');
    writeFileSync(mountedNestedWritable, 'export const value = 2;\n');
    chmodSync(mountedReadonly, 0o644);
    writeFileSync(mountedReadonly, 'mutated\n');

    mkdirSync(path.join(mountDir, 'ignored-dir'), { recursive: true });
    writeFileSync(path.join(mountDir, 'ignored-dir', 'skip.txt'), 'should stay ignored\n');
    mkdirSync(path.join(mountDir, 'src', 'nested'), { recursive: true });
    writeFileSync(path.join(mountDir, 'src', 'nested', 'secret.env'), 'SHOULD_NOT_SYNC=true\n');

    const synced = await handle.syncBack();

    expect(synced).toBe(2);
    expect(readFileSync(writableFile, 'utf8')).toBe('beta\n');
    expect(readFileSync(nestedWritableFile, 'utf8')).toBe('export const value = 2;\n');
    expect(readFileSync(untouchedFile, 'utf8')).toBe('steady\n');
    expect(readFileSync(readonlyFile, 'utf8')).toBe('locked\n');
    expect(readFileSync(ignoredFile, 'utf8')).toBe('ignore me\n');
    expect(readFileSync(nestedIgnoredFile, 'utf8')).toBe('SECRET=true\n');

    handle.cleanup();
    expect(existsSync(mountDir)).toBe(false);
  });

  it('handles nested ignore patterns for files and directories', () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');

    mkdirSync(path.join(projectDir, 'apps', 'api', 'dist'), { recursive: true });
    mkdirSync(path.join(projectDir, 'apps', 'api', 'src'), { recursive: true });
    mkdirSync(path.join(projectDir, 'apps', 'web', 'logs'), { recursive: true });

    writeFileSync(path.join(projectDir, 'apps', 'api', 'dist', 'bundle.js'), 'ignored bundle\n');
    writeFileSync(path.join(projectDir, 'apps', 'api', 'src', 'keep.ts'), 'export const api = true;\n');
    writeFileSync(path.join(projectDir, 'apps', 'web', 'logs', 'build.tmp'), 'ignored temp\n');
    writeFileSync(path.join(projectDir, 'apps', 'web', 'logs', 'keep.md'), 'kept\n');

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: ['apps/**/dist', 'apps/**/*.tmp'],
      readonlyPatterns: [],
      excludeDirs: [],
    });

    expect(existsSync(path.join(mountDir, 'apps', 'api', 'dist'))).toBe(false);
    expect(existsSync(path.join(mountDir, 'apps', 'web', 'logs', 'build.tmp'))).toBe(false);
    expect(readFileSync(path.join(mountDir, 'apps', 'api', 'src', 'keep.ts'), 'utf8')).toBe(
      'export const api = true;\n'
    );
    expect(readFileSync(path.join(mountDir, 'apps', 'web', 'logs', 'keep.md'), 'utf8')).toBe('kept\n');

    handle.cleanup();
  });

  it('honors trailing-slash ignore patterns for directories', () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');

    mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
    writeFileSync(path.join(projectDir, 'logs', 'app.log'), 'ignore me\n');
    writeFileSync(path.join(projectDir, 'keep.txt'), 'keep me\n');

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: ['logs/'],
      readonlyPatterns: [],
      excludeDirs: [],
    });

    expect(existsSync(path.join(mountDir, 'logs'))).toBe(false);
    expect(readFileSync(path.join(mountDir, 'keep.txt'), 'utf8')).toBe('keep me\n');

    handle.cleanup();
  });

  it('applies rootless file ignore patterns to nested files', () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');

    mkdirSync(path.join(projectDir, 'src', 'nested'), { recursive: true });
    writeFileSync(path.join(projectDir, 'src', 'nested', 'keep.ts'), 'export const keep = true;\n');
    writeFileSync(path.join(projectDir, 'src', 'nested', 'secret.env'), 'SECRET=value\n');

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: ['*.env'],
      readonlyPatterns: [],
      excludeDirs: [],
    });

    expect(readFileSync(path.join(mountDir, 'src', 'nested', 'keep.ts'), 'utf8')).toBe(
      'export const keep = true;\n'
    );
    expect(existsSync(path.join(mountDir, 'src', 'nested', 'secret.env'))).toBe(false);

    handle.cleanup();
  });

  it('does not sync into symlinked project directories outside the project root', async () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');
    const externalDir = makeTempDir('relay-symlink-external-');

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: [],
      readonlyPatterns: [],
      excludeDirs: [],
    });

    symlinkSync(externalDir, path.join(projectDir, 'linked'));
    mkdirSync(path.join(mountDir, 'linked'), { recursive: true });
    writeFileSync(path.join(mountDir, 'linked', 'escape.txt'), 'do not leak\n');

    const synced = await handle.syncBack();

    expect(synced).toBe(0);
    expect(existsSync(path.join(externalDir, 'escape.txt'))).toBe(false);

    handle.cleanup();
  });

  it('skips symlinked files that resolve outside the project root', () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');
    const externalDir = makeTempDir('relay-symlink-external-');

    writeFileSync(path.join(projectDir, 'keep.txt'), 'keep me\n');
    writeFileSync(path.join(externalDir, 'secret.txt'), 'do not copy\n');
    symlinkSync(path.join(externalDir, 'secret.txt'), path.join(projectDir, 'secret.txt'));

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: [],
      readonlyPatterns: [],
      excludeDirs: [],
    });

    expect(readFileSync(path.join(mountDir, 'keep.txt'), 'utf8')).toBe('keep me\n');
    expect(existsSync(path.join(mountDir, 'secret.txt'))).toBe(false);

    handle.cleanup();
  });

  it('allows cleanup when the mount directory is already gone', () => {
    const projectDir = makeTempDir('relay-symlink-project-');
    const mountParentDir = makeTempDir('relay-symlink-mount-');
    const mountDir = path.join(mountParentDir, 'mounted-workspace');

    const handle = createSymlinkMount(projectDir, mountDir, {
      ignoredPatterns: [],
      readonlyPatterns: [],
      excludeDirs: [],
    });

    rmSync(mountDir, { recursive: true, force: true });

    expect(() => handle.cleanup()).not.toThrow();
  });
});
