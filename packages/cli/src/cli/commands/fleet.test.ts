import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerFleetCommands } from './fleet.js';

describe('fleet command support', () => {
  it.each([
    ['config', 'get', undefined],
    ['enable', 'set', true],
    ['disable', 'set', false],
    ['inherit', 'inherit', undefined],
  ] as const)('fleet %s delegates to workspace fleet node config API', async (command, method, value) => {
    const fleetNodes = {
      get: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
      set: vi.fn(async (enabled: boolean) => ({ enabled, defaultEnabled: false, override: enabled })),
      inherit: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
    };
    const createWorkspaceRelay = vi.fn(() => ({ workspace: { fleetNodes } }));
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn(() => {
          throw new Error('__exit__');
        }) as never,
      },
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      ['fleet', command, '--workspace-key', 'rk_live_test', '--base-url', 'https://relay.example'],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: 'https://relay.example',
    });
    if (method === 'set') {
      expect(fleetNodes.set).toHaveBeenCalledWith(value);
    } else {
      expect(fleetNodes[method]).toHaveBeenCalledTimes(1);
    }
    expect(JSON.parse(logs[0]!)).toMatchObject({
      enabled: method === 'set' ? value : false,
      defaultEnabled: false,
    });
  });

  it('registers `fleet serve` as a hidden stub that prints migration guidance and exits 1', async () => {
    const errors: string[] = [];
    const exit = vi.fn(() => {
      throw new Error('__exit__');
    });
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      error: (...args: unknown[]) => errors.push(args.join(' ')),
      log: () => undefined,
      warn: () => undefined,
      exit: exit as never,
    });

    const fleet = program.commands.find((command) => command.name() === 'fleet');
    const serve = fleet?.commands.find((command) => command.name() === 'serve');
    expect(serve).toBeDefined();
    expect((serve as unknown as { _hidden?: boolean })._hidden).toBe(true);

    await program.parseAsync(['fleet', 'serve', 'some-file.ts', '--enrollment-token', 'x'], {
      from: 'user',
    }).catch(() => undefined);

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toMatch(/'fleet serve' has been replaced/);
    expect(errors.join('\n')).toMatch(/relay node up/);
    expect(errors.join('\n')).toMatch(/relay cloud enroll/);
  });
});
