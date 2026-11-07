import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectWorkspaceKeyPath,
  readProjectWorkspaceKey,
  readProjectWorkspaceSession,
  writeProjectWorkspaceKey,
} from './project-workspace-key.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proj-wk-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('project workspace key store', () => {
  it('round-trips a written key and trims it', () => {
    writeProjectWorkspaceKey(dataDir, '  rk_project  ');
    expect(readProjectWorkspaceKey(dataDir)).toBe('rk_project');
    // Owner-only permissions, matching connection.json.
    const mode = fs.statSync(projectWorkspaceKeyPath(dataDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips the enrolled node association without exposing another credential', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_project', { enrolledNodeId: ' node_1 ' });
    expect(readProjectWorkspaceSession(dataDir)).toEqual({
      workspaceKey: 'rk_project',
      enrolledNodeId: 'node_1',
    });
  });

  it('reads undefined for a missing, malformed, or blank-key file', () => {
    expect(readProjectWorkspaceKey(dataDir)).toBeUndefined();

    fs.writeFileSync(projectWorkspaceKeyPath(dataDir), 'not json');
    expect(readProjectWorkspaceKey(dataDir)).toBeUndefined();

    fs.writeFileSync(projectWorkspaceKeyPath(dataDir), JSON.stringify({ workspaceKey: '   ' }));
    expect(readProjectWorkspaceKey(dataDir)).toBeUndefined();
  });

  it('ignores a blank key so a resolved key is not clobbered by an empty one', () => {
    writeProjectWorkspaceKey(dataDir, 'rk_keep');
    writeProjectWorkspaceKey(dataDir, '   ');
    writeProjectWorkspaceKey(dataDir, undefined);
    expect(readProjectWorkspaceKey(dataDir)).toBe('rk_keep');
  });
});
