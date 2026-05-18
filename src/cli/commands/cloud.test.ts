import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cloudMocks = vi.hoisted(() => ({
  runWorkflow: vi.fn(),
  scheduleWorkflow: vi.fn(),
  listWorkflowSchedules: vi.fn(),
  getRunStatus: vi.fn(),
  syncWorkflowPatch: vi.fn(),
}));

const connectProviderMock = vi.hoisted(() => vi.fn());

vi.mock('@agent-relay/cloud', () => ({
  AUTH_FILE_PATH: '/tmp/cloud-auth.json',
  REFRESH_WINDOW_MS: 60_000,
  authorizedApiFetch: vi.fn(),
  cancelWorkflow: vi.fn(),
  clearStoredAuth: vi.fn(),
  connectProvider: (...args: unknown[]) => connectProviderMock(...args),
  defaultApiUrl: () => 'https://cloud.test',
  ensureAuthenticated: vi.fn(),
  getProviderHelpText: () =>
    'anthropic (alias: claude), openai (alias: codex), google (alias: gemini), cursor, opencode, droid',
  getRunLogs: vi.fn(),
  getRunStatus: (...args: unknown[]) => cloudMocks.getRunStatus(...args),
  listWorkflowSchedules: (...args: unknown[]) => cloudMocks.listWorkflowSchedules(...args),
  normalizeProvider: (provider: string) => {
    const lower = provider.toLowerCase().trim();
    const aliases: Record<string, string> = {
      claude: 'anthropic',
      codex: 'openai',
      gemini: 'google',
    };
    return aliases[lower] ?? lower;
  },
  readStoredAuth: vi.fn(),
  runWorkflow: (...args: unknown[]) => cloudMocks.runWorkflow(...args),
  scheduleWorkflow: (...args: unknown[]) => cloudMocks.scheduleWorkflow(...args),
  syncWorkflowPatch: (...args: unknown[]) => cloudMocks.syncWorkflowPatch(...args),
}));

vi.mock('@agent-relay/telemetry', () => ({
  track: vi.fn(),
}));

import { buildCloudSyncPatchExcludeArgs, registerCloudCommands, type CloudDependencies } from './cloud.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function createHarness(overrides: Partial<CloudDependencies> = {}) {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as CloudDependencies['exit'];

  const deps: CloudDependencies = {
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    ...overrides,
  };

  const program = new Command();
  program.exitOverride();
  registerCloudCommands(program, deps);

  return { program, deps };
}

describe('registerCloudCommands', () => {
  it('registers cloud subcommands on the program', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');

    expect(cloud).toBeDefined();
    expect(cloud?.description()).toContain('skill install');
    expect(cloud?.commands.map((command) => command.name())).toEqual([
      'login',
      'logout',
      'whoami',
      'connect',
      'run',
      'schedule',
      'schedules',
      'status',
      'logs',
      'sync',
      'cancel',
    ]);
  });

  it('connect requires a provider argument', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const connect = cloud?.commands.find((command) => command.name() === 'connect');

    expect(connect).toBeDefined();
    expect(connect?.description()).toContain('interactive SSH session');
    expect(connect?.registeredArguments[0]?.argChoices).toBeUndefined();
    expect(connect?.registeredArguments[0]?.description).toContain('anthropic (alias: claude)');
    expect(connect?.registeredArguments[0]?.description).toContain('openai (alias: codex)');
    expect(connect?.registeredArguments[0]?.description).toContain('google (alias: gemini)');
  });

  it('run requires a workflow argument', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const run = cloud?.commands.find((command) => command.name() === 'run');

    expect(run).toBeDefined();
    expect(run?.description()).toContain('workflow run');
    const optionNames = run?.options.map((option) => option.long);
    expect(optionNames).toContain('--resume');
    expect(optionNames).toContain('--start-from');
    expect(optionNames).toContain('--previous-run-id');
  });

  it('status requires a runId argument', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const status = cloud?.commands.find((command) => command.name() === 'status');

    expect(status).toBeDefined();
    expect(status?.description()).toContain('workflow run status');
    const optionNames = status?.options.map((option) => option.long);
    expect(optionNames).toContain('--json');
  });

  it('schedule creates repeatable workflow schedules', async () => {
    const { program, deps } = createHarness();
    cloudMocks.scheduleWorkflow.mockResolvedValueOnce({
      id: 'sched-1',
      name: 'Hourly eval',
      scheduleType: 'cron',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      status: 'active',
      lastTriggeredRunId: null,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'schedule',
      'workflow.yaml',
      '--cron',
      '0 * * * *',
      '--name',
      'Hourly eval',
    ]);

    expect(cloudMocks.scheduleWorkflow).toHaveBeenCalledWith(
      'workflow.yaml',
      expect.objectContaining({
        cron: '0 * * * *',
        name: 'Hourly eval',
      })
    );
    expect(deps.log).toHaveBeenCalledWith('Schedule created: sched-1');
  });

  it('schedule creates one-time workflow schedules', async () => {
    const { program, deps } = createHarness();
    cloudMocks.scheduleWorkflow.mockResolvedValueOnce({
      id: 'sched-at-1',
      name: 'One-off eval',
      scheduleType: 'once',
      scheduledAt: '2026-05-10T09:00:00.000Z',
      timezone: 'UTC',
      status: 'active',
      lastTriggeredRunId: null,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'schedule',
      'workflow.yaml',
      '--at',
      '2026-05-10T09:00:00Z',
      '--name',
      'One-off eval',
    ]);

    expect(cloudMocks.scheduleWorkflow).toHaveBeenCalledWith(
      'workflow.yaml',
      expect.objectContaining({
        at: '2026-05-10T09:00:00Z',
        name: 'One-off eval',
      })
    );
    expect(cloudMocks.scheduleWorkflow.mock.calls[0][1]).not.toHaveProperty('cron');
    expect(deps.log).toHaveBeenCalledWith('Schedule created: sched-at-1');
  });

  it('schedules lists repeatable workflow schedules', async () => {
    const { program, deps } = createHarness();
    cloudMocks.listWorkflowSchedules.mockResolvedValueOnce([
      {
        id: 'sched-1',
        name: 'Hourly eval',
        scheduleType: 'cron',
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        status: 'active',
        lastTriggeredRunId: 'run-1',
      },
    ]);

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'schedules']);

    expect(cloudMocks.listWorkflowSchedules).toHaveBeenCalledWith(expect.objectContaining({}));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('sched-1'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('run-1'));
  });

  it('logs has --follow and --poll-interval options', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const logs = cloud?.commands.find((command) => command.name() === 'logs');

    expect(logs).toBeDefined();
    const optionNames = logs?.options.map((option) => option.long);
    expect(optionNames).toContain('--follow');
    expect(optionNames).toContain('--poll-interval');
  });

  it('sync has --dry-run option', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const sync = cloud?.commands.find((command) => command.name() === 'sync');

    expect(sync).toBeDefined();
    const optionNames = sync?.options.map((option) => option.long);
    expect(optionNames).toContain('--dry-run');
  });

  it('sync excludes volatile workflow bookkeeping files when applying patches', () => {
    const args = buildCloudSyncPatchExcludeArgs();

    expect(args).toContain('--exclude=".agent-bin/**"');
    expect(args).toContain('--exclude=".relayfile.acl"');
    expect(args).toContain('--exclude=".relayfile-mount-state.json"');
    expect(args).toContain('--exclude=".relayfile-mount-state.json.tmp-*"');
    expect(args).toContain('--exclude=".trajectories/**"');
    expect(args).toContain('--exclude=".workflow-context/**"');
  });

  it('registers cloud cancel subcommand', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const cancel = cloud?.commands.find((command) => command.name() === 'cancel');

    expect(cancel).toBeDefined();
    expect(cancel?.registeredArguments[0]?.required).toBe(true);
    expect(cancel?.registeredArguments[0]?.name()).toBe('runId');
  });

  it('cloud run renders pushed PR and push errors for patches', async () => {
    const { program, deps } = createHarness();
    cloudMocks.runWorkflow.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'completed',
      patches: {
        cloud: {
          s3Key: 'user/run/changes-cloud.patch',
          pushedTo: {
            branch: 'agent-relay/run-run-1',
            prUrl: 'https://github.com/acme/cloud/pull/12',
            sha: 'abc123',
            base: { branch: 'main', sha: 'base123' },
          },
        },
        relay: {
          s3Key: 'user/run/changes-relay.patch',
          pushError: {
            code: 'base_branch_moved',
            message: 'Base branch moved',
          },
        },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'run', 'workflow.yaml']);

    expect(deps.log).toHaveBeenCalledWith('Patches:');
    expect(deps.log).toHaveBeenCalledWith(
      '  cloud: https://github.com/acme/cloud/pull/12 (agent-relay/run-run-1)'
    );
    expect(deps.log).toHaveBeenCalledWith('  relay: push failed: base_branch_moved: Base branch moved');
  });

  it('cloud sync refuses to apply multi-path responses (no silent data loss)', async () => {
    const { program, deps } = createHarness();
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      patches: {
        cloud: { patch: 'diff --git a/x b/x\n', hasChanges: true },
        relay: { patch: 'diff --git a/y b/y\n', hasChanges: true },
      },
    });

    await expect(program.parseAsync(['node', 'agent-relay', 'cloud', 'sync', 'run-42'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('2 per-path patches (cloud, relay)'));
    expect(deps.log).not.toHaveBeenCalledWith('No changes to sync — the workflow did not modify any files.');
  });

  it('cloud sync --dry-run prints each multi-path patch', async () => {
    const { program, deps } = createHarness();
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      patches: {
        cloud: { patch: 'CLOUD_PATCH_BODY', hasChanges: true },
        relay: { patch: '', hasChanges: false },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'sync', 'run-42', '--dry-run']);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Patch for "cloud" (dry run)'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('Patch for "relay"'));
  });

  it('cloud sync reports no-changes when multi-path response has all empty patches', async () => {
    const { program, deps } = createHarness();
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      patches: {
        cloud: { patch: '', hasChanges: false },
        relay: { patch: '', hasChanges: false },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'sync', 'run-42']);

    expect(deps.log).toHaveBeenCalledWith('No changes to sync — the workflow did not modify any files.');
  });

  it('cloud status renders pending patch push state', async () => {
    const { program, deps } = createHarness();
    cloudMocks.getRunStatus.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'completed',
      patches: {
        cloud: {
          s3Key: 'user/run/changes-cloud.patch',
        },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'status', 'run-1']);

    expect(deps.log).toHaveBeenCalledWith('Patches:');
    expect(deps.log).toHaveBeenCalledWith('  cloud: patch pending - run still active');
  });

  describe('cloud connect spawn-cloud-swarm skill drop', () => {
    it('invokes installSkill exactly once for provider=claude', async () => {
      const installSkill = vi.fn(async () => ({
        installed: true,
        destPath: '/tmp/.claude/skills/spawn-cloud-swarm/SKILL.md',
      }));
      const resolveBundledSkillPath = vi.fn((name: string) => `/bundle/${name}/SKILL.md`);
      connectProviderMock.mockResolvedValueOnce({ success: true });

      const { program, deps } = createHarness({
        installSkill,
        resolveBundledSkillPath,
        skillsDestRoot: '/tmp/.claude/skills',
      });

      await program.parseAsync(['node', 'agent-relay', 'cloud', 'connect', 'claude']);

      expect(installSkill).toHaveBeenCalledTimes(1);
      expect(installSkill).toHaveBeenCalledWith({
        src: '/bundle/spawn-cloud-swarm/SKILL.md',
        destRoot: '/tmp/.claude/skills',
        skillName: 'spawn-cloud-swarm',
      });
      expect(resolveBundledSkillPath).toHaveBeenCalledWith('spawn-cloud-swarm');
      expect(deps.log).toHaveBeenCalledWith(
        'Installed skill: /tmp/.claude/skills/spawn-cloud-swarm/SKILL.md'
      );
    });

    it('does NOT invoke installSkill for other providers', async () => {
      const installSkill = vi.fn();
      const resolveBundledSkillPath = vi.fn((name: string) => `/bundle/${name}/SKILL.md`);
      connectProviderMock.mockResolvedValueOnce({ success: true });

      const { program } = createHarness({
        installSkill,
        resolveBundledSkillPath,
        skillsDestRoot: '/tmp/.claude/skills',
      });

      await program.parseAsync(['node', 'agent-relay', 'cloud', 'connect', 'codex']);

      expect(installSkill).not.toHaveBeenCalled();
      expect(resolveBundledSkillPath).not.toHaveBeenCalled();
    });

    it('does NOT install skill when connect itself fails (success=false)', async () => {
      const installSkill = vi.fn();
      const resolveBundledSkillPath = vi.fn((name: string) => `/bundle/${name}/SKILL.md`);
      connectProviderMock.mockResolvedValueOnce({ success: false });

      const { program } = createHarness({
        installSkill,
        resolveBundledSkillPath,
        skillsDestRoot: '/tmp/.claude/skills',
      });

      await program.parseAsync(['node', 'agent-relay', 'cloud', 'connect', 'claude']);

      expect(installSkill).not.toHaveBeenCalled();
    });

    it('connect still succeeds when skill install throws (warning is logged)', async () => {
      const installSkill = vi.fn(async () => {
        throw new Error('disk full');
      });
      const resolveBundledSkillPath = vi.fn((name: string) => `/bundle/${name}/SKILL.md`);
      connectProviderMock.mockResolvedValueOnce({ success: true });

      const { program, deps } = createHarness({
        installSkill,
        resolveBundledSkillPath,
        skillsDestRoot: '/tmp/.claude/skills',
      });

      await expect(
        program.parseAsync(['node', 'agent-relay', 'cloud', 'connect', 'claude'])
      ).resolves.toBeDefined();

      expect(installSkill).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining('warning: failed to install spawn-cloud-swarm skill')
      );
    });

    it('describes the skill drop in `cloud connect --help` text', () => {
      const { program } = createHarness();
      const cloud = program.commands.find((command) => command.name() === 'cloud');
      const connect = cloud?.commands.find((command) => command.name() === 'connect');

      expect(connect?.description()).toContain('spawn-cloud-swarm');
      expect(connect?.description()).toContain('~/.claude/skills');
    });
  });
});
