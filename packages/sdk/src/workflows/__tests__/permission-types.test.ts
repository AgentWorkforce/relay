import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileAgentScopes, resolveAgentPermissions } from '../../provisioner/compiler.js';
import type {
  AccessPreset,
  AgentDefinition,
  AgentWorkflowStep,
  DeterministicWorkflowStep,
} from '../types.js';
import { isAgentStep, isDeterministicStep, isRestrictedAgent } from '../types.js';

const tempDirs: string[] = [];

async function createWorkspace(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-workflow-permission-types-'));
  tempDirs.push(dir);

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('workflow permission types', () => {
  it('allows agents to omit permissions without becoming restricted', () => {
    const agent: AgentDefinition = {
      name: 'worker',
      cli: 'codex',
      task: 'Write tests',
    };

    expect(agent.permissions).toBeUndefined();
    expect(isRestrictedAgent(agent)).toBe(false);
  });

  it.each(['readonly', 'readwrite', 'restricted', 'full'] as const satisfies readonly AccessPreset[])(
    'accepts the %s access preset',
    async (access) => {
      const workspace = await createWorkspace({
        'src/index.ts': 'export const value = 1;\n',
      });

      const compiled = compileAgentScopes({
        agentName: `${access}-agent`,
        workspace: 'relay-test',
        projectDir: workspace,
        permissions: {
          access,
          inherit: false,
        },
      });

      expect(compiled.effectiveAccess).toBe(access);
      expect(isRestrictedAgent({ name: 'agent', cli: 'codex', permissions: { access } })).toBe(
        access === 'readonly' || access === 'restricted'
      );
    }
  );

  it('compiles full permissions with read/write access for all files', async () => {
    const workspace = await createWorkspace({
      '.agentignore': 'secret.txt\n',
      '.agentreadonly': 'locked.txt\n',
      'locked.txt': 'lock me\n',
      'secret.txt': 'classified\n',
      'src/index.ts': 'export const value = 1;\n',
    });

    const compiled = compileAgentScopes({
      agentName: 'lead',
      workspace: 'relay-test',
      projectDir: workspace,
      permissions: {
        access: 'full',
        network: false,
        exec: ['npm test'],
        scopes: ['custom:relay:debug'],
      },
    });

    expect(compiled.effectiveAccess).toBe('full');
    expect(compiled.inherited).toBe(false);
    expect(compiled.readonlyPaths).toEqual([]);
    expect(compiled.deniedPaths).toEqual([]);
    expect(compiled.readwritePaths).toEqual([
      '.agentignore',
      '.agentreadonly',
      'locked.txt',
      'secret.txt',
      'src/index.ts',
    ]);
    expect(compiled.scopes).toContain('relayfile:fs:read:/secret.txt');
    expect(compiled.scopes).toContain('relayfile:fs:write:/secret.txt');
    expect(compiled.scopes).toContain('relayfile:fs:read:/src/index.ts');
    expect(compiled.scopes).toContain('relayfile:fs:write:/src/index.ts');
    expect(compiled.scopes).toContain('custom:relay:debug');
    expect(compiled.network).toBe(false);
    expect(compiled.exec).toEqual(['npm test']);
    expect(compiled.summary).toEqual({
      readonly: 0,
      readwrite: 5,
      denied: 0,
      customScopes: 1,
    });
  });

  it('preserves backwards-compatible default resolution when permissions are undefined', async () => {
    const workspace = await createWorkspace({
      '.agentignore': 'blocked.txt\n',
      '.agentreadonly': 'locked.txt\n',
      'blocked.txt': 'do not read\n',
      'locked.txt': 'read only\n',
      'writable.txt': 'can edit\n',
    });

    const compiled = resolveAgentPermissions('legacy-worker', undefined, workspace, 'relay-test');

    expect(compiled.effectiveAccess).toBe('readwrite');
    expect(compiled.inherited).toBe(true);
    expect(compiled.readonlyPaths).toEqual(['locked.txt']);
    expect(compiled.readwritePaths).toEqual(['.agentignore', '.agentreadonly', 'writable.txt']);
    expect(compiled.deniedPaths).toEqual(['blocked.txt']);
  });

  it('keeps legacy workflow step aliases compatible with WorkflowStep guards', () => {
    const agentStep: AgentWorkflowStep = {
      name: 'draft',
      agent: 'worker',
      task: 'Draft the summary',
    };
    const deterministicStep: DeterministicWorkflowStep = {
      name: 'check',
      type: 'deterministic',
      command: 'npm test',
    };

    expect(isAgentStep(agentStep)).toBe(true);
    expect(isDeterministicStep(agentStep)).toBe(false);
    expect(isDeterministicStep(deterministicStep)).toBe(true);
  });
});
