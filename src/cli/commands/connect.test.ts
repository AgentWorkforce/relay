import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerConnectCommands, type ConnectDependencies } from './connect.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createHarness(overrides: Partial<ConnectDependencies> = {}) {
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as ConnectDependencies['exit'];

  const deps: ConnectDependencies = {
    cwd: vi.fn(() => '/tmp/project'),
    readFileSync: vi.fn(() => ''),
    env: vi.fn(() => ({})),
    runSdkConnect: vi.fn(async () => undefined),
    runCodexWebsocketConnect: vi.fn(async () => undefined),
    runHostedSdkConnect: vi.fn(async () => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    ...overrides,
  };

  const program = new Command();
  registerConnectCommands(program, deps);

  return {
    program,
    deps,
  };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (error) {
    if (error instanceof ExitSignal) {
      return error.code;
    }
    throw error;
  }
}

describe('registerConnectCommands', () => {
  it('registers connect command', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain('connect');
  });

  it('uses sdk path by default', async () => {
    const { program, deps } = createHarness();
    const exitCode = await runCommand(program, ['connect', 'codex', '--task', 'Ship tests']);

    expect(exitCode).toBeUndefined();
    expect(deps.runSdkConnect).toHaveBeenCalledWith({
      provider: 'codex',
      cwd: '/tmp/project',
      timeoutMs: 30000,
      model: 'gpt-5.1-codex',
      task: 'Ship tests',
    });
    expect(deps.runCodexWebsocketConnect).not.toHaveBeenCalled();
  });

  it('routes websocket path to codex websocket connector and merges hooks', async () => {
    const readFileSync = vi.fn(
      () => `
hooks:
  codex:
    on_turn_complete:
      - echo "file-hook"
`
    );

    const { program, deps } = createHarness({ readFileSync });
    const exitCode = await runCommand(program, [
      'connect',
      'codex',
      '--path',
      'websocket',
      '--endpoint',
      'ws://127.0.0.1:4600',
      '--hooks-file',
      '/tmp/hooks.yaml',
      '--hook',
      'turn/completed=echo "flag-hook"',
      '--task',
      'Hello',
    ]);

    expect(exitCode).toBeUndefined();
    expect(deps.runCodexWebsocketConnect).toHaveBeenCalledWith({
      endpoint: 'ws://127.0.0.1:4600',
      cwd: '/tmp/project',
      model: 'gpt-5.1-codex',
      timeoutMs: 30000,
      task: 'Hello',
      spawnAppServer: undefined,
      hooks: {
        on_turn_complete: ['echo "file-hook"'],
        'turn/completed': ['echo "flag-hook"'],
      },
    });
    expect(deps.runSdkConnect).not.toHaveBeenCalled();
  });

  it('rejects websocket path for unsupported providers', async () => {
    const { program, deps } = createHarness();
    const exitCode = await runCommand(program, ['connect', 'claude', '--path', 'websocket']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('websocket path currently supports only codex');
  });

  it('routes hosted mode to hosted sdk connector', async () => {
    const { program, deps } = createHarness({
      env: vi.fn(() => ({
        RELAY_API_KEY: 'rk_live_test',
      })),
    });
    const exitCode = await runCommand(program, [
      'connect',
      '--hosted',
      '--channel',
      'control',
      '--agent-name',
      'relay-connect-wt',
      '--allow-cli',
      'codex',
      '--allow-cli',
      'claude',
    ]);

    expect(exitCode).toBeUndefined();
    expect(deps.runHostedSdkConnect).toHaveBeenCalledWith({
      apiKey: 'rk_live_test',
      baseUrl: 'https://api.relaycast.dev',
      agentName: 'relay-connect-wt',
      channel: 'control',
      cwd: '/tmp/project',
      timeoutMs: 30000,
      allowedClis: ['codex', 'claude'],
    });
    expect(deps.runSdkConnect).not.toHaveBeenCalled();
    expect(deps.runCodexWebsocketConnect).not.toHaveBeenCalled();
  });
});
