import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFleetCommands } from './fleet.js';
import { resolveSandboxRepository } from '../lib/sandbox-repo.js';

const REPLAY_SANDBOX_ID = 'sbx_123e4567-e89b-42d3-a456-426614174000';
const REPLAY_SANDBOX_NAME = 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000';
const TARGET = {
  route: 'agent37-isolated' as const,
  baseUrl: 'https://agent37-cast.agentrelay.com',
  workspaceId: 'rw_test',
  relaycastApiKey: 'rk_live_test_target',
};

const REVISION = '0123456789abcdef0123456789abcdef01234567';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function registerSandboxCommand(overrides: {
  projectRoot: string;
  resolveSandboxRepository: typeof resolveSandboxRepository;
  materializeCloudRelayfileRepository?: ReturnType<typeof vi.fn>;
  ensureCloudFleetSandbox: ReturnType<typeof vi.fn>;
  placement?: ReturnType<typeof vi.fn>;
}): Command {
  const placement = overrides.placement ?? vi.fn(async () => ({ invocationId: 'inv_test' }));
  const register = vi.fn(async () => ({ token: 'at_live_launcher' }));
  const release = vi.fn(async () => ({ released: true, deleted: true }));
  const createWorkspaceRelay = vi.fn(() => ({
    workspace: {
      info: vi.fn(async () => ({ id: TARGET.workspaceId })),
      register,
      release,
    },
  }));
  const program = new Command();
  program.exitOverride();
  registerFleetCommands(program, {
    core: {
      getProjectPaths: () => ({
        projectRoot: overrides.projectRoot,
        dataDir: path.join(overrides.projectRoot, '.agentworkforce', 'relay'),
        teamDir: overrides.projectRoot,
      }),
      env: {},
      exit: vi.fn(() => {
        throw new Error('__exit__');
      }),
    } as never,
    resolveSandboxRepository: overrides.resolveSandboxRepository,
    ...(overrides.materializeCloudRelayfileRepository
      ? { materializeCloudRelayfileRepository: overrides.materializeCloudRelayfileRepository as never }
      : {}),
    ensureCloudFleetSandbox: overrides.ensureCloudFleetSandbox as never,
    resolveWorkspaceSelection: () => ({
      key: 'rk_live_workspace',
      source: 'project',
      origin: path.join(overrides.projectRoot, '.agentworkforce', 'relay', 'workspace-key.json'),
      workspaceId: TARGET.workspaceId,
    }),
    persistWorkspaceRelaycastTarget: () => true,
    deleteCloudFleetSandbox: vi.fn(async () => undefined),
    sdk: {
      createAgentRelay: vi.fn(() => ({ messaging: { placement: { spawn: placement } } })) as never,
      createWorkspaceRelay: createWorkspaceRelay as never,
      createWorkspace: vi.fn() as never,
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error('__exit__');
      }) as never,
    },
    createFleetWorkspaceClient: vi.fn() as never,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return program;
}

function materialization(revision: string) {
  return {
    cloudWorkspaceId: 'cloud-workspace',
    repository: 'AgentWorkforce/relay',
    revision,
    filesWritten: 3,
    sourceProfile: 'complete-v1' as const,
    contentRoot: '/github/repos/AgentWorkforce/relay/contents',
    sentinelPath: '/github/repos/AgentWorkforce/relay/.relayfile/clone.json',
  };
}

describe('fleet sandbox command regressions', () => {
  it('documents local repo-relative cwd inference and absolute remote cwd overrides', () => {
    const program = registerSandboxCommand({
      projectRoot: temporaryDirectory('relay-fleet-help-'),
      resolveSandboxRepository: () => undefined,
      ensureCloudFleetSandbox: vi.fn(),
    });
    const fleet = program.commands.find((command) => command.name() === 'fleet');
    const spawn = fleet?.commands.find((command) => command.name() === 'spawn');
    const cwd = spawn?.options.find((option) => option.long === '--cwd');

    expect(cwd?.description).toContain('caller directory for local spawn');
    expect(cwd?.description).toContain('maps a local repo-relative path with --sandbox');
    expect(cwd?.description).toContain('selects a path on the remote node');
  });

  it('keeps the full /workspace Relayfile mount outside Git without materializing a repository', async () => {
    const outsideGit = temporaryDirectory('relay-fleet-outside-git-');
    const resolveRepository = vi.fn((projectRoot: string, requestedCwd: string | undefined) =>
      resolveSandboxRepository(projectRoot, requestedCwd, { cwd: () => outsideGit })
    );
    const materialize = vi.fn();
    const ensure = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      providerId: 'agent37' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-outside-git',
      nodeName: 'outside-git-node',
      sandboxId: 'sandbox-outside-git',
      providerSandboxId: 'provider-outside-git',
      relayWorkspaceId: TARGET.workspaceId,
      relaycastTarget: TARGET,
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
    }));
    const placement = vi.fn(async () => ({ invocationId: 'inv_outside_git' }));
    const program = registerSandboxCommand({
      projectRoot: outsideGit,
      resolveSandboxRepository: resolveRepository,
      materializeCloudRelayfileRepository: materialize,
      ensureCloudFleetSandbox: ensure,
      placement,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'agent37',
        '--workspace-id',
        TARGET.workspaceId,
        '--name',
        'outside-git-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_workspace',
      ],
      { from: 'user' }
    );

    expect(resolveRepository).toHaveBeenCalledWith(outsideGit, undefined);
    expect(materialize).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ mountRelayfile: true }));
    expect((ensure.mock.calls[0]?.[0] as Record<string, unknown>).relayfilePaths).toBeUndefined();
    expect(placement).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ worker_cwd: '/workspace' }) })
    );
  });

  it('re-materializes the current HEAD before resuming a retained live Relayfile sandbox', async () => {
    const projectRoot = temporaryDirectory('relay-fleet-live-resume-');
    const selection = {
      repository: 'AgentWorkforce/relay',
      repositoryName: 'relay',
      revision: REVISION,
      projectRoot,
      repositoryRelativeCwd: '',
      workerCwd: '/srv/agent-workforce/relay',
    };
    const events: string[] = [];
    const materialize = vi.fn(async () => {
      events.push('materialize');
      return materialization(REVISION);
    });
    const ensure = vi.fn(async () => {
      events.push('ensure');
      return {
        outcome: 'provisioned' as const,
        providerId: 'agent37' as const,
        cloudWorkspaceId: 'cloud-workspace',
        nodeId: 'node-retained',
        nodeName: 'retained-node',
        sandboxId: REPLAY_SANDBOX_ID,
        providerSandboxId: 'provider-retained',
        relayWorkspaceId: TARGET.workspaceId,
        relaycastTarget: TARGET,
        relayfileMounted: true,
        relayfileMountPath: '/workspace',
      };
    });
    const placement = vi.fn(async () => {
      events.push('spawn');
      return { invocationId: 'inv_live_resume' };
    });
    const program = registerSandboxCommand({
      projectRoot,
      resolveSandboxRepository: () => selection,
      materializeCloudRelayfileRepository: materialize,
      ensureCloudFleetSandbox: ensure,
      placement,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'agent37',
        '--sandbox-id',
        REPLAY_SANDBOX_ID,
        '--sandbox-name',
        REPLAY_SANDBOX_NAME,
        '--name',
        'retained-live-worker',
        '--task',
        'Resume',
        '--workspace-key',
        'rk_live_workspace',
      ],
      { from: 'user' }
    );

    expect(events).toEqual(['materialize', 'ensure', 'spawn']);
    expect(materialize).toHaveBeenCalledWith({
      workspaceId: TARGET.workspaceId,
      repository: selection.repository,
      revision: REVISION,
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: REPLAY_SANDBOX_ID,
        name: REPLAY_SANDBOX_NAME,
        mountRelayfile: true,
      })
    );
    const ensureInput = ensure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ensureInput.repos).toBeUndefined();
    expect(ensureInput.repoRevisions).toBeUndefined();
  });

  it('keeps retained checkout resumes pinned to the exact current revision', async () => {
    const projectRoot = temporaryDirectory('relay-fleet-checkout-resume-');
    const selection = {
      repository: 'AgentWorkforce/relay',
      repositoryName: 'relay',
      revision: REVISION,
      projectRoot,
      repositoryRelativeCwd: '',
      workerCwd: '/srv/agent-workforce/relay',
    };
    const ensure = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      providerId: 'agent37' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-retained-checkout',
      nodeName: 'retained-checkout-node',
      sandboxId: REPLAY_SANDBOX_ID,
      providerSandboxId: 'provider-retained-checkout',
      relayWorkspaceId: TARGET.workspaceId,
      relaycastTarget: TARGET,
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
      repoRevisions: { [selection.repository]: REVISION },
    }));
    const materialize = vi.fn();
    const program = registerSandboxCommand({
      projectRoot,
      resolveSandboxRepository: () => selection,
      materializeCloudRelayfileRepository: materialize,
      ensureCloudFleetSandbox: ensure,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--checkout',
        '--sandbox-provider',
        'agent37',
        '--sandbox-id',
        REPLAY_SANDBOX_ID,
        '--sandbox-name',
        REPLAY_SANDBOX_NAME,
        '--name',
        'retained-checkout-worker',
        '--task',
        'Resume',
        '--workspace-key',
        'rk_live_workspace',
      ],
      { from: 'user' }
    );

    expect(materialize).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: [selection.repository],
        repoRevisions: { [selection.repository]: REVISION },
      })
    );
  });
});
