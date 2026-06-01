import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentToken, resolveBaseUrl, resolveWorkspaceKey } from './sdk-client.js';
import { setWorkspaceKey } from './workspace-store.js';

let dir: string;
const original = process.env.AGENT_RELAY_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-client-'));
  process.env.AGENT_RELAY_HOME = dir;
});

afterEach(() => {
  if (original === undefined) delete process.env.AGENT_RELAY_HOME;
  else process.env.AGENT_RELAY_HOME = original;
  fs.rmSync(dir, { recursive: true, force: true });
});

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

  it('trims optional base URL and agent token values', () => {
    expect(resolveBaseUrl({ baseUrl: '  https://relay.example  ' })).toBe('https://relay.example');
    expect(resolveAgentToken({ token: '  at_123  ' })).toBe('at_123');
    expect(resolveAgentToken({ token: '   ', env: { RELAY_AGENT_TOKEN: '  at_env  ' } })).toBe('at_env');
  });
});
