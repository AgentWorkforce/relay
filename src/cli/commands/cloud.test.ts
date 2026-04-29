import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cloudMocks = vi.hoisted(() => ({
  runWorkflow: vi.fn(),
  getRunStatus: vi.fn(),
  syncWorkflowPatch: vi.fn(),
}));

vi.mock('@agent-relay/cloud', () => ({
  AUTH_FILE_PATH: '/tmp/cloud-auth.json',
  REFRESH_WINDOW_MS: 60_000,
  authorizedApiFetch: vi.fn(),
  cancelWorkflow: vi.fn(),
  clearStoredAuth: vi.fn(),
  defaultApiUrl: () => 'https://cloud.test',
  ensureAuthenticated: vi.fn(),
  getRunLogs: vi.fn(),
  getRunStatus: (...args: unknown[]) => cloudMocks.getRunStatus(...args),
  readStoredAuth: vi.fn(),
  runWorkflow: (...args: unknown[]) => cloudMocks.runWorkflow(...args),
  syncWorkflowPatch: (...args: unknown[]) => cloudMocks.syncWorkflowPatch(...args),
}));

vi.mock('@agent-relay/telemetry', () => ({
  track: vi.fn(),
}));

import { registerCloudCommands, type CloudDependencies } from './cloud.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function createHarness() {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as CloudDependencies['exit'];

  const deps: CloudDependencies = {
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
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
    expect(cloud?.commands.map((command) => command.name())).toEqual([
      'login',
      'logout',
      'whoami',
      'connect',
      'run',
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
});
