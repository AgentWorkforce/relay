import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerCloudCommands, type CloudDependencies } from './cloud.js';

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
});
