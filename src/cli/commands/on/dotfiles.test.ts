import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { compileDotfiles, discoverAgents, hasDotfiles, parseDotfiles } from './dotfiles.js';

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

describe('dotfiles helpers', () => {
  it('detects dotfiles, discovers agents, and parses cleaned patterns', () => {
    const root = makeTempDir('relay-dotfiles-');
    writeFileSync(path.join(root, '.agentignore'), '# comment\ndist\n\nnode_modules\n', 'utf8');
    writeFileSync(path.join(root, '.writer.agentreadonly'), 'docs/**\n# ignore\n\nREADME.md\n', 'utf8');

    expect(hasDotfiles(root)).toBe(true);
    expect(discoverAgents(root)).toEqual(['writer']);

    const parsed = parseDotfiles(root, 'writer');
    expect(parsed.projectDir).toBe(path.resolve(root));
    expect(parsed.ignoredPatterns).toEqual(['dist', 'node_modules']);
    expect(parsed.readonlyPatterns).toEqual(['docs/**', 'README.md']);
    expect(parsed.ignored.ignores('dist/app.js')).toBe(true);
    expect(parsed.readonly.ignores('docs/guide.md')).toBe(true);
  });

  it('compiles ignored, readonly, readwrite paths, acl, and scopes', () => {
    const root = makeTempDir('relay-dotfiles-');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    mkdirSync(path.join(root, 'secrets'), { recursive: true });
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.agentignore'), 'secrets/**\n', 'utf8');
    writeFileSync(path.join(root, '.reviewer.agentreadonly'), 'docs/**\n', 'utf8');
    writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    writeFileSync(path.join(root, 'secrets', 'token.txt'), 'shh\n', 'utf8');
    writeFileSync(path.join(root, '.git', 'ignored.txt'), 'skip\n', 'utf8');

    const compiled = compileDotfiles(root, 'reviewer', 'team-space');

    expect(compiled.workspace).toBe('team-space');
    expect(compiled.agentName).toBe('reviewer');
    expect(compiled.ignoredPatterns).toEqual(['secrets/**']);
    expect(compiled.readonlyPatterns).toEqual(['docs/**']);
    expect(compiled.ignoredPaths).toEqual(['secrets/token.txt']);
    expect(compiled.readonlyPaths).toEqual(['docs/guide.md']);
    expect(compiled.readwritePaths).toEqual(['.agentignore', '.reviewer.agentreadonly', 'src/index.ts']);
    expect(compiled.summary).toEqual({ ignored: 1, readonly: 1, readwrite: 3 });
    expect(compiled.acl).toEqual({ '/secrets': ['deny:agent:reviewer'] });
    expect(compiled.scopes).toEqual([
      'relayfile:fs:read:/.agentignore',
      'relayfile:fs:read:/.reviewer.agentreadonly',
      'relayfile:fs:read:/docs/guide.md',
      'relayfile:fs:read:/src/index.ts',
      'relayfile:fs:write:/.agentignore',
      'relayfile:fs:write:/.reviewer.agentreadonly',
      'relayfile:fs:write:/src/index.ts',
    ]);
  });

  it('returns false/no agents when no matching dotfiles exist', () => {
    const root = makeTempDir('relay-dotfiles-');
    writeFileSync(path.join(root, 'README.md'), 'hello\n', 'utf8');

    expect(hasDotfiles(root)).toBe(false);
    expect(discoverAgents(root)).toEqual([]);
  });
});
