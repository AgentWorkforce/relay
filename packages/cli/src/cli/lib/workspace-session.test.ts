import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { persistWorkspaceSession, resolveWorkspaceSessionKey } from './workspace-session.js';
import { readProjectWorkspaceKey } from './project-workspace-key.js';
import { readWorkspaceStore, setWorkspaceKey } from './workspace-store.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-session-'));
  tempRoots.push(root);
  return root;
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env, AGENT_RELAY_HOME: path.join(root, 'home') };
  delete env.RELAY_WORKSPACE_KEY;
  delete env.AGENT_RELAY_WORKSPACE_KEY;
  delete env.RELAY_API_KEY;
  return env;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace session persistence', () => {
  it('pins a named workspace to the project and makes it globally active', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);

    persistWorkspaceSession({
      workspaceKey: 'rk_live_session_two',
      name: 'session-two',
      projectDataDir,
      env,
    });

    expect(readProjectWorkspaceKey(projectDataDir)).toBe('rk_live_session_two');
    expect(readWorkspaceStore(env)).toEqual({
      active: 'session-two',
      workspaces: {
        'session-two': { key: 'rk_live_session_two' },
      },
    });
  });

  it('pins an explicitly supplied key without changing the named global workspace', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    setWorkspaceKey('default', 'rk_live_default', env);

    persistWorkspaceSession({
      workspaceKey: 'rk_live_shared',
      projectDataDir,
      env,
    });

    expect(readProjectWorkspaceKey(projectDataDir)).toBe('rk_live_shared');
    expect(readWorkspaceStore(env).active).toBe('default');
  });

  it('resumes the project workspace ahead of the machine-global active workspace', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    setWorkspaceKey('default', 'rk_live_default', env);
    persistWorkspaceSession({
      workspaceKey: 'rk_live_project',
      projectDataDir,
      env,
    });

    expect(resolveWorkspaceSessionKey({ projectDataDir, env })).toBe('rk_live_project');
  });
});
