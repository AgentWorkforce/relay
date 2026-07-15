import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findProjectRoot } from './project-namespace.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('findProjectRoot environment isolation', () => {
  it('ignores the host override but retains upward marker discovery with an explicit env', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-root-'));
    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-project-'));
    tempRoots.push(root, hostRoot);
    const nested = path.join(root, 'packages', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const originalHostProject = process.env.AGENT_RELAY_PROJECT;
    process.env.AGENT_RELAY_PROJECT = hostRoot;

    try {
      expect(findProjectRoot(nested, {})).toBe(root);
    } finally {
      if (originalHostProject === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = originalHostProject;
    }
  });
});
