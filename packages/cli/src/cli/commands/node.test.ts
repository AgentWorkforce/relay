import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { REMOVED_BROKER_COMMANDS, registerNodeCommands, registerRemovedBrokerCommands } from './node.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function harness() {
  const error = vi.fn();
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as (code: number) => never;
  const program = new Command();
  program.exitOverride();
  registerNodeCommands(program, { error, exit });
  return { program, error, exit };
}

async function run(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

describe('relay node', () => {
  it('keeps the workflow commands and hides the removed broker verbs', () => {
    const { program } = harness();
    const node = program.commands.find((command) => command.name() === 'node')!;
    const workflow = node.commands.find((command) => command.name() === 'workflow')!;
    expect(workflow.commands.map((command) => command.name()).sort()).toEqual(['logs', 'run', 'sync']);
    for (const name of REMOVED_BROKER_COMMANDS) {
      const command = node.commands.find((candidate) => candidate.name() === name);
      expect(command, name).toBeDefined();
      expect((command as unknown as { _hidden: boolean })._hidden).toBe(true);
    }
    expect(node.helpInformation()).not.toMatch(/\bup\b|deadletters|redeliver/);
  });

  it.each([
    ['up', '--broker-name', 'n', '--background'],
    ['down', '--force'],
    ['status', '--wait-for', '5'],
    ['metrics', '--agent', 'a'],
    ['deadletters', '--json'],
    ['redeliver', '--all'],
    ['agent', 'spawn', 'claude', '--name', 'w'],
    ['agent', 'attach', 'w'],
    ['tail', 'w'],
  ])('`node %s` explains the removal and points to relay init', async (...args) => {
    const { program, error } = harness();
    const code = await run(program, ['node', ...args]);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]![0]);
    expect(message).toContain(`'relay node ${args[0]}' was removed together with the local broker`);
    expect(message).toContain("'relay init'");
    expect(message).toContain("'agent-relay init'");
    expect(message).toContain("'relay init --hosted'");
  });

  it('serves the same notice on the deprecated `local` alias', async () => {
    const error = vi.fn();
    const exit = vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as (code: number) => never;
    const program = new Command();
    program.exitOverride();
    const local = program.command('local');
    registerRemovedBrokerCommands(local, { error, exit });
    expect(await run(program, ['local', 'up'])).toBe(1);
    expect(String(error.mock.calls[0]![0])).toContain("'relay local up' was removed");
  });
});
