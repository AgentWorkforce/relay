import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerSetupCommands, type SetupDependencies } from './setup.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createHarness(overrides: Partial<SetupDependencies> = {}) {
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as SetupDependencies['exit'];

  const deps: SetupDependencies = {
    runInit: vi.fn(async () => undefined),
    runTelemetry: vi.fn(async () => undefined),
    runYamlWorkflow: vi.fn(async () => ({ status: 'completed' })),
    runScriptWorkflow: vi.fn(() => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    ...overrides,
  };

  const program = new Command();
  registerSetupCommands(program, deps);

  return { program, deps };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

describe('registerSetupCommands', () => {
  it('registers setup commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining(['init', 'setup', 'telemetry', 'run']));
  });

  it('routes both init and setup alias to runInit', async () => {
    const { program, deps } = createHarness();

    await runCommand(program, ['init', '--yes', '--skip-broker']);
    await runCommand(program, ['setup', '--yes']);

    expect((deps.runInit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      yes: true,
      skipBroker: true,
    });
    expect((deps.runInit as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toMatchObject({
      yes: true,
    });
  });

  it('routes telemetry action', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['telemetry', 'enable']);

    expect(exitCode).toBeUndefined();
    expect(deps.runTelemetry).toHaveBeenCalledWith('enable');
  });

  it('routes run command based on file extension', async () => {
    const { program, deps } = createHarness();

    await runCommand(program, ['run', 'workflow.yaml', '--workflow', 'main']);
    await runCommand(program, ['run', 'workflow.py']);

    expect(deps.runYamlWorkflow).toHaveBeenCalledWith('workflow.yaml', {
      workflow: 'main',
      onEvent: expect.any(Function),
    });
    expect(deps.runScriptWorkflow).toHaveBeenCalledWith('workflow.py');
  });

  it('exits with code 1 for unsupported run file extension', async () => {
    const { program } = createHarness();

    const exitCode = await runCommand(program, ['run', 'workflow.txt']);

    expect(exitCode).toBe(1);
  });
});
