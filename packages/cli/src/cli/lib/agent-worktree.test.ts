import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupAgentWorktree,
  createAgentWorktree,
  diffAgentWorktree,
  findAgentWorktree,
  mergeAgentWorktree,
  removeFreshWorktree,
  resolveMainCheckout,
  validateWorktreeAgentName,
} from './agent-worktree.js';

let parent: string;
let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(dir: string, file: string, contents: string): void {
  fs.writeFileSync(path.join(dir, file), contents);
}

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

beforeEach(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-worktree-test-')));
  repo = path.join(parent, 'project');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.invalid']);
  write(repo, 'page.html', '<h1>My Tasks</h1>\n<p>body</p>\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('createAgentWorktree', () => {
  it('gives the agent its own checkout on relay/<name> without touching the main checkout', () => {
    const worktree = createAgentWorktree(repo, 'alpha');

    expect(worktree).toMatchObject({
      root: repo,
      branch: 'relay/alpha',
      created: true,
      mainCheckoutDirty: false,
    });
    expect(worktree.path).toBe(path.join(repo, '.agentworkforce', 'relay', 'worktrees', 'alpha'));
    write(worktree.path, 'page.html', '<h1>Alpha</h1>\n<p>body</p>\n');
    expect(read(repo, 'page.html')).toContain('My Tasks');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('reuses an existing checkout when the agent is spawned again', () => {
    const first = createAgentWorktree(repo, 'alpha');
    write(first.path, 'notes.txt', 'keep me\n');

    const second = createAgentWorktree(repo, 'alpha');

    expect(second.created).toBe(false);
    expect(read(second.path, 'notes.txt')).toBe('keep me\n');
  });

  it('flags uncommitted main-checkout changes but ignores relay state files', () => {
    fs.mkdirSync(path.join(repo, '.agentworkforce', 'relay'), { recursive: true });
    write(path.join(repo, '.agentworkforce', 'relay'), 'connection.json', '{}');
    expect(createAgentWorktree(repo, 'alpha').mainCheckoutDirty).toBe(false);

    write(repo, 'page.html', 'local edit\n');
    expect(createAgentWorktree(repo, 'beta').mainCheckoutDirty).toBe(true);
  });

  it('resolves the main checkout from inside an agent checkout', () => {
    const worktree = createAgentWorktree(repo, 'alpha');
    expect(resolveMainCheckout(worktree.path)).toBe(repo);
    expect(findAgentWorktree(worktree.path, 'alpha')?.path).toBe(worktree.path);
  });

  it('rejects names that cannot be a branch and directories outside git', () => {
    expect(() => validateWorktreeAgentName('my agent')).toThrow(/can't be used with --worktree/);
    expect(() => validateWorktreeAgentName('a..b')).toThrow();
    expect(() => validateWorktreeAgentName('auth-fix_2.v1')).not.toThrow();
    const outside = fs.mkdtempSync(path.join(parent, 'plain-'));
    expect(() => createAgentWorktree(outside, 'alpha')).toThrow(/not inside a git repository/);
  });

  it('removeFreshWorktree deletes the checkout and its branch', () => {
    const worktree = createAgentWorktree(repo, 'alpha');
    removeFreshWorktree(worktree);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(git(['branch', '--list', 'relay/alpha'])).toBe('');
  });
});

describe('diffAgentWorktree', () => {
  it('shows committed, uncommitted and new-file work without staging anything for the agent', () => {
    const worktree = createAgentWorktree(repo, 'alpha');
    write(worktree.path, 'page.html', '<h1>Alpha</h1>\n<p>body</p>\n');
    git(['commit', '-qam', 'heading'], worktree.path);
    write(worktree.path, 'page.html', '<h1>Alpha</h1>\n<p>new body</p>\n');
    write(worktree.path, 'extra.txt', 'brand new\n');

    const diff = diffAgentWorktree(repo, 'alpha');

    expect(diff).toContain('+<h1>Alpha</h1>');
    expect(diff).toContain('+<p>new body</p>');
    expect(diff).toContain('+brand new');
    expect(git(['status', '--porcelain'], worktree.path)).toContain('?? extra.txt');
    expect(diffAgentWorktree(repo, 'alpha', { stat: true })).toMatch(/2 files changed/);
  });

  it('never includes relay state written into the agent checkout', () => {
    const worktree = createAgentWorktree(repo, 'alpha');
    fs.mkdirSync(path.join(worktree.path, '.agentworkforce'));
    write(path.join(worktree.path, '.agentworkforce'), 'workspace-key.json', '{"key":"secret"}');
    expect(diffAgentWorktree(repo, 'alpha')).toBe('');
  });

  it('explains when an agent has no worktree', () => {
    expect(() => diffAgentWorktree(repo, 'ghost')).toThrow(/has no worktree/);
  });
});

describe('mergeAgentWorktree', () => {
  it('commits pending agent work as the agent and merges it', () => {
    const worktree = createAgentWorktree(repo, 'alpha');
    write(worktree.path, 'page.html', '<h1>Alpha</h1>\n<p>body</p>\n');

    const result = mergeAgentWorktree(repo, 'alpha');

    expect(result).toMatchObject({ status: 'merged', committedPending: true, files: ['page.html'] });
    expect(read(repo, 'page.html')).toContain('Alpha');
    expect(git(['log', '-1', '--format=%an', 'relay/alpha']).trim()).toBe('alpha (relay agent)');
  });

  it('reports nothing to merge when the agent changed nothing', () => {
    createAgentWorktree(repo, 'alpha');
    expect(mergeAgentWorktree(repo, 'alpha').status).toBe('nothing-to-merge');
  });

  it('stops on a same-line clash, leaves the merge paused, and resumes it on re-run', () => {
    const alpha = createAgentWorktree(repo, 'alpha');
    const beta = createAgentWorktree(repo, 'beta');
    write(alpha.path, 'page.html', '<h1>Alpha</h1>\n<p>body</p>\n');
    write(beta.path, 'page.html', '<h1>Beta</h1>\n<p>body</p>\n');
    expect(mergeAgentWorktree(repo, 'alpha').status).toBe('merged');

    const conflict = mergeAgentWorktree(repo, 'beta');

    expect(conflict).toMatchObject({ status: 'conflict', conflicts: ['page.html'] });
    expect(read(repo, 'page.html')).toContain('<<<<<<<');
    expect(mergeAgentWorktree(repo, 'beta')).toMatchObject({ status: 'conflict', conflicts: ['page.html'] });
    expect(() => mergeAgentWorktree(repo, 'alpha')).toThrow(/middle of a merge/);
  });

  it('explains which local edits block a merge', () => {
    const worktree = createAgentWorktree(repo, 'alpha');
    write(worktree.path, 'page.html', '<h1>Alpha</h1>\n<p>body</p>\n');
    write(repo, 'page.html', 'my local edit\n');

    expect(() => mergeAgentWorktree(repo, 'alpha')).toThrow(
      /uncommitted changes to files it also changed:\n {2}page.html\n.*git stash/s
    );
  });
});

describe('cleanupAgentWorktree', () => {
  it('removes a fully merged checkout and keeps unmerged or uncommitted work', () => {
    const merged = createAgentWorktree(repo, 'merged');
    write(merged.path, 'a.txt', 'a\n');
    mergeAgentWorktree(repo, 'merged');
    expect(cleanupAgentWorktree(merged)).toEqual({ status: 'removed', path: merged.path });
    expect(fs.existsSync(merged.path)).toBe(false);

    const dirty = createAgentWorktree(repo, 'dirty');
    write(dirty.path, 'b.txt', 'b\n');
    expect(cleanupAgentWorktree(dirty)).toMatchObject({ status: 'kept', reason: 'uncommitted' });

    const unmerged = createAgentWorktree(repo, 'unmerged');
    write(unmerged.path, 'c.txt', 'c\n');
    git(['add', '-A'], unmerged.path);
    git(['commit', '-qm', 'c'], unmerged.path);
    expect(cleanupAgentWorktree(unmerged)).toMatchObject({ status: 'kept', reason: 'unmerged' });

    expect(cleanupAgentWorktree(unmerged, { discard: true }).status).toBe('removed');
    expect(git(['branch', '--list', 'relay/unmerged'])).toBe('');
  });
});
