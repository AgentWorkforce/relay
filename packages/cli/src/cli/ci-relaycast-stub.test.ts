import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const stubScript = resolve('scripts/ci-relaycast-stub.mjs');
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

async function waitForUrl(path: string, child: ChildProcess, stderr: () => string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    }
    if (child.exitCode !== null) {
      throw new Error(`stub exited with ${child.exitCode}: ${stderr()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`stub did not publish its URL: ${stderr()}`);
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CI Relaycast handshake stub', () => {
  it('requires a workspace key and returns the registration envelope the broker consumes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-ci-relaycast-stub-test-'));
    temporaryDirectories.push(directory);
    const urlFile = join(directory, 'url');
    const child = spawn(process.execPath, [stubScript, '--url-file', urlFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const baseUrl = await waitForUrl(urlFile, child, () => stderr);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: 'relay-ci-handshake-stub',
    });

    const unauthorized = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'publish-smoke' }),
    });
    expect(unauthorized.status).toBe(401);

    const registered = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer rk_ci_publish_verify',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'publish-smoke', type: 'agent' }),
    });
    expect(registered.status).toBe(200);
    await expect(registered.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: 'agent_ci_1',
        workspace_id: 'ws_ci_publish_verify',
        name: 'publish-smoke',
        token: 'at_ci_publish_verify_1',
        status: 'online',
      },
    });
  });
});
