import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNotRelayHome,
  ensureGitExclude,
  findProjectRoot,
  isRelayHomeDir,
  RelayHomeProjectError,
} from './project-namespace.js';

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

describe('the relay home is never a project', () => {
  const relay = (dir: string) => path.join(dir, '.agentworkforce', 'relay');

  it('skips the relay home as a marker, so a plain folder under ~ is its own project', () => {
    const home = path.join(root, 'home');
    const notes = path.join(home, 'notes');
    fs.mkdirSync(relay(home), { recursive: true });
    fs.mkdirSync(notes);
    vi.stubEnv('AGENT_RELAY_HOME', relay(home));
    // A project pin the old behaviour wrote into the relay home is no namespace either.
    fs.writeFileSync(path.join(relay(home), 'workspace-key.json'), '{}');
    expect(findProjectRoot(notes)).toBe(notes);
    expect(findProjectRoot(home)).toBe(home);
    // An ordinary project's own data folder still marks it.
    fs.mkdirSync(relay(notes), { recursive: true });
    expect(findProjectRoot(path.join(notes))).toBe(notes);
  });

  it('treats any folder holding workspaces.json as a relay home, as under an isolated HOME', () => {
    const realHome = path.join(root, 'real-home');
    const project = path.join(realHome, 'work', 'proj');
    fs.mkdirSync(relay(realHome), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(relay(realHome), 'workspaces.json'), '{}');
    vi.stubEnv('AGENT_RELAY_HOME', path.join(root, 'isolated', '.agentworkforce', 'relay'));
    expect(isRelayHomeDir(relay(realHome))).toBe(true);
    expect(findProjectRoot(project)).toBe(project);
  });

  it('compares canonical paths: a symlink to the relay home, and one not created yet', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const link = path.join(root, 'link');
    fs.symlinkSync(home, link);
    vi.stubEnv('AGENT_RELAY_HOME', relay(home));
    // Neither exists yet: compared by where they would be.
    expect(isRelayHomeDir(relay(link))).toBe(true);
    fs.mkdirSync(relay(home), { recursive: true });
    expect(isRelayHomeDir(relay(link))).toBe(true);
    vi.stubEnv('AGENT_RELAY_HOME', relay(link));
    expect(isRelayHomeDir(relay(home))).toBe(true);
    expect(isRelayHomeDir(relay(path.join(root, 'project')))).toBe(false);
  });

  it('refuses with an error that says to run inside a project folder', () => {
    vi.stubEnv('AGENT_RELAY_HOME', relay(root));
    expect(() => assertNotRelayHome(relay(root))).toThrow(RelayHomeProjectError);
    expect(() => assertNotRelayHome(relay(root))).toThrow(/inside a project folder/);
    expect(() => assertNotRelayHome(relay(path.join(root, 'project')))).not.toThrow();
  });
});

describe('ensureGitExclude', () => {
  const dataDir = () => path.join(root, '.agentworkforce', 'relay');
  const exclude = (gitDir = path.join(root, '.git')) =>
    fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8');

  it('adds the data directory, anchored, to info/exclude once', () => {
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.git', 'info', 'exclude'),
      '# git ls-files --others --exclude-from=.git/info/exclude'
    );
    expect(ensureGitExclude(dataDir())).toEqual({ modified: true });
    expect(ensureGitExclude(dataDir())).toEqual({ modified: false });
    expect(exclude()).toBe(
      '# git ls-files --others --exclude-from=.git/info/exclude\n/.agentworkforce/relay/\n'
    );
  });

  it('creates info/exclude and anchors a project below the repository root', () => {
    fs.mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'apps', 'web', '.agentworkforce', 'relay');
    expect(ensureGitExclude(nested)).toEqual({ modified: true });
    expect(exclude()).toBe('/apps/web/.agentworkforce/relay/\n');
  });

  it('accepts the unanchored entry older versions wrote', () => {
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '.agentworkforce/relay/\n');
    expect(ensureGitExclude(dataDir())).toEqual({ modified: false });
  });

  it('writes the shared exclude of a linked worktree', () => {
    const common = path.join(root, 'main', '.git');
    const worktreeGitDir = path.join(common, 'worktrees', 'feature');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    const worktree = path.join(root, 'feature');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    expect(ensureGitExclude(path.join(worktree, '.agentworkforce', 'relay'))).toEqual({ modified: true });
    expect(exclude(common)).toBe('/.agentworkforce/relay/\n');
  });

  it('writes the exclude of a submodule whose .git file has a relative gitdir', () => {
    const gitDir = path.join(root, 'super', '.git', 'modules', 'sub');
    fs.mkdirSync(gitDir, { recursive: true });
    const sub = path.join(root, 'super', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(ensureGitExclude(path.join(sub, '.agentworkforce', 'relay'))).toEqual({ modified: true });
    expect(exclude(gitDir)).toBe('/.agentworkforce/relay/\n');
  });

  it('writes nothing for a .git file whose gitdir no longer exists', () => {
    const missing = path.join(root, 'gone', '.git', 'worktrees', 'feature');
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${missing}\n`);
    expect(ensureGitExclude(dataDir())).toEqual({ modified: false });
    expect(fs.existsSync(path.join(root, 'gone'))).toBe(false);
  });

  it('does nothing outside a git repository', () => {
    expect(ensureGitExclude(dataDir())).toEqual({ modified: false });
  });
});
