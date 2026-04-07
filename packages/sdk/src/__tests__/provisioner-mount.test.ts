import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureRelayfileMount } from '../provisioner/mount.js';
import { provisionWorkflowAgents } from '../provisioner/index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createFakeMountBinary(): Promise<string> {
  const root = await makeTempDir('relayfile-mount-bin-');
  const binaryPath = path.join(root, 'relayfile-mount');
  await writeFile(
    binaryPath,
    [
      '#!/bin/sh',
      'LOCAL_DIR=""',
      'ONCE=0',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --local-dir)',
      '      LOCAL_DIR="$2"',
      '      shift 2',
      '      ;;',
      '    --once)',
      '      ONCE=1',
      '      shift',
      '      ;;',
      '    *)',
      '      shift',
      '      ;;',
      '  esac',
      'done',
      'mkdir -p "$LOCAL_DIR"',
      'if [ "$ONCE" -eq 1 ]; then',
      '  printf "seeded\\n" > "$LOCAL_DIR/seeded.txt"',
      '  exit 0',
      'fi',
      'printf "live\\n" > "$LOCAL_DIR/live.txt"',
      'trap "exit 0" TERM INT',
      'while :; do sleep 1; done',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return binaryPath;
}

async function waitForPath(filePath: string, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(filePath);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('ensureRelayfileMount', () => {
  it('runs initial sync, starts the watcher, and removes the mount on stop', async () => {
    const binaryPath = await createFakeMountBinary();
    const mountPoint = path.join(await makeTempDir('relayfile-mount-target-'), 'workspace');

    const mount = await ensureRelayfileMount({
      binaryPath,
      relayfileUrl: 'http://127.0.0.1:8080',
      workspace: 'rw_test',
      token: 'test-token',
      mountPoint,
    });

    expect(mount.pid).toBeGreaterThan(0);
    expect(existsSync(path.join(mountPoint, 'seeded.txt'))).toBe(true);
    expect(await waitForPath(path.join(mountPoint, 'live.txt'))).toBe(true);

    await mount.stop();

    expect(existsSync(mountPoint)).toBe(false);
  });
});

describe('provisionWorkflowAgents mount integration', () => {
  it('starts a per-agent mount and exposes its mount point in the result', async () => {
    const projectDir = await makeTempDir('relay-provisioner-project-');
    const binaryPath = await createFakeMountBinary();
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const value = 1;\n');

    const result = await provisionWorkflowAgents({
      secret: 'test-secret',
      workspace: 'rw_workspace',
      projectDir,
      relayfileBaseUrl: 'http://127.0.0.1:8080',
      agents: {
        worker: {
          access: 'readonly',
        },
      },
      skipSeeding: true,
      mountBinaryPath: binaryPath,
    });

    const mount = result.mounts.get('worker');
    expect(mount).toBeDefined();
    expect(result.agents.worker.mountPoint).toBe(mount?.mountPoint);
    expect(existsSync(path.join(mount!.mountPoint, 'seeded.txt'))).toBe(true);

    await mount?.stop();
  });
});
