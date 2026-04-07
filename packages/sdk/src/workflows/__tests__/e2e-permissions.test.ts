import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkflowDb } from '../runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';
import type { ProvisionResult, WorkflowProvisionConfig } from '../../provisioner/types.js';

const fixturePath = fileURLToPath(new URL('./fixtures/permission-test.yaml', import.meta.url));

const permissionProfiles = {
  reader: {
    access: 'readonly',
    scopes: ['relayfile:fs:read:/**'],
    summary: { readonly: 4, readwrite: 0, denied: 0, customScopes: 0 },
  },
  writer: {
    access: 'readwrite',
    scopes: ['relayfile:fs:read:/src/tests/**', 'relayfile:fs:write:/src/tests/**'],
    summary: { readonly: 0, readwrite: 1, denied: 2, customScopes: 0 },
  },
  'admin-lead': {
    access: 'full',
    scopes: ['relayfile:fs:read:/**', 'relayfile:fs:write:/**'],
    summary: { readonly: 0, readwrite: 6, denied: 0, customScopes: 0 },
  },
} as const;

type PermissionProfile = (typeof permissionProfiles)[keyof typeof permissionProfiles];

function buildCompiledPermissions(agentName: string, workspace: string, profile: PermissionProfile) {
  return {
    agentName,
    workspace,
    effectiveAccess: profile.access,
    inherited: profile.access !== 'full',
    sources: [{ type: 'yaml' as const, label: 'permissions', ruleCount: profile.scopes.length }],
    readonlyPatterns: profile.access === 'readonly' ? ['**'] : [],
    readwritePatterns:
      profile.access === 'full'
        ? ['**']
        : profile.scopes
            .filter((scope) => scope.startsWith('relayfile:fs:write:'))
            .map((scope) => scope.split(':').slice(3).join(':')),
    deniedPatterns: agentName === 'writer' ? ['.env', 'secrets/**'] : [],
    readonlyPaths: Array.from({ length: profile.summary.readonly }, (_, index) => `readonly-${index}.txt`),
    readwritePaths: Array.from({ length: profile.summary.readwrite }, (_, index) => `write-${index}.txt`),
    deniedPaths: Array.from({ length: profile.summary.denied }, (_, index) => `denied-${index}.txt`),
    scopes: [...profile.scopes],
    network: undefined,
    exec: undefined,
    acl: {},
    summary: { ...profile.summary },
  };
}

let lastProvisionCall: WorkflowProvisionConfig | null = null;
let lastProvisionResult: ProvisionResult | null = null;

const mockProvisionWorkflowAgents = vi.fn(
  async (input: WorkflowProvisionConfig): Promise<ProvisionResult> => {
    lastProvisionCall = input;

    const agentNames = Object.keys(input.agents ?? {});
    const tokens = new Map<string, string>();
    const scopes = new Map<string, string[]>();
    const agents = Object.fromEntries(
      agentNames.map((agentName) => {
        const profile = permissionProfiles[agentName as keyof typeof permissionProfiles];
        const token = `jwt-${agentName}`;
        const compiled = buildCompiledPermissions(agentName, input.workspace, profile);

        tokens.set(agentName, token);
        scopes.set(agentName, [...profile.scopes]);

        return [
          agentName,
          {
            name: agentName,
            tokenPath: path.join(input.projectDir, '.relay', 'tokens', `${agentName}.jwt`),
            token,
            scopes: [...profile.scopes],
            compiled,
          },
        ];
      })
    );

    const result: ProvisionResult = {
      agents,
      agentNames,
      adminToken: 'jwt-admin',
      seededFileCount: 0,
      seededAclCount: 0,
      summary: agentNames.reduce(
        (acc, agentName) => {
          const profile = permissionProfiles[agentName as keyof typeof permissionProfiles];
          acc.readonly += profile.summary.readonly;
          acc.readwrite += profile.summary.readwrite;
          acc.denied += profile.summary.denied;
          acc.customScopes += profile.summary.customScopes;
          return acc;
        },
        { readonly: 0, readwrite: 0, denied: 0, customScopes: 0 }
      ),
      mounts: new Map(),
      tokens,
      scopes,
    };

    lastProvisionResult = result;
    return result;
  }
);

const mockResolveAgentPermissions = vi.fn(
  (agentName: string, _permissions: unknown, _projectDir: string, workspace: string) =>
    buildCompiledPermissions(
      agentName,
      workspace,
      permissionProfiles[agentName as keyof typeof permissionProfiles]
    )
);

vi.mock('../../provisioner/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../provisioner/index.js')>();
  return {
    ...actual,
    provisionWorkflowAgents: mockProvisionWorkflowAgents,
    resolveAgentPermissions: mockResolveAgentPermissions,
  };
});

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_live_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

const mockRelaycastAgent = {
  send: vi.fn().mockResolvedValue(undefined),
  heartbeat: vi.fn().mockResolvedValue(undefined),
  channels: {
    create: vi.fn().mockResolvedValue(undefined),
    join: vi.fn().mockResolvedValue(undefined),
    invite: vi.fn().mockResolvedValue(undefined),
  },
};

const mockRelaycast = {
  agents: {
    register: vi.fn().mockResolvedValue({ token: 'token-1' }),
  },
  as: vi.fn().mockReturnValue(mockRelaycastAgent),
};

class MockRelayError extends Error {
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
    (this as any).status = status;
  }
}

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => mockRelaycast),
  RelayError: MockRelayError,
}));

let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;
let mockSpawnOutputs: string[] = [];

const mockAgent = {
  name: 'test-agent-abc',
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

const defaultSpawnPtyImplementation = async ({ name, task }: { name: string; task?: string }) => {
  const queued = mockSpawnOutputs.shift();
  const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
  const output = queued ?? (stepComplete ? `STEP_COMPLETE:${stepComplete}\n` : 'STEP_COMPLETE:unknown\n');

  queueMicrotask(() => {
    if (typeof mockRelayInstance.onWorkerOutput === 'function') {
      mockRelayInstance.onWorkerOutput({ name, chunk: output });
    }
  });

  return { ...mockAgent, name };
};

const mockRelayInstance = {
  spawnPty: vi.fn().mockImplementation(defaultSpawnPtyImplementation),
  human: vi.fn().mockReturnValue(mockHuman),
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  onWorkerOutput: null as ((frame: { name: string; chunk: string }) => void) | null,
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentReleased: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  onDeliveryUpdate: null as any,
  listAgentsRaw: vi.fn().mockResolvedValue([]),
};

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

const { WorkflowRunner } = await import('../runner.js');
const { formatDryRunReport } = await import('../dry-run-format.js');

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

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

function createWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-workflow-permissions-'));
  mkdirSync(path.join(dir, 'src', 'tests'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# workspace\n');
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(dir, 'src', 'tests', 'fixture.txt'), 'fixture\n');
  writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n');
  writeFileSync(path.join(dir, 'secrets', 'prod.txt'), 'top-secret\n');
  return dir;
}

async function loadPermissionFixture(
  runner: InstanceType<typeof WorkflowRunner>,
  options: { includeLeadStep?: boolean } = {}
): Promise<RelayYamlConfig> {
  const config = await runner.parseYamlFile(fixturePath);
  config.trajectories = false;

  if (options.includeLeadStep) {
    const workflow = config.workflows?.find((entry) => entry.name === 'test');
    workflow?.steps.push({
      name: 'lead-step',
      agent: 'admin-lead',
      dependsOn: ['read-step', 'write-step'],
      task: 'Verify admin lead permissions are available and conclude the workflow.',
    });
  }

  return config;
}

describe('WorkflowRunner permissions integration', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;
  let workspaceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockImplementation(() => never());
    mockSpawnOutputs = [];
    mockAgent.release.mockResolvedValue(undefined);
    mockRelayInstance.spawnPty.mockImplementation(defaultSpawnPtyImplementation);
    mockRelayInstance.onWorkerOutput = null;
    lastProvisionCall = null;
    lastProvisionResult = null;
    workspaceDir = createWorkspace();
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: workspaceDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('provisions permissions, propagates agent tokens, and clears workflow tokens after completion', async () => {
    const config = await loadPermissionFixture(runner, { includeLeadStep: true });
    const provisionSpy = vi.spyOn(runner as any, 'provisionAgents');
    const nonInteractiveCommandSpy = vi
      .spyOn(WorkflowRunner, 'buildNonInteractiveCommand')
      .mockImplementation(() => ({
        cmd: 'sh',
        args: ['-c', 'printf "RELAY_AGENT_TOKEN=%s" "$RELAY_AGENT_TOKEN"'],
      }));

    const run = await runner.execute(config, 'test');
    const steps = await db.getStepsByRunId(run.id);
    const stepByName = new Map(steps.map((step) => [step.stepName, step]));
    const provisionedScopes = lastProvisionResult?.scopes;
    const spawnCalls = (mockRelayInstance.spawnPty as any).mock.calls.map(
      ([input]: [{ agentToken?: string; name: string }]) => input
    );

    expect(run.status).toBe('completed');
    expect(provisionSpy).toHaveBeenCalledTimes(1);
    expect(mockProvisionWorkflowAgents).toHaveBeenCalledTimes(1);
    expect(lastProvisionCall?.workspace).toBe('ws-test');
    expect(lastProvisionCall?.projectDir).toBe(workspaceDir);
    expect(Object.keys(lastProvisionCall?.agents ?? {})).toEqual(['reader', 'writer', 'admin-lead']);

    expect(provisionedScopes?.get('reader')).toEqual(['relayfile:fs:read:/**']);
    expect(provisionedScopes?.get('reader')?.some((scope) => scope.includes(':write:'))).toBe(false);
    expect(provisionedScopes?.get('writer')).toEqual([
      'relayfile:fs:read:/src/tests/**',
      'relayfile:fs:write:/src/tests/**',
    ]);
    expect(provisionedScopes?.get('writer')?.filter((scope) => scope.includes(':write:'))).toEqual([
      'relayfile:fs:write:/src/tests/**',
    ]);
    expect(provisionedScopes?.get('admin-lead')).toEqual(['relayfile:fs:read:/**', 'relayfile:fs:write:/**']);

    expect(nonInteractiveCommandSpy).toHaveBeenCalledTimes(2);
    expect(stepByName.get('read-step')?.output).toBe('RELAY_AGENT_TOKEN=jwt-reader');
    expect(stepByName.get('write-step')?.output).toBe('RELAY_AGENT_TOKEN=jwt-writer');

    expect(spawnCalls.length).toBeGreaterThan(0);
    expect(
      spawnCalls.every(
        (call: { agentToken: string }) => typeof call.agentToken === 'string' && call.agentToken.length > 0
      )
    ).toBe(true);
    expect(spawnCalls[0]?.agentToken).toBe('jwt-admin-lead');

    expect((runner as any).agentTokens.size).toBe(0);
    expect((runner as any).agentMounts.size).toBe(0);
  }, 20_000);

  it('shows a permissions summary in dry-run mode', async () => {
    const config = await loadPermissionFixture(runner);
    const report = runner.dryRun(config, 'test');
    const formatted = formatDryRunReport(report);

    expect(report.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'reader',
          access: 'readonly',
          writePaths: 0,
        }),
        expect.objectContaining({
          agent: 'writer',
          access: 'readwrite',
          writePaths: 1,
        }),
        expect.objectContaining({
          agent: 'admin-lead',
          access: 'full',
        }),
      ])
    );

    expect(formatted).toContain('Permissions');
    expect(formatted).toContain('reader');
    expect(formatted).toContain('writer');
    expect(formatted).toContain('admin-lead');
    expect(formatted).toContain('readonly');
    expect(formatted).toContain('readwrite');
    expect(formatted).toContain('full');
  }, 20_000);
});
