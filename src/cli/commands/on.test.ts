import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedModules = vi.hoisted(() => ({
  checkPrereqs: vi.fn(async () => undefined),
  scanPermissions: vi.fn(async () => undefined),
  goOnTheRelay: vi.fn(async () => undefined),
  goOffTheRelay: vi.fn(async () => undefined),
}));

vi.mock('./on/prereqs.js', () => ({ checkPrereqs: mockedModules.checkPrereqs }));
vi.mock('./on/scan.js', () => ({ scanPermissions: mockedModules.scanPermissions }));
vi.mock('./on/start.js', () => ({ goOnTheRelay: mockedModules.goOnTheRelay }));
vi.mock('./on/stop.js', () => ({ goOffTheRelay: mockedModules.goOffTheRelay }));

import { registerOnCommands, type OnDependencies } from './on.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createHarness(overrides: Partial<OnDependencies> = {}) {
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as OnDependencies['exit'];

  const deps: OnDependencies = {
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    ...overrides,
  };

  const program = new Command();
  program.exitOverride();
  registerOnCommands(program, deps);

  return { program, deps };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (error) {
    if (error instanceof ExitSignal) {
      return error.code;
    }
    if (typeof (error as { exitCode?: number }).exitCode === 'number') {
      return (error as { exitCode: number }).exitCode;
    }
    throw error;
  }
}

describe('registerOnCommands', () => {
  beforeEach(() => {
    mockedModules.checkPrereqs.mockClear();
    mockedModules.scanPermissions.mockClear();
    mockedModules.goOnTheRelay.mockClear();
    mockedModules.goOffTheRelay.mockClear();
  });

  it('registers the workspace join option on the on command', () => {
    const { program } = createHarness();
    const on = program.commands.find((command) => command.name() === 'on');

    expect(on).toBeDefined();
    expect(on?.options.map((option) => option.long)).toContain('--workspace');
  });

  it('passes the workspace id through to goOnTheRelay', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, [
      'on',
      'claude',
      '--workspace',
      'rw_a7f3x9k2',
      '--',
      '--print',
    ]);

    expect(exitCode).toBeUndefined();
    expect(mockedModules.goOnTheRelay).toHaveBeenCalledTimes(1);
    expect(mockedModules.goOnTheRelay).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ workspace: 'rw_a7f3x9k2' }),
      expect.arrayContaining(['--print']),
      deps,
    );
  });
});
