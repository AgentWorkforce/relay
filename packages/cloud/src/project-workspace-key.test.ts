import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  resolveWorkspaceKeyWithSource,
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

  it('returns undefined when no workspace source exists', () => {
    expect(
      resolveWorkspaceKeyWithSource({ projectDataDir: dataDir, env: { AGENT_RELAY_HOME: home } })
    ).toBeUndefined();
  });
});
