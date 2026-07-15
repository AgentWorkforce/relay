import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HarnessDriverClient } from './client.js';

const tempDirs: string[] = [];
const originalStateDir = process.env.AGENT_RELAY_STATE_DIR;

function writeConnection(stateDir: string, url: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'connection.json'),
    JSON.stringify({ url, api_key: 'br_test', pid: process.pid })
  );
}

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.AGENT_RELAY_STATE_DIR;
  else process.env.AGENT_RELAY_STATE_DIR = originalStateDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('HarnessDriverClient.connect environment isolation', () => {
  it('uses the supplied state dir instead of the host process state dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-connect-env-'));
    tempDirs.push(root);
    const hostStateDir = path.join(root, 'host');
    const embeddedStateDir = path.join(root, 'embedded');
    writeConnection(hostStateDir, 'http://127.0.0.1:4101');
    writeConnection(embeddedStateDir, 'http://127.0.0.1:4102');
    process.env.AGENT_RELAY_STATE_DIR = hostStateDir;

    const client = HarnessDriverClient.connect({
      cwd: root,
      env: { AGENT_RELAY_STATE_DIR: embeddedStateDir },
    });

    expect(client.baseUrl).toBe('http://127.0.0.1:4102');
  });
});
