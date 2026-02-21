import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAuthCommand } from '../lib/auth-ssh.js';
import { registerAuthCommands, type AuthDependencies } from './auth.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createExitMock() {
  return vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as AuthDependencies['exit'];
}

function createHarness(overrides: Partial<AuthDependencies> = {}) {
  const deps: AuthDependencies = {
    runAuth: vi.fn(async () => undefined),
    defaultCloudUrl: 'https://agent-relay.test',
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit: createExitMock(),
    ...overrides,
  };

  const program = new Command();
  registerAuthCommands(program, deps);

  return { program, deps };
}

function createIo() {
  return {
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }),
  };
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

async function runWithTty<T>(work: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

  try {
    return await work();
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerAuthCommands', () => {
  it('registers auth commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining(['auth']));
  });

  it('routes auth command to runAuth dependency', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(
      ['auth', 'claude', '--workspace', 'wk_123', '--cloud-url', 'https://cloud.example', '--timeout', '180'],
      { from: 'user' }
    );

    expect(deps.runAuth).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        workspace: 'wk_123',
        cloudUrl: 'https://cloud.example',
        timeout: '180',
      })
    );
  });
});

describe('auth command flows', () => {
  it('exits with code 1 for invalid provider', async () => {
    const io = createIo();

    const exitCode = await runWithTty(async () => {
      try {
        await runAuthCommand('invalid-provider', { timeout: '60', token: 'tok_live' }, io);
        return undefined;
      } catch (err) {
        if (err instanceof ExitSignal) return err.code;
        throw err;
      }
    });

    expect(exitCode).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Unknown provider: invalid-provider'));
  });

  it('exits with code 1 when SSH connection fails', async () => {
    const io = createIo();

    class FailingClient extends EventEmitter {
      connect(): void {
        queueMicrotask(() => {
          this.emit('error', new Error('ECONNREFUSED'));
        });
      }

      end(): void {
        // noop
      }
    }

    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            sessionId: 'sess_1',
            workspaceId: 'wk_ssh_fail',
            ssh: {
              host: 'localhost',
              port: 2222,
              user: 'workspace',
              password: 'secret',
            },
          }),
        }) as unknown as Response
    );

    const exitCode = await runWithTty(async () => {
      try {
        await runAuthCommand('codex', { timeout: '60', token: 'tok_live' }, io, {
          fetch: fetchMock,
          loadSSH2: vi.fn(async () => ({ Client: FailingClient }) as unknown as typeof import('ssh2')),
        });
        return undefined;
      } catch (err) {
        if (err instanceof ExitSignal) return err.code;
        throw err;
      }
    });

    expect(exitCode).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Failed to connect via SSH'));
  });
});
