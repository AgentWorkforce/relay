import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activeWorkspaceKey,
  readWorkspaceStore,
  setWorkspaceKey,
  switchWorkspace,
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
    expect(activeWorkspaceKey()).toBe('rk_ops');

    setWorkspaceKey('support', 'rk_support');
    expect(readWorkspaceStore().active).toBe('ops');

    switchWorkspace('support');
    expect(activeWorkspaceKey()).toBe('rk_support');
  });

  it('throws when switching to an unknown workspace', () => {
    expect(() => switchWorkspace('nope')).toThrow(/Unknown workspace/);
  });
});
