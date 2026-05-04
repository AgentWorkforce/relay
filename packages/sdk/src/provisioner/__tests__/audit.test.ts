import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLocalJwksKeyPair, provisionWorkflowAgents } from '../index.js';

async function createWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-provisioner-audit-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'index.ts'), 'export const value = 1;\n');

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('provisionWorkflowAgents writes a permission audit without token values', async () => {
  const workspace = await createWorkspace();

  try {
    const result = await provisionWorkflowAgents({
      tokenSigningKey: createLocalJwksKeyPair(),
      workspace: 'audit-workspace',
      projectDir: workspace.dir,
      relayfileBaseUrl: 'http://127.0.0.1:8080',
      agents: {
        worker: {
          access: 'readonly',
        },
      },
      skipSeeding: true,
      skipMount: true,
    });

    const auditPath = path.join(workspace.dir, '.agent-relay', 'permission-audit.json');
    const auditRaw = await readFile(auditPath, 'utf8');
    const auditJson = JSON.parse(auditRaw) as {
      entries: Array<{
        agentName: string;
        action: string;
        details: Record<string, unknown>;
      }>;
    };

    assert.ok(auditJson.entries.length >= 3);
    assert.deepEqual(
      auditJson.entries.map((entry) => `${entry.agentName}:${entry.action}`),
      ['worker:resolve', 'worker:mint', 'relay-admin:mint']
    );
    assert.equal(
      auditJson.entries[1]?.details.jwtPath,
      path.join(workspace.dir, '.relay', 'tokens', 'worker.jwt')
    );
    assert.ok(!auditRaw.includes(result.agents.worker.token));
    assert.ok(!auditRaw.includes(result.adminToken));
  } finally {
    await workspace.cleanup();
  }
});
