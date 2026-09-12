import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findProjectRoot } from './project-namespace.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-boundary-'));
  vi.stubEnv('AGENT_RELAY_PROJECT', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('shared repository workspace boundary', () => {
  it('uses the checkout root from nested packages before and after a pin is written', () => {
    const nested = path.join(root, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    expect(findProjectRoot(nested)).toBe(root);
    fs.mkdirSync(path.join(root, '.agentworkforce', 'relay'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agentworkforce', 'relay', 'workspace-key.json'), '{}');
    expect(findProjectRoot(nested)).toBe(root);
  });
  it('preserves an existing explicitly pinned subproject and environment overrides', () => {
    const nested = path.join(root, 'packages', 'web');
    fs.mkdirSync(path.join(nested, '.agentworkforce', 'relay'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(nested, '.agentworkforce', 'relay', 'workspace-key.json'), '{}');
    expect(findProjectRoot(nested)).toBe(nested);
    vi.stubEnv('AGENT_RELAY_PROJECT', root);
    expect(findProjectRoot(nested)).toBe(root);
  });
  it('recognizes a worktree Git file and preserves package roots outside Git', () => {
    const nested = path.join(root, 'package');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    expect(findProjectRoot(nested)).toBe(nested);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /unused/metadata');
    expect(findProjectRoot(nested)).toBe(root);
  });
  it('accepts a valid symlinked Git marker', () => {
    const gitTarget = path.join(root, 'gitdir-file');
    fs.writeFileSync(gitTarget, 'gitdir: /valid/worktree/metadata');
    fs.symlinkSync(gitTarget, path.join(root, '.git'));

    expect(findProjectRoot(root)).toBe(root);
  });
  it('fails closed for a malformed Git marker rather than selecting a package workspace', () => {
    const nested = path.join(root, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    fs.symlinkSync('/nonexistent/git', path.join(root, '.git'));
    expect(() => findProjectRoot(nested)).toThrow('Cannot resolve the repository workspace');
  });
});
