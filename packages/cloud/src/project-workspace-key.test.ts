import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  resolveWorkspaceKeyWithSource,
  resolveWorkspaceSelection,
  writeProjectWorkspaceTargetIfSelectionCurrent,
  writeProjectWorkspaceKeyPreservingSession,
  writeProjectWorkspaceKey,
} from './project-workspace-key.js';
import { setWorkspaceKey } from './workspace-store.js';

let root: string;
let dataDir: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-workspace-'));
  dataDir = path.join(root, '.agentworkforce/relay');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-workspace-home-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('project workspace key resolution', () => {
  it('round-trips an atomic owner-only project key record', () => {
    writeProjectWorkspaceKey(dataDir, '  rk_project  ');
    expect(readProjectWorkspaceKey(dataDir)).toBe('rk_project');
    expect(fs.statSync(projectWorkspaceKeyPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('uses an explicit credential home without mutating process.env or the project file', () => {
    const credentialHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-credential-home-'));
    const processHome = process.env.AGENT_RELAY_HOME;
    try {
      writeProjectWorkspaceKey(dataDir, 'rk_canonical', {
        workspaceId: 'rw_abc',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
        relaycastApiKey: 'rk_live_temporary',
        env: { AGENT_RELAY_HOME: credentialHome },
      });

      expect(process.env.AGENT_RELAY_HOME).toBe(processHome);
      expect(readProjectWorkspaceSession(dataDir, fs, { AGENT_RELAY_HOME: credentialHome })).toMatchObject({
        workspaceKey: 'rk_canonical',
        relaycastApiKey: 'rk_live_temporary',
      });
      expect(
        readProjectWorkspaceSession(dataDir, fs, { AGENT_RELAY_HOME: `${credentialHome}-other` })
          ?.relaycastApiKey
      ).toBeUndefined();
      expect(fs.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf8')).not.toContain('rk_live_temporary');
    } finally {
      fs.rmSync(credentialHome, { recursive: true, force: true });
    }
  });

  it('preserves a route credential through metadata updates in the selected credential home', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_temporary',
      env: { AGENT_RELAY_HOME: home },
    });

    writeProjectWorkspaceKeyPreservingSession(dataDir, 'rk_canonical', {
      enrolledNodeId: 'node_1',
      env: { AGENT_RELAY_HOME: home },
    });

    expect(readProjectWorkspaceSession(dataDir, fs, { AGENT_RELAY_HOME: home })).toMatchObject({
      workspaceKey: 'rk_canonical',
      enrolledNodeId: 'node_1',
      relaycastApiKey: 'rk_live_temporary',
    });
    expect(fs.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf8')).not.toContain('rk_live_temporary');
  });

  it('keeps a temporary Relaycast key out of the project file', () => {
    const previousHome = process.env.AGENT_RELAY_HOME;
    process.env.AGENT_RELAY_HOME = home;
    try {
      writeProjectWorkspaceKey(dataDir, 'rk_canonical', { workspaceId: 'rw_abc' });
      const selection = resolveWorkspaceSelection({
        projectDataDir: dataDir,
        env: { AGENT_RELAY_HOME: home },
      });
      expect(
        writeProjectWorkspaceTargetIfSelectionCurrent(dataDir, selection!, {
          workspaceId: 'rw_abc',
          relaycastRoute: 'agent37-isolated',
          relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
          relaycastApiKey: 'rk_live_temporary',
        })
      ).toBe(true);
      const raw = fs.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf8');
      expect(raw).not.toContain('rk_live_temporary');
      expect(readProjectWorkspaceSession(dataDir)?.relaycastApiKey).toBe('rk_live_temporary');
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_RELAY_HOME;
      else process.env.AGENT_RELAY_HOME = previousHome;
    }
  });

  it('fails closed when a project reference is paired with another route scope', () => {
    const previousHome = process.env.AGENT_RELAY_HOME;
    process.env.AGENT_RELAY_HOME = home;
    try {
      writeProjectWorkspaceKey(dataDir, 'rk_canonical', { workspaceId: 'rw_abc' });
      const selection = resolveWorkspaceSelection({
        projectDataDir: dataDir,
        env: { AGENT_RELAY_HOME: home },
      });
      expect(
        writeProjectWorkspaceTargetIfSelectionCurrent(dataDir, selection!, {
          workspaceId: 'rw_abc',
          relaycastRoute: 'agent37-isolated',
          relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
          relaycastApiKey: 'rk_live_temporary',
        })
      ).toBe(true);
      const file = projectWorkspaceKeyPath(dataDir);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      parsed.relaycastApiKeyRef = 'wrong-scope';
      fs.writeFileSync(file, `${JSON.stringify(parsed)}\n`);
      expect(readProjectWorkspaceSession(dataDir)?.relaycastApiKey).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_RELAY_HOME;
      else process.env.AGENT_RELAY_HOME = previousHome;
    }
  });

  it('rotates a bound route credential without retaining the old key in project metadata', () => {
    const previousHome = process.env.AGENT_RELAY_HOME;
    process.env.AGENT_RELAY_HOME = home;
    try {
      const target = {
        workspaceId: 'rw_abc',
        relaycastRoute: 'agent37-isolated' as const,
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      };
      writeProjectWorkspaceKey(dataDir, 'rk_canonical', {
        ...target,
        relaycastApiKey: 'rk_live_old',
      });
      writeProjectWorkspaceKey(dataDir, 'rk_canonical', {
        ...target,
        relaycastApiKey: 'rk_live_new',
      });
      const raw = fs.readFileSync(projectWorkspaceKeyPath(dataDir), 'utf8');
      expect(raw).not.toContain('rk_live_old');
      expect(raw).not.toContain('rk_live_new');
      expect(readProjectWorkspaceSession(dataDir)?.relaycastApiKey).toBe('rk_live_new');
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_RELAY_HOME;
      else process.env.AGENT_RELAY_HOME = previousHome;
    }
  });

  it('does not remove a replacement lock when the original holder finishes', () => {
    const lockDir = `${projectWorkspaceKeyPath(dataDir)}.lock`;
    let replaced = false;
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      originalRename(source, destination);
      if (!replaced && destination === projectWorkspaceKeyPath(dataDir)) {
        replaced = true;
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir, { mode: 0o700 });
        fs.writeFileSync(path.join(lockDir, 'replacement-owner'), '', { mode: 0o600, flag: 'wx' });
      }
    });

    try {
      writeProjectWorkspaceKey(dataDir, 'rk_project');
    } finally {
      rename.mockRestore();
    }

    expect(fs.existsSync(path.join(lockDir, 'replacement-owner'))).toBe(true);
  });

  it('does not reclaim a stale lock whose recorded owner is still alive', () => {
    const lockDir = `${projectWorkspaceKeyPath(dataDir)}.lock`;
    const token = 'live-owner-token';
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, token), JSON.stringify({ version: 1, pid: process.pid, token }), {
      mode: 0o600,
      flag: 'wx',
    });
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, staleAt, staleAt);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      expect(() => writeProjectWorkspaceKey(dataDir, 'rk_project')).toThrow(/Timed out waiting/);
      expect(fs.existsSync(path.join(lockDir, token))).toBe(true);
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
    } finally {
      kill.mockRestore();
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it('preserves a callback error when lock cleanup also fails', () => {
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      originalRename(source, destination);
      throw new Error('callback failed');
    });
    const rmdir = vi.spyOn(fs, 'rmdirSync').mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => writeProjectWorkspaceKey(dataDir, 'rk_project')).toThrow('callback failed');
      expect(report).toHaveBeenCalledWith(expect.stringContaining('Failed to release'), expect.any(Error));
    } finally {
      rename.mockRestore();
      rmdir.mockRestore();
      report.mockRestore();
    }
  });

  it('round-trips an enrolled Fleet identity and clears it on an explicit workspace change', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_enrolled', { enrolledNodeId: ' node_1 ' });
    expect(readProjectWorkspaceSession(dataDir)).toEqual({
      workspaceKey: 'rk_enrolled',
      enrolledNodeId: 'node_1',
    });

    writeProjectWorkspaceKey(dataDir, 'rk_switched');
    expect(readProjectWorkspaceSession(dataDir)).toEqual({ workspaceKey: 'rk_switched' });
  });

  it('prefers explicit and environment keys over the project broker key', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_project');
    expect(
      resolveWorkspaceKeyWithSource({
        workspaceKey: ' rk_flag ',
        projectDataDir: dataDir,
        env: { AGENT_RELAY_HOME: home },
      })
    ).toEqual({ key: 'rk_flag', source: 'flag' });
    expect(
      resolveWorkspaceKeyWithSource({
        projectDataDir: dataDir,
        env: { AGENT_RELAY_HOME: home, AGENT_RELAY_WORKSPACE_KEY: ' rk_env ' },
      })
    ).toEqual({ key: 'rk_env', source: 'env' });
  });

  it('prefers the current project broker over an unrelated global active workspace', () => {
    const env = { AGENT_RELAY_HOME: home };
    setWorkspaceKey('global', 'rk_global', env);
    writeProjectWorkspaceKey(dataDir, 'rk_project');

    expect(resolveWorkspaceKeyWithSource({ projectDataDir: dataDir, env })).toEqual({
      key: 'rk_project',
      source: 'project',
    });
  });

  it('falls back through malformed project state to the global store', () => {
    const env = { AGENT_RELAY_HOME: home };
    setWorkspaceKey('global', 'rk_global', env);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(projectWorkspaceKeyPath(dataDir), 'not json');

    expect(resolveWorkspaceKeyWithSource({ projectDataDir: dataDir, env })).toEqual({
      key: 'rk_global',
      source: 'store',
    });
  });

  it('fails closed on a malformed Git project marker instead of falling back globally', () => {
    const env = { AGENT_RELAY_HOME: home };
    const malformedProject = path.join(root, 'malformed-git-project');
    fs.mkdirSync(malformedProject, { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-git-metadata'), path.join(malformedProject, '.git'));
    setWorkspaceKey('global', 'rk_global', env);

    const previousCwd = process.cwd();
    const previousProject = process.env.AGENT_RELAY_PROJECT;
    delete process.env.AGENT_RELAY_PROJECT;
    process.chdir(malformedProject);
    try {
      expect(() => resolveWorkspaceSelection({ env })).toThrow('Cannot resolve the repository workspace');
    } finally {
      process.chdir(previousCwd);
      if (previousProject === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = previousProject;
    }
  });

  it('records the absent project session snapshot for an active-store selection', () => {
    const env = { AGENT_RELAY_HOME: home };
    setWorkspaceKey('global', 'rk_global', env);

    expect(resolveWorkspaceSelection({ projectDataDir: dataDir, env })).toMatchObject({
      key: 'rk_global',
      source: 'store',
      projectDataDir: dataDir,
      projectSessionPresent: false,
    });
  });

  it('returns undefined when no workspace source exists', () => {
    expect(
      resolveWorkspaceKeyWithSource({ projectDataDir: dataDir, env: { AGENT_RELAY_HOME: home } })
    ).toBeUndefined();
  });
});

describe('workspace precedence ladder diagnostics', () => {
  it('round-trips the resolved workspace id on the project pin', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_project', { workspaceId: ' rw_pinned ' });
    expect(readProjectWorkspaceSession(dataDir)).toEqual({
      workspaceKey: 'rk_project',
      workspaceId: 'rw_pinned',
    });
    expect(
      resolveWorkspaceSelection({ projectDataDir: dataDir, env: { AGENT_RELAY_HOME: home } })?.workspaceId
    ).toBe('rw_pinned');
  });

  it('carries a persisted Relaycast target when an explicit key matches the project pin', () => {
    const previousHome = process.env.AGENT_RELAY_HOME;
    process.env.AGENT_RELAY_HOME = home;
    try {
      writeProjectWorkspaceKey(dataDir, 'rk_canonical', {
        workspaceId: 'rw_pinned',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
        relaycastApiKey: 'rk_agent37',
      });

      expect(
        resolveWorkspaceSelection({
          workspaceKey: 'rk_canonical',
          projectDataDir: dataDir,
          env: { AGENT_RELAY_HOME: home },
        })
      ).toMatchObject({
        key: 'rk_canonical',
        source: 'flag',
        workspaceId: 'rw_pinned',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
        relaycastApiKey: 'rk_agent37',
        relaycastApiKeyRef: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_RELAY_HOME;
      else process.env.AGENT_RELAY_HOME = previousHome;
    }
  });

  it.each(['flag', 'env'] as const)(
    'exposes the empty project directory for a fresh %s selection',
    (source) => {
      const selection = resolveWorkspaceSelection({
        ...(source === 'flag' ? { workspaceKey: 'rk_fresh' } : {}),
        projectDataDir: dataDir,
        env: {
          AGENT_RELAY_HOME: home,
          ...(source === 'env' ? { RELAY_WORKSPACE_KEY: 'rk_fresh' } : {}),
        },
      });

      expect(selection).toMatchObject({ key: 'rk_fresh', source, projectDataDir: dataDir });
    }
  );

  it('does not expose a project directory when an explicit selection conflicts with its pin', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_project');

    expect(
      resolveWorkspaceSelection({
        workspaceKey: 'rk_other',
        projectDataDir: dataDir,
        env: { AGENT_RELAY_HOME: home },
      })
    ).not.toHaveProperty('projectDataDir');
  });

  it('names each source without leaking key material', () => {
    const env = { AGENT_RELAY_HOME: home, AGENT_RELAY_WORKSPACE_KEY: 'rk_env' };
    setWorkspaceKey('global', 'rk_global', env);
    writeProjectWorkspaceKey(dataDir, 'rk_project');

    const flag = resolveWorkspaceSelection({ workspaceKey: 'rk_flag', projectDataDir: dataDir, env });
    expect(flag).toMatchObject({ key: 'rk_flag', source: 'flag', origin: '--workspace-key' });

    const fromEnv = resolveWorkspaceSelection({ projectDataDir: dataDir, env });
    expect(fromEnv).toMatchObject({ source: 'env', origin: '$AGENT_RELAY_WORKSPACE_KEY' });

    const project = resolveWorkspaceSelection({
      projectDataDir: dataDir,
      env: { AGENT_RELAY_HOME: home },
    });
    expect(project).toMatchObject({ source: 'project', origin: projectWorkspaceKeyPath(dataDir) });

    fs.rmSync(projectWorkspaceKeyPath(dataDir));
    const store = resolveWorkspaceSelection({ projectDataDir: dataDir, env: { AGENT_RELAY_HOME: home } });
    expect(store).toMatchObject({ key: 'rk_global', source: 'store' });
    expect(store?.origin).toContain('workspaces.json');
    expect(store?.origin).toContain('active: "global"');

    for (const selection of [flag, fromEnv, project, store]) {
      expect(selection?.origin).not.toContain(selection?.key ?? '<none>');
    }
  });

  it('keeps the repository pin ahead of the machine-global active entry (#1406)', () => {
    const env = { AGENT_RELAY_HOME: home };
    setWorkspaceKey('stale-global', 'rk_stale_global', env);
    writeProjectWorkspaceKey(dataDir, 'rk_repository', { workspaceId: 'rw_repository' });

    expect(resolveWorkspaceSelection({ projectDataDir: dataDir, env })).toMatchObject({
      key: 'rk_repository',
      source: 'project',
      workspaceId: 'rw_repository',
    });
  });

  it('keeps the shared ladder authoritative when a caller injects repository-pin I/O', () => {
    const env = { AGENT_RELAY_HOME: home };
    setWorkspaceKey('global', 'rk_global', env);
    const fileSystem = {
      readFileSync: (filePath: string, encoding: BufferEncoding): string => {
        expect(filePath).toBe(projectWorkspaceKeyPath(dataDir));
        expect(encoding).toBe('utf-8');
        return JSON.stringify({ workspaceKey: 'rk_injected', workspaceId: 'rw_injected' });
      },
    };

    expect(resolveWorkspaceSelection({ projectDataDir: dataDir, env, fileSystem })).toMatchObject({
      key: 'rk_injected',
      source: 'project',
      workspaceId: 'rw_injected',
    });
  });
});
