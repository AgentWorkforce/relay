import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { promoteWorkspaceKeyEnvAlias } from './workspace-env.js';
import {
  persistWorkspaceSession,
  pinProjectWorkspaceSession,
  resolveWorkspaceSessionKey,
} from './workspace-session.js';
import {
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  writeProjectWorkspaceKey,
} from './project-workspace-key.js';
import { readWorkspaceStore, setWorkspaceKey, switchWorkspace } from './workspace-store.js';

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
  it('normalizes the first non-blank workspace-key environment alias', () => {
    const env = {
      RELAY_WORKSPACE_KEY: '   ',
      AGENT_RELAY_WORKSPACE_KEY: ' rk_live_alias ',
      RELAY_API_KEY: 'rk_live_legacy',
    };

    expect(promoteWorkspaceKeyEnvAlias(env)).toBe('rk_live_alias');
    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_alias');
  });

  it('preserves the canonical workspace-key environment precedence', () => {
    const env = {
      RELAY_WORKSPACE_KEY: ' rk_live_canonical ',
      AGENT_RELAY_WORKSPACE_KEY: 'rk_live_alias',
      RELAY_API_KEY: 'rk_live_legacy',
    };

    expect(promoteWorkspaceKeyEnvAlias(env)).toBe('rk_live_canonical');
    expect(env.RELAY_WORKSPACE_KEY).toBe(' rk_live_canonical ');
  });

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

  it('records the previous global workspace when a named session changes it', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    setWorkspaceKey('default', 'rk_live_default', env);

    persistWorkspaceSession({
      workspaceKey: 'rk_live_session_two',
      name: 'session-two',
      projectDataDir,
      env,
    });

    expect(readWorkspaceStore(env)).toMatchObject({ active: 'session-two', previous: 'default' });
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

  it("records a credential issuer's canonical workspace id in the project pin", () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);

    persistWorkspaceSession({
      workspaceKey: 'rk_live_redeemed',
      workspaceId: 'rw_redeemed',
      projectDataDir,
      env,
    });

    expect(readProjectWorkspaceSession(projectDataDir)).toEqual({
      workspaceKey: 'rk_live_redeemed',
      workspaceId: 'rw_redeemed',
    });
  });

  it('rejects a whitespace-only workspace name before persisting the project session', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);

    expect(() =>
      persistWorkspaceSession({
        workspaceKey: 'rk_live_shared',
        name: '   ',
        projectDataDir,
        env,
      })
    ).toThrow('Workspace name is required.');

    expect(readProjectWorkspaceKey(projectDataDir)).toBeUndefined();
    expect(readWorkspaceStore(env).workspaces).toEqual({});
  });

  it('preserves the enrolled Fleet node id when re-selecting the same workspace', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    writeProjectWorkspaceKey(projectDataDir, 'rk_live_enrolled', {
      enrolledNodeId: 'node_abc',
      workspaceId: 'rw_agent37',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
    });

    const result = persistWorkspaceSession({
      workspaceKey: 'rk_live_enrolled',
      name: 'enrolled',
      projectDataDir,
      env,
    });

    // Dropping the node id here is what manufactures the pin that makes
    // `node up` silently ignore the fleet enrollment store.
    expect(readProjectWorkspaceSession(projectDataDir)).toEqual({
      workspaceKey: 'rk_live_enrolled',
      enrolledNodeId: 'node_abc',
      workspaceId: 'rw_agent37',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
    });
    expect(result.clearedEnrolledNodeId).toBeUndefined();
  });

  it('persists a validated Relaycast route for later workspace selection', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);

    persistWorkspaceSession({
      workspaceKey: 'rk_live_agent37',
      workspaceId: 'rw_agent37',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      projectDataDir,
      env,
    });

    expect(readProjectWorkspaceSession(projectDataDir)).toEqual({
      workspaceKey: 'rk_live_agent37',
      workspaceId: 'rw_agent37',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
    });
  });

  it('uses the injected default credential home when AGENT_RELAY_HOME is omitted', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const defaultHome = path.join(root, 'default-home');
    const ambientHome = path.join(root, 'ambient-home');
    const originalHome = process.env.AGENT_RELAY_HOME;
    process.env.AGENT_RELAY_HOME = ambientHome;
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(defaultHome);
    const env = { ...process.env };
    delete env.AGENT_RELAY_HOME;

    try {
      persistWorkspaceSession({
        workspaceKey: 'rk_live_default_home',
        workspaceId: 'rw_default_home',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
        relaycastApiKey: 'rk_live_default_home_route',
        projectDataDir,
        env,
      });

      expect(readProjectWorkspaceSession(projectDataDir, undefined, env)).toMatchObject({
        relaycastApiKey: 'rk_live_default_home_route',
      });
      expect(
        readProjectWorkspaceSession(projectDataDir, undefined, { AGENT_RELAY_HOME: ambientHome })
      ).toMatchObject({
        workspaceKey: 'rk_live_default_home',
      });
      expect(
        readProjectWorkspaceSession(projectDataDir, undefined, { AGENT_RELAY_HOME: ambientHome })
          ?.relaycastApiKey
      ).toBeUndefined();
      expect(process.env.AGENT_RELAY_HOME).toBe(ambientHome);
    } finally {
      homeSpy.mockRestore();
      if (originalHome === undefined) delete process.env.AGENT_RELAY_HOME;
      else process.env.AGENT_RELAY_HOME = originalHome;
    }
  });

  it('replaces a stale route credential when re-persisting an explicit route', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    writeProjectWorkspaceKey(projectDataDir, 'rk_live_redeemed', {
      workspaceId: 'rw_redeemed',
      relaycastRoute: 'canonical',
      relaycastBaseUrl: 'https://cast.agentrelay.com',
      relaycastApiKey: 'rk_live_stale_canonical',
      env,
    });

    persistWorkspaceSession({
      workspaceKey: 'rk_live_redeemed',
      workspaceId: 'rw_redeemed',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_redeemed',
      projectDataDir,
      env,
    });

    expect(readProjectWorkspaceSession(projectDataDir, undefined, env)).toMatchObject({
      workspaceKey: 'rk_live_redeemed',
      workspaceId: 'rw_redeemed',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_redeemed',
      relaycastApiKeyRef: expect.any(String),
    });
  });

  it('clears the enrolled Fleet node id when moving to a different workspace', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    writeProjectWorkspaceKey(projectDataDir, 'rk_live_enrolled', { enrolledNodeId: 'node_abc' });

    const result = persistWorkspaceSession({
      workspaceKey: 'rk_live_other',
      name: 'other',
      projectDataDir,
      env,
    });

    // Carrying the id across would run the broker in the old workspace while
    // every other command in this project reads the new key — the split this
    // change exists to remove.
    expect(readProjectWorkspaceSession(projectDataDir)).toEqual({ workspaceKey: 'rk_live_other' });
    expect(result.clearedEnrolledNodeId).toBe('node_abc');
  });

  it('does not invent an enrolled node id for a project that never had one', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);

    persistWorkspaceSession({ workspaceKey: 'rk_live_fresh', projectDataDir, env });

    expect(readProjectWorkspaceSession(projectDataDir)).toEqual({ workspaceKey: 'rk_live_fresh' });
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

  it('rebinds the project without changing the machine-global active workspace and clears the old enrollment', () => {
    const root = tempRoot();
    const projectDataDir = path.join(root, 'project', '.agentworkforce', 'relay');
    const env = isolatedEnv(root);
    setWorkspaceKey('default', 'rk_live_default', env);
    setWorkspaceKey('scratch', 'rk_live_scratch', env);
    switchWorkspace('scratch', env);
    writeProjectWorkspaceKey(projectDataDir, 'rk_live_old', {
      enrolledNodeId: 'node_old',
      workspaceId: 'rw_old',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
    });

    pinProjectWorkspaceSession({ workspaceKey: 'rk_live_default', projectDataDir, env });

    expect(readProjectWorkspaceKey(projectDataDir)).toBe('rk_live_default');
    expect(readWorkspaceStore(env).active).toBe('scratch');
    expect(resolveWorkspaceSessionKey({ projectDataDir, env })).toBe('rk_live_default');
    expect(readProjectWorkspaceSession(projectDataDir)).toEqual({ workspaceKey: 'rk_live_default' });
  });
});
