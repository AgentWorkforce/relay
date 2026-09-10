import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withDefaults } from '../commands/core.js';
import { runDownCommand } from './broker-lifecycle.js';
import { brokerIdentityPath, persistBrokerIdentity } from './broker-process-identity.js';

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('native broker ownership', () => {
  let root: string;
  let executable: string;
  const children: ChildProcess[] = [];
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-identity-'));
    executable = path.join(root, 'broker fixture');
    execFileSync('cc', ['-x', 'c', '-o', executable, '-'], {
      input:
        '#include <fcntl.h>\n#include <unistd.h>\nint main(int argc, char **argv) { if(argc != 2 || open(argv[1], O_CREAT|O_TRUNC|O_RDWR, 0600) < 0) return 1; for(;;) pause(); }\n',
    });
  });
  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? undefined
          : new Promise<void>((resolve) => child.once('exit', () => resolve()))
      )
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['matched', 'reopened'])('handles a real %s broker with spaces and a custom name', async (mode) => {
    const projectRoot = path.join(root, mode);
    const stateDir = path.join(projectRoot, 'nested', 'custom  state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, 'broker-custom-node.lock');
    const child = spawn(executable, [lockPath], { stdio: 'ignore' });
    children.push(child);
    const peerPath = path.join(stateDir, 'broker-peer.lock');
    const peer = spawn(executable, [peerPath], { stdio: 'ignore' });
    children.push(peer);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(peerPath); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const paths = {
      projectRoot,
      dataDir: stateDir,
      teamDir: stateDir,
      dbPath: path.join(stateDir, 'messages.db'),
      projectId: 'fixture',
    };
    const deps = withDefaults({
      getProjectPaths: () => ({ ...paths }),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    await persistBrokerIdentity(paths, child.pid!, 'custom-node', deps);
    const filename = brokerIdentityPath(paths, deps, 'custom-node');
    expect(fs.existsSync(filename)).toBe(true);
    expect(path.dirname(filename)).toBe(path.join(projectRoot, '.agentworkforce', 'relay'));
    const recorded = fs.readFileSync(filename, 'utf8');
    if (mode === 'reopened') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fs.closeSync(fs.openSync(lockPath, 'w'));
    }
    if (mode === 'reopened')
      await expect(runDownCommand({ force: true, stateDir }, deps)).rejects.toMatchObject({ code: 1 });
    else await runDownCommand({ force: true, stateDir }, deps);
    expect(() => process.kill(peer.pid!, 0)).not.toThrow();
    if (mode === 'matched') {
      expect(() => process.kill(child.pid!, 0)).toThrow();
      expect(fs.existsSync(filename)).toBe(false);
    } else {
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(fs.readFileSync(filename, 'utf8')).toBe(recorded);
    }
  });
});
