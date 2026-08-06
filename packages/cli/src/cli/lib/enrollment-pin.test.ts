import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { linkEnrolledNodeToProjectPin } from './enrollment-pin.js';
import { readProjectWorkspaceSession, writeProjectWorkspaceKey } from './project-workspace-key.js';

const tempRoots: string[] = [];

function projectDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-enrollment-pin-'));
  tempRoots.push(root);
  return path.join(root, 'project', '.agentworkforce', 'relay');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('linkEnrolledNodeToProjectPin', () => {
  it('records the enrolled node on a pin that has none', () => {
    const dataDir = projectDataDir();
    writeProjectWorkspaceKey(dataDir, 'rk_live_pinned');

    const result = linkEnrolledNodeToProjectPin({ nodeId: 'node_abc', projectDataDir: dataDir });

    expect(result).toMatchObject({ status: 'linked', nodeId: 'node_abc' });
    expect(readProjectWorkspaceSession(dataDir)).toEqual({
      workspaceKey: 'rk_live_pinned',
      enrolledNodeId: 'node_abc',
    });
  });

  it('leaves an unpinned project alone', () => {
    const dataDir = projectDataDir();

    expect(linkEnrolledNodeToProjectPin({ nodeId: 'node_abc', projectDataDir: dataDir })).toEqual({
      status: 'no-pin',
    });
    expect(readProjectWorkspaceSession(dataDir)).toBeUndefined();
  });

  it('reports an unchanged pin that already names the node', () => {
    const dataDir = projectDataDir();
    writeProjectWorkspaceKey(dataDir, 'rk_live_pinned', { enrolledNodeId: 'node_abc' });

    expect(linkEnrolledNodeToProjectPin({ nodeId: 'node_abc', projectDataDir: dataDir })).toMatchObject({
      status: 'unchanged',
      nodeId: 'node_abc',
    });
  });

  it('never repoints a pin that names a different node', () => {
    const dataDir = projectDataDir();
    writeProjectWorkspaceKey(dataDir, 'rk_live_pinned', { enrolledNodeId: 'node_existing' });

    const result = linkEnrolledNodeToProjectPin({ nodeId: 'node_new', projectDataDir: dataDir });

    expect(result).toMatchObject({
      status: 'conflict',
      nodeId: 'node_new',
      pinnedNodeId: 'node_existing',
    });
    expect(readProjectWorkspaceSession(dataDir)?.enrolledNodeId).toBe('node_existing');
  });

  it('preserves the pinned workspace key when linking', () => {
    const dataDir = projectDataDir();
    writeProjectWorkspaceKey(dataDir, 'rk_live_pinned');

    linkEnrolledNodeToProjectPin({ nodeId: 'node_abc', projectDataDir: dataDir });

    expect(readProjectWorkspaceSession(dataDir)?.workspaceKey).toBe('rk_live_pinned');
  });
});
