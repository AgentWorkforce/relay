import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { REMOVED_CLOUD_ROOM_COMMANDS, registerCloudRoomCommands } from './cloud-room.js';

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
  const cloud = program.command('cloud');
  registerCloudRoomCommands(cloud, { error, exit });
  return { program, cloud, error, exit };
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

describe('relay cloud room', () => {
  it('stays routable but is hidden from help', () => {
    const { cloud } = harness();
    const room = cloud.commands.find((command) => command.name() === 'room');
    expect(room).toBeDefined();
    expect((room as unknown as { _hidden: boolean })._hidden).toBe(true);
    expect(cloud.helpInformation()).not.toMatch(/\broom\b/);
  });

  it.each(REMOVED_CLOUD_ROOM_COMMANDS.map((verb) => [verb]))(
    '`cloud room %s` explains the removal and points to Relay Connect',
    async (verb) => {
      const { program, error } = harness();
      const code = await run(program, ['cloud', 'room', verb, '--workspace', 'rw_abcdefgh', '--json']);
      expect(code).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      const message = String(error.mock.calls[0][0]);
      expect(message).toContain(`'relay cloud room ${verb}' was removed`);
      expect(message).toContain('Relay Connect');
      expect(message).toContain('create_connect');
      expect(message).toContain('npx -y @agent-relay/connect join <link>');
    }
  );

  it('answers a bare `cloud room` and `--help` with the same notice', async () => {
    for (const args of [
      ['cloud', 'room'],
      ['cloud', 'room', '--help'],
    ]) {
      const { program, error } = harness();
      const code = await run(program, args);
      expect(code).toBe(1);
      expect(String(error.mock.calls[0][0])).toContain("'relay cloud room' was removed");
    }
  });

  it('never calls the Cloud API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { program } = harness();
    await run(program, ['cloud', 'room', 'members', '--workspace', 'rw_abcdefgh']);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
