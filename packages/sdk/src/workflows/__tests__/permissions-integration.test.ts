import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkflowDb } from '../runner.js';
import type { AgentPermissions, RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';

const tempDirs: string[] = [];

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

let lastProvisionResult:
  | {
      scopes: Map<string, string[]>;
      tokens: Map<string, string>;
    }
  | undefined;

const mockProvisionWorkflowAgents = vi.fn();

vi.mock('../../provisioner/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../provisioner/index.js')>(
    '../../provisioner/index.js'
  );

  mockProvisionWorkflowAgents.mockImplementation(async (config) => {
    const scopes = new Map<string, string[]>();
    const tokens = new Map<string, string>();
    const agents: Record<string, unknown> = {};
    let readonly = 0;
    let readwrite = 0;
    let denied = 0;
    let customScopes = 0;

    for (const [agentName, permissions] of Object.entries(config.agents ?? {}) as [
      string,
      AgentPermissions,
    ][]) {
      const compiled = actual.resolveAgentPermissions(
        agentName,
        permissions,
        config.projectDir,
        config.workspace
      );
      const token = `token:${agentName}`;

      scopes.set(agentName, [...compiled.scopes]);
      tokens.set(agentName, token);
      readonly += compiled.summary.readonly;
      readwrite += compiled.summary.readwrite;
      denied += compiled.summary.denied;
      customScopes += compiled.summary.customScopes;

      agents[agentName] = {
        name: agentName,
        tokenPath: path.resolve(config.projectDir, '.relay', 'tokens', `${agentName}.jwt`),
        token,
        scopes: [...compiled.scopes],
        compiled,
      };
    }

    const result = {
      agents,
      agentNames: Object.keys(config.agents ?? {}),
      adminToken: 'admin-token',
      seededFileCount: 0,
      seededAclCount: 0,
      summary: { readonly, readwrite, denied, customScopes },
      mounts: new Map(),
      tokens,
      scopes,
    };

    lastProvisionResult = { scopes, tokens };
    return result;
  });

  return {
    ...actual,
    provisionWorkflowAgents: mockProvisionWorkflowAgents,
  };
});

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

let queuedPtyOutputs: string[] = [];
let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;

const mockAgent = {
  name: 'workflow-agent',
  exitCode: 0,
  exitSignal: undefined as string | undefined,
  get waitForExit() {
    return waitForExitFn;
  },
  get waitForIdle() {
    return waitForIdleFn;
  },
  release: vi.fn().mockResolvedValue(undefined),
};

const mockHuman = {
  name: 'WorkflowRunner',
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

const mockRelayInstance = {
  spawnPty: vi.fn(),
  human: vi.fn().mockReturnValue(mockHuman),
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  listAgentsRaw: vi.fn().mockResolvedValue([]),
  onWorkerOutput: null as ((frame: { name: string; chunk: string }) => void) | null,
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentReleased: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  onDeliveryUpdate: null as any,
};

const defaultSpawnPtyImplementation = async ({ name, task }: { name: string; task?: string }) => {
  const queued = queuedPtyOutputs.shift();
  const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/u)?.[1]?.trim();
  const output = queued ?? (stepComplete ? `STEP_COMPLETE:${stepComplete}\n` : 'STEP_COMPLETE:done\n');

  queueMicrotask(() => {
    mockRelayInstance.onWorkerOutput?.({ name, chunk: output });
  });

  return { ...mockAgent, name };
};

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

type QueuedSubprocessResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  error?: Error;
};

let queuedSubprocessResults: QueuedSubprocessResult[] = [];

const mockSubprocessSpawn = vi.fn().mockImplementation((_cmd, _args, _options) => {
  const result = queuedSubprocessResults.shift() ?? { stdout: 'non-interactive complete\n', code: 0 };
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (result.error) {
      child.emit('error', result.error);
      return;
    }
    if (result.stdout) {
      child.stdout.emit('data', Buffer.from(result.stdout));
    }
    if (result.stderr) {
      child.stderr.emit('data', Buffer.from(result.stderr));
    }
    child.emit('close', result.code ?? 0, result.signal ?? null);
  });

  return child;
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: mockSubprocessSpawn,
  };
});

const { WorkflowRunner } = await import('../runner.js');

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (run: WorkflowRunRow) => {
      runs.set(run.id, { ...run });
    }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...patch });
    }),
    getRun: vi.fn(async (id: string) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (step: WorkflowStepRow) => {
      steps.set(step.id, { ...step });
    }),
    updateStep: vi.fn(async (id: string, patch: Partial<WorkflowStepRow>) => {
      const existing = steps.get(id);
      if (existing) steps.set(id, { ...existing, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId: string) => {
      return [...steps.values()].filter((step) => step.runId === runId);
    }),
  };
}

function createProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-permissions-integration-'));
  tempDirs.push(dir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(dir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  return dir;
}

function createBaseProject(): string {
  return createProject({
    'src/app.ts': 'export const app = true;\n',
    'docs/review.md': '# review\n',
    '.env': 'SECRET=1\n',
  });
}

function makeRunner(cwd: string): InstanceType<typeof WorkflowRunner> {
  return new WorkflowRunner({
    cwd,
    db: makeDb(),
    workspaceId: 'ws-test',
    relay: {
      env: {
        AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
      },
    },
  });
}

function makeConfig(
  agents: RelayYamlConfig['agents'],
  steps?: NonNullable<RelayYamlConfig['workflows']>[number]['steps'],
  permissionProfiles?: RelayYamlConfig['permission_profiles']
): RelayYamlConfig {
  return {
    version: '1',
    name: 'permissions-integration',
    permission_profiles: permissionProfiles,
    swarm: { pattern: 'dag' },
    agents,
    workflows: [
      {
        name: 'default',
        steps:
          steps ??
          agents.map((agent, index) => ({
            name: `step-${index + 1}`,
            agent: agent.name,
            task: `Complete work for ${agent.name}`,
          })),
      },
    ],
    trajectories: false,
  };
}

function getProvisionedScopes(agentName: string): string[] {
  expect(lastProvisionResult).toBeDefined();
  const scopes = lastProvisionResult?.scopes.get(agentName);
  expect(scopes).toBeDefined();
  return scopes ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  lastProvisionResult = undefined;
  queuedPtyOutputs = [];
  queuedSubprocessResults = [];
  waitForExitFn = vi.fn().mockResolvedValue('exited');
  waitForIdleFn = vi.fn().mockImplementation(() => never());
  mockAgent.release.mockResolvedValue(undefined);
  mockRelayInstance.spawnPty.mockImplementation(defaultSpawnPtyImplementation);
  mockRelayInstance.onWorkerOutput = null;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WorkflowRunner permission lifecycle integration', () => {
  it('mints workflow tokens before spawning interactive agents', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'writer',
        cli: 'claude',
        permissions: { access: 'readwrite' },
      },
    ]);

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    expect(mockProvisionWorkflowAgents).toHaveBeenCalledTimes(1);
    expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(1);
    expect(mockProvisionWorkflowAgents.mock.invocationCallOrder[0]).toBeLessThan(
      mockRelayInstance.spawnPty.mock.invocationCallOrder[0]
    );
  });

  it('skips provisioning entirely when no agent permissions are configured', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([{ name: 'legacy-agent', cli: 'claude' }]);

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    expect(mockProvisionWorkflowAgents).not.toHaveBeenCalled();
    expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('provisions reviewer agents with readonly scopes only', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'reviewer-agent',
        cli: 'claude',
        permissions: { access: 'readonly' },
      },
    ]);

    const run = await runner.execute(config, 'default');
    const scopes = getProvisionedScopes('reviewer-agent');

    expect(run.status).toBe('completed');
    expect(lastProvisionResult?.tokens.get('reviewer-agent')).toBe('token:reviewer-agent');
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => !scope.includes(':write:'))).toBe(true);
    expect(scopes.every((scope) => scope.includes(':read:'))).toBe(true);
  });

  it('provisions worker agents with readwrite scopes', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'worker-agent',
        cli: 'claude',
        permissions: { access: 'readwrite' },
      },
    ]);

    const run = await runner.execute(config, 'default');
    const scopes = getProvisionedScopes('worker-agent');

    expect(run.status).toBe('completed');
    expect(scopes).toContain('relayfile:fs:write:/src/app.ts');
    expect(scopes).toContain('relayfile:fs:write:/docs/review.md');
  });

  it('provisions lead agents with full-access scopes', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'lead-agent',
        cli: 'claude',
        permissions: { access: 'full' },
      },
    ]);

    const run = await runner.execute(config, 'default');
    const scopes = getProvisionedScopes('lead-agent');

    expect(run.status).toBe('completed');
    expect(scopes).toContain('relayfile:fs:write:/.env');
    expect(scopes).toContain('relayfile:fs:write:/src/app.ts');
    expect(scopes).toContain('relayfile:fs:write:/docs/review.md');
  });

  it('passes the workflow agent token through to spawnPty', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'interactive-agent',
        cli: 'claude',
        permissions: { access: 'readwrite' },
      },
    ]);

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    expect(mockRelayInstance.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        agentToken: 'token:interactive-agent',
      })
    );
  });

  it('merges permission profiles into agent permissions before provisioning', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig(
      [
        {
          name: 'profiled-agent',
          cli: 'claude',
          permissions: {
            profile: 'reviewer',
            why: 'Needs shared reviewer constraints with one extra scope',
            files: {
              read: ['docs/**'],
            },
            scopes: ['relay:custom:use:/review'],
          },
        },
      ],
      undefined,
      {
        reviewer: {
          description: 'Reusable reviewer profile',
          access: 'readonly',
          files: {
            read: ['src/**'],
            deny: ['.env'],
          },
          exec: ['git diff'],
        },
      }
    );

    const run = await runner.execute(config, 'default');
    const provisionedPermissions = mockProvisionWorkflowAgents.mock.calls[0]?.[0]?.agents?.['profiled-agent'];

    expect(run.status).toBe('completed');
    expect(provisionedPermissions).toEqual({
      description: 'Reusable reviewer profile',
      profile: 'reviewer',
      why: 'Needs shared reviewer constraints with one extra scope',
      access: 'readonly',
      files: {
        read: ['src/**', 'docs/**'],
        deny: ['.env'],
      },
      scopes: ['relay:custom:use:/review'],
      exec: ['git diff'],
    });
  });

  it('injects RELAY_AGENT_TOKEN into non-interactive agent environments', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'headless-agent',
        cli: 'claude',
        interactive: false,
        permissions: { access: 'readwrite' },
      },
    ]);

    const run = await runner.execute(config, 'default');
    const spawnOptions = mockSubprocessSpawn.mock.calls[0]?.[2] as
      | { env?: Record<string, string> }
      | undefined;

    expect(run.status).toBe('completed');
    expect(mockRelayInstance.spawnPty).not.toHaveBeenCalled();
    expect(mockSubprocessSpawn).toHaveBeenCalledTimes(1);
    expect(spawnOptions?.env?.RELAY_AGENT_TOKEN).toBe('token:headless-agent');
    expect(spawnOptions?.env?.RELAYFILE_TOKEN).toBe('token:headless-agent');
  });

  it('clears workflow-scoped tokens after successful completion', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'cleanup-agent',
        cli: 'claude',
        permissions: { access: 'readwrite' },
      },
    ]);

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    expect((runner as any).agentTokens.size).toBe(0);
  });

  it('clears workflow-scoped tokens after failed workflows', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'failing-agent',
        cli: 'claude',
        permissions: { access: 'readwrite' },
      },
    ]);

    mockRelayInstance.spawnPty.mockRejectedValueOnce(new Error('spawn failed'));

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('failed');
    expect((runner as any).agentTokens.size).toBe(0);
  });

  it('reports resolved permissions during dry-run without minting tokens', () => {
    const projectDir = createProject({
      'src/app.ts': 'export const app = true;\n',
      '.agentreadonly': 'src/app.ts\n',
    });
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'dry-run-agent',
        cli: 'claude',
        permissions: {
          access: 'readonly',
          files: {
            read: ['src/**'],
          },
          scopes: ['relay:custom:use:/feature'],
        },
      },
    ]);

    const report = runner.dryRun(config, 'default');
    const permissionEntry = report.permissions?.find((entry) => entry.agent === 'dry-run-agent');

    expect(report.valid).toBe(true);
    expect(permissionEntry).toMatchObject({
      agent: 'dry-run-agent',
      access: 'readonly',
      source: 'yaml',
    });
    expect(permissionEntry?.scopes ?? 0).toBeGreaterThan(0);
    expect(mockProvisionWorkflowAgents).not.toHaveBeenCalled();
    expect(mockRelayInstance.spawnPty).not.toHaveBeenCalled();
    expect((runner as any).agentTokens.size).toBe(0);
  });

  it('rejects invalid permission config during validation before provisioning', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'invalid-agent',
        cli: 'claude',
        permissions: {
          access: 'bogus' as any,
        },
      },
    ]);

    await expect(runner.execute(config, 'default')).rejects.toThrow('Permission validation failed');
    expect(mockProvisionWorkflowAgents).not.toHaveBeenCalled();
    expect(mockRelayInstance.spawnPty).not.toHaveBeenCalled();
  });

  it('rejects unknown permission profiles during validation before provisioning', async () => {
    const projectDir = createBaseProject();
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'invalid-profile-agent',
        cli: 'claude',
        permissions: {
          profile: 'missing-reviewer',
        },
      },
    ]);

    await expect(runner.execute(config, 'default')).rejects.toThrow('Permission validation failed');
    expect(mockProvisionWorkflowAgents).not.toHaveBeenCalled();
    expect(mockRelayInstance.spawnPty).not.toHaveBeenCalled();
  });

  it('merges dotfile rules with YAML overrides into the expected scopes', async () => {
    const projectDir = createProject({
      '.agentignore': 'blocked.txt\n',
      '.agentreadonly': 'locked.txt\n',
      'blocked.txt': 'blocked\n',
      'locked.txt': 'locked\n',
      'plain.txt': 'plain\n',
    });
    const runner = makeRunner(projectDir);
    const config = makeConfig([
      {
        name: 'override-agent',
        cli: 'claude',
        permissions: {
          access: 'restricted',
          files: {
            read: ['blocked.txt'],
            write: ['locked.txt'],
          },
        },
      },
    ]);

    const run = await runner.execute(config, 'default');
    const scopes = getProvisionedScopes('override-agent');

    expect(run.status).toBe('completed');
    expect(scopes).toEqual([
      'relayfile:fs:read:/blocked.txt',
      'relayfile:fs:read:/locked.txt',
      'relayfile:fs:write:/locked.txt',
    ]);
  });
});
