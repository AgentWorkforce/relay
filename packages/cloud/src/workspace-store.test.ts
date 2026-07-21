import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readWorkspaceStore,
  resolveActiveWorkspaceEntry,
  resolveActiveWorkspaceKey,
  setActiveWorkspace,
  setWorkspaceKey,
  workspaceStorePath,
} from './workspace-store.js';

let dir: string;
const original = process.env.AGENT_RELAY_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-'));
  process.env.AGENT_RELAY_HOME = dir;
});

afterEach(() => {
  if (original === undefined) delete process.env.AGENT_RELAY_HOME;
  else process.env.AGENT_RELAY_HOME = original;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace store', () => {
  it('stores keys, sets the first as active, and resolves the active key', () => {
    setWorkspaceKey('ops', 'rk_ops');
    expect(resolveActiveWorkspaceKey()).toBe('rk_ops');

    setWorkspaceKey('support', 'rk_support');
    expect(readWorkspaceStore().active).toBe('ops');

    setActiveWorkspace('support');
    expect(resolveActiveWorkspaceKey()).toBe('rk_support');
  });

  it('throws when switching to an unknown workspace', () => {
    expect(() => setActiveWorkspace('nope')).toThrow(/Unknown workspace/);
  });

  it('writes the store with owner-only permissions', () => {
    setWorkspaceKey('ops', 'rk_ops');
    const mode = fs.statSync(workspaceStorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects reserved object-property workspace names', () => {
    expect(() => setWorkspaceKey('__proto__', 'rk_bad')).toThrow(/Invalid workspace name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('caches cloudWorkspaceId only when explicitly supplied, and clears it on a plain key update', () => {
    setWorkspaceKey('ops', 'rk_ops', undefined, 'rw_ops');
    expect(resolveActiveWorkspaceEntry()).toEqual({
      name: 'ops',
      entry: { key: 'rk_ops', cloudWorkspaceId: 'rw_ops' },
    });

    // A plain key update with no explicit cloudWorkspaceId must NOT carry the
    // old id forward. If it did, a user repointing this alias at a different
    // workspace via `workspace set_key`/`workspace join` could have self-heal
    // silently rejoin the OLD workspace if the new key transiently fails to
    // resolve, instead of surfacing the real failure.
    setWorkspaceKey('ops', 'rk_ops_rotated');
    expect(resolveActiveWorkspaceEntry()).toEqual({
      name: 'ops',
      entry: { key: 'rk_ops_rotated' },
    });

    // An explicit cloudWorkspaceId is stored as given.
    setWorkspaceKey('ops', 'rk_ops_rotated', undefined, 'rw_ops_new');
    expect(resolveActiveWorkspaceEntry()?.entry.cloudWorkspaceId).toBe('rw_ops_new');
  });

  it('resolveActiveWorkspaceEntry returns undefined when there is no active workspace', () => {
    expect(resolveActiveWorkspaceEntry()).toBeUndefined();
  });
});
