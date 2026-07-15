import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentToken, resolveBaseUrl, resolveWorkspaceKey } from './sdk-client.js';
import { setWorkspaceKey } from './workspace-store.js';
import { writeProjectWorkspaceKey } from './project-workspace-key.js';

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
    expect(
      resolveWorkspaceKey({ env: { RELAY_WORKSPACE_KEY: 'rk_env', AGENT_RELAY_HOME: dir } })
    ).toBe('rk_env');
  });

  it('falls back to the global active workspace when no CWD broker key is recorded', () => {
    setWorkspaceKey('ops', 'rk_global');
    expect(resolveWorkspaceKey({ env: { AGENT_RELAY_HOME: dir } })).toBe('rk_global');
  });

  it('trims optional base URL and agent token values', () => {
    expect(resolveBaseUrl({ baseUrl: '  https://relay.example  ' })).toBe('https://relay.example');
    expect(resolveAgentToken({ token: '  at_123  ' })).toBe('at_123');
    expect(resolveAgentToken({ token: '   ', env: { RELAY_AGENT_TOKEN: '  at_env  ' } })).toBe('at_env');
  });
});
