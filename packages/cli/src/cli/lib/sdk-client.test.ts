import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgentRelay,
  persistWorkspaceRelaycastTarget,
  resolveAgentToken,
  resolveBaseUrl,
  resolveWorkspaceKey,
  resolveWorkspaceKeyWithSource,
  resolveWorkspaceSelection,
  resolveWorkspaceTransport,
} from './sdk-client.js';
import { setWorkspaceKey } from './workspace-store.js';
import { readProjectWorkspaceSession, writeProjectWorkspaceKey } from './project-workspace-key.js';

let dir: string;
let projectRoot: string;
const original = process.env.AGENT_RELAY_HOME;
const originalProject = process.env.AGENT_RELAY_PROJECT;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-client-'));
  process.env.AGENT_RELAY_HOME = dir;
  // Isolate the project root (and thus the project data dir that
  // `resolveWorkspaceKey` reads the CWD broker key from) to a temp dir.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-project-'));
  process.env.AGENT_RELAY_PROJECT = projectRoot;
});

afterEach(() => {
  if (original === undefined) delete process.env.AGENT_RELAY_HOME;
  else process.env.AGENT_RELAY_HOME = original;
  if (originalProject === undefined) delete process.env.AGENT_RELAY_PROJECT;
  else process.env.AGENT_RELAY_PROJECT = originalProject;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** The project data dir `getProjectPaths()` resolves for the isolated root. */
function projectDataDir(): string {
  return path.join(projectRoot, '.agentworkforce/relay');
}

describe('sdk client option resolution', () => {
  it('falls through blank workspace-key candidates and trims the chosen key', () => {
    setWorkspaceKey('ops', ' rk_store ');

    expect(
      resolveWorkspaceKey({
        workspaceKey: '   ',
        env: { RELAY_WORKSPACE_KEY: '', RELAY_API_KEY: '   ', AGENT_RELAY_HOME: dir },
      })
    ).toBe('rk_store');
  });

  it('uses the CWD broker workspace key over the machine-global active workspace', () => {
    setWorkspaceKey('ops', 'rk_global');
    writeProjectWorkspaceKey(projectDataDir(), 'rk_project_broker');

    // No explicit flag/env key → the project broker's key wins over the global store.
    expect(resolveWorkspaceKey({ env: { AGENT_RELAY_HOME: dir } })).toBe('rk_project_broker');
  });

  it('lets an explicit flag and env override the CWD broker workspace key', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_project_broker');

    expect(resolveWorkspaceKey({ workspaceKey: 'rk_flag', env: { AGENT_RELAY_HOME: dir } })).toBe('rk_flag');
    expect(resolveWorkspaceKey({ env: { RELAY_WORKSPACE_KEY: 'rk_env', AGENT_RELAY_HOME: dir } })).toBe(
      'rk_env'
    );
  });

  it('falls back to the global active workspace when no CWD broker key is recorded', () => {
    setWorkspaceKey('ops', 'rk_global');
    expect(resolveWorkspaceKey({ env: { AGENT_RELAY_HOME: dir } })).toBe('rk_global');
  });

  it('reports the source each workspace key was resolved from', () => {
    setWorkspaceKey('ops', 'rk_global');
    writeProjectWorkspaceKey(projectDataDir(), 'rk_project_broker');

    expect(
      resolveWorkspaceKeyWithSource({ workspaceKey: 'rk_flag', env: { AGENT_RELAY_HOME: dir } })
    ).toEqual({ key: 'rk_flag', source: 'flag' });
    expect(
      resolveWorkspaceKeyWithSource({ env: { RELAY_WORKSPACE_KEY: 'rk_env', AGENT_RELAY_HOME: dir } })
    ).toEqual({ key: 'rk_env', source: 'env' });
    // No flag/env → the CWD broker key, reported as 'project'.
    expect(resolveWorkspaceKeyWithSource({ env: { AGENT_RELAY_HOME: dir } })).toEqual({
      key: 'rk_project_broker',
      source: 'project',
    });
  });

  it('reports the global store as the source when no CWD broker key exists', () => {
    setWorkspaceKey('ops', 'rk_global');
    expect(resolveWorkspaceKeyWithSource({ env: { AGENT_RELAY_HOME: dir } })).toEqual({
      key: 'rk_global',
      source: 'store',
    });
  });

  it('trims optional base URL and agent token values', () => {
    expect(resolveBaseUrl({ baseUrl: '  https://relay.example  ' })).toBe('https://relay.example');
    expect(resolveAgentToken({ token: '  at_123  ' })).toBe('at_123');
    expect(resolveAgentToken({ token: '   ', env: { RELAY_AGENT_TOKEN: '  at_env  ' } })).toBe('at_env');
  });

  it('uses an agent token as the transport credential instead of an ambient owner workspace key', () => {
    setWorkspaceKey('ops', 'rk_live_owner_secret');
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_project_owner_secret');

    const relay = createAgentRelay({
      env: {
        AGENT_RELAY_HOME: dir,
        RELAY_AGENT_TOKEN: 'at_live_participant_scoped',
      },
    }) as { workspaceKey?: string; toJSON(): unknown };

    expect(relay.workspaceKey).toBeUndefined();
    expect(JSON.stringify(relay)).not.toContain('rk_live_owner_secret');
    expect(JSON.stringify(relay)).not.toContain('rk_live_project_owner_secret');
    expect(JSON.stringify(relay)).not.toContain('at_live_participant_scoped');
  });

  it('does not inherit a persisted gateway when an explicit agent token is supplied', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_agent37',
    });

    const relay = createAgentRelay({ token: 'at_live_explicit' }) as unknown as {
      messagingOptions: { baseUrl?: string };
      workspaceKey?: string;
    };
    expect(relay.messagingOptions.baseUrl).toBeUndefined();
    expect(relay.workspaceKey).toBeUndefined();

    const canonicalRelay = createAgentRelay({
      token: 'at_live_explicit',
      baseUrl: 'https://cast.agentrelay.com',
    }) as unknown as { messagingOptions: { baseUrl?: string } };
    expect(canonicalRelay.messagingOptions.baseUrl).toBe('https://cast.agentrelay.com');
  });

  it('does not inherit a persisted gateway when an environment agent token is supplied', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_agent37',
    });

    const relay = createAgentRelay({
      env: { RELAY_AGENT_TOKEN: 'at_live_environment' },
    }) as unknown as {
      messagingOptions: { baseUrl?: string };
      workspaceKey?: string;
    };
    expect(relay.messagingOptions.baseUrl).toBeUndefined();
    expect(relay.workspaceKey).toBeUndefined();
  });

  it('durably records an isolated target while preserving the enrolled node session', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      enrolledNodeId: 'node_1',
    });
    const selection = resolveWorkspaceSelection({ env: { AGENT_RELAY_HOME: dir } });
    expect(
      persistWorkspaceRelaycastTarget(selection, {
        route: 'agent37-isolated',
        baseUrl: 'https://agent37-cast.agentrelay.com',
        workspaceId: 'rw_abc',
        relaycastApiKey: 'rk_live_agent37',
      })
    ).toBe(true);
    expect(readProjectWorkspaceSession(projectDataDir())).toEqual({
      workspaceKey: 'rk_live_canonical',
      workspaceId: 'rw_abc',
      enrolledNodeId: 'node_1',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_agent37',
    });

    const replayOptions = {
      workspaceKey: 'rk_live_canonical',
      env: { AGENT_RELAY_HOME: dir },
    };
    expect(resolveWorkspaceSelection(replayOptions)).toMatchObject({
      key: 'rk_live_canonical',
      source: 'flag',
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_agent37',
    });
    expect(resolveWorkspaceKey(replayOptions)).toBe('rk_live_agent37');
    expect(resolveBaseUrl(replayOptions)).toBe('https://agent37-cast.agentrelay.com');
  });

  it.each(['flag', 'env'] as const)(
    'creates a fresh project target pin for an unpinned %s selection',
    (source) => {
      const selection = resolveWorkspaceSelection({
        ...(source === 'flag' ? { workspaceKey: 'rk_live_fresh' } : {}),
        env: {
          AGENT_RELAY_HOME: dir,
          ...(source === 'env' ? { RELAY_WORKSPACE_KEY: 'rk_live_fresh' } : {}),
        },
      });
      expect(selection).toMatchObject({
        key: 'rk_live_fresh',
        source,
        projectDataDir: projectDataDir(),
      });

      expect(
        persistWorkspaceRelaycastTarget(selection, {
          route: 'agent37-isolated',
          baseUrl: 'https://agent37-cast.agentrelay.com',
          workspaceId: 'rw_fresh',
          relaycastApiKey: 'rk_live_fresh_agent37',
        })
      ).toBe(true);
      expect(readProjectWorkspaceSession(projectDataDir())).toEqual({
        workspaceKey: 'rk_live_fresh',
        workspaceId: 'rw_fresh',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
        relaycastApiKey: 'rk_live_fresh_agent37',
      });
    }
  );

  it('creates a fresh project target pin for an active machine-store selection', () => {
    setWorkspaceKey('ops', 'rk_live_store', { AGENT_RELAY_HOME: dir });
    const selection = resolveWorkspaceSelection({ env: { AGENT_RELAY_HOME: dir } });
    expect(selection).toMatchObject({
      key: 'rk_live_store',
      source: 'store',
      projectDataDir: projectDataDir(),
      projectSessionPresent: false,
    });

    expect(
      persistWorkspaceRelaycastTarget(selection, {
        route: 'agent37-isolated',
        baseUrl: 'https://agent37-cast.agentrelay.com',
        workspaceId: 'rw_store',
        relaycastApiKey: 'rk_live_store_agent37',
      })
    ).toBe(true);
    expect(readProjectWorkspaceSession(projectDataDir())).toEqual({
      workspaceKey: 'rk_live_store',
      workspaceId: 'rw_store',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_store_agent37',
    });
  });

  it('refuses to overwrite a project session rebound after workspace selection', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_original', { workspaceId: 'rw_original' });
    const selection = resolveWorkspaceSelection({ env: { AGENT_RELAY_HOME: dir } });
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_rebound', {
      workspaceId: 'rw_rebound',
      enrolledNodeId: 'node_rebound',
    });

    expect(
      persistWorkspaceRelaycastTarget(selection, {
        route: 'agent37-isolated',
        baseUrl: 'https://agent37-cast.agentrelay.com',
        workspaceId: 'rw_original',
        relaycastApiKey: 'rk_live_original_agent37',
      })
    ).toBe(false);
    expect(readProjectWorkspaceSession(projectDataDir())).toEqual({
      workspaceKey: 'rk_live_rebound',
      workspaceId: 'rw_rebound',
      enrolledNodeId: 'node_rebound',
    });
  });

  it('does not replace a project pin created while a fresh explicit selection is in flight', () => {
    const selection = resolveWorkspaceSelection({
      workspaceKey: 'rk_live_fresh',
      env: { AGENT_RELAY_HOME: dir },
    });
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_concurrent', {
      workspaceId: 'rw_concurrent',
      enrolledNodeId: 'node_concurrent',
    });

    expect(
      persistWorkspaceRelaycastTarget(selection, {
        route: 'agent37-isolated',
        baseUrl: 'https://agent37-cast.agentrelay.com',
        workspaceId: 'rw_fresh',
        relaycastApiKey: 'rk_live_fresh_agent37',
      })
    ).toBe(false);
    expect(readProjectWorkspaceSession(projectDataDir())).toEqual({
      workspaceKey: 'rk_live_concurrent',
      workspaceId: 'rw_concurrent',
      enrolledNodeId: 'node_concurrent',
    });
  });

  it('refuses to overwrite a target changed after workspace selection', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', { workspaceId: 'rw_abc' });
    const selection = resolveWorkspaceSelection({ env: { AGENT_RELAY_HOME: dir } });
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'canonical',
      relaycastBaseUrl: 'https://cast.agentrelay.com',
      relaycastApiKey: 'rk_live_newer_route',
    });

    expect(
      persistWorkspaceRelaycastTarget(selection, {
        route: 'agent37-isolated',
        baseUrl: 'https://agent37-cast.agentrelay.com',
        workspaceId: 'rw_abc',
        relaycastApiKey: 'rk_live_stale_route',
      })
    ).toBe(false);
    expect(readProjectWorkspaceSession(projectDataDir())?.relaycastApiKey).toBe('rk_live_newer_route');
  });

  it('keeps legacy persisted targets usable when no separate Relaycast key exists', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_legacy_agent37', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
    });

    const options = { env: { AGENT_RELAY_HOME: dir } };
    expect(resolveWorkspaceKey(options)).toBe('rk_live_legacy_agent37');
    expect(resolveBaseUrl(options)).toBe('https://agent37-cast.agentrelay.com');
  });

  it('rejects a separate Relaycast key without a complete persisted route', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastApiKey: 'rk_live_agent37',
    });

    const options = { env: { AGENT_RELAY_HOME: dir } };
    expect(() => resolveWorkspaceKey(options)).toThrow(/persisted Relaycast workspace route is incomplete/);
    expect(() => resolveBaseUrl(options)).toThrow(/persisted Relaycast workspace route is incomplete/);
  });

  it('rejects a persisted route that is not the exact server-owned origin', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_agent37', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://evil.example',
    });

    expect(() => resolveBaseUrl({ env: { AGENT_RELAY_HOME: dir } })).toThrow(/not trusted/);
  });

  it('normalizes an equivalent requested trailing slash against the persisted route', () => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_agent37',
    });

    expect(
      resolveWorkspaceTransport({
        baseUrl: 'https://agent37-cast.agentrelay.com/',
        env: { AGENT_RELAY_HOME: dir },
      })
    ).toEqual({
      workspaceKey: 'rk_live_agent37',
      baseUrl: 'https://agent37-cast.agentrelay.com',
      source: 'project',
    });
  });

  it.each([
    'https://agent37-cast.agentrelay.com/path',
    'https://agent37-cast.agentrelay.com?query=1',
    'https://agent37-cast.agentrelay.com#fragment',
    'https://user:pass@agent37-cast.agentrelay.com',
    'https://agent37-cast.agentrelay.com:443',
    'https://agent37-cast.agentrelay.com:444',
    'https://agent37-cast.agentrelay.com/%2e%2e',
    'https://agent37-cast.agentrelay.com.attacker.example',
  ])('rejects an unsafe requested URL before pairing it with a persisted route-scoped key', (baseUrl) => {
    writeProjectWorkspaceKey(projectDataDir(), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_agent37',
    });

    expect(() => resolveWorkspaceTransport({ baseUrl, env: { AGENT_RELAY_HOME: dir } })).toThrow(
      /trusted origin|does not match/
    );
  });
});
