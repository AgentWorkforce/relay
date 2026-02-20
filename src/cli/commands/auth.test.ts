import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliAuthCommand } from '../lib/auth-cli.js';
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
    runCliAuth: vi.fn(async () => undefined),
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

    expect(commandNames).toEqual(
      expect.arrayContaining(['auth', 'cli-auth', 'codex-auth', 'claude-auth', 'cursor-auth'])
    );
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

  it('routes cli-auth command to runCliAuth with provider argument', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(['cli-auth', 'codex', '--workspace', 'wk_456', '--token', 'tok_abc'], {
      from: 'user',
    });

    expect(deps.runCliAuth).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        workspace: 'wk_456',
        token: 'tok_abc',
        cloudUrl: 'https://agent-relay.test',
        timeout: '300',
      })
    );
  });

  it('routes codex-auth, claude-auth, and cursor-auth aliases to cli-auth providers', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(['codex-auth', '--workspace', 'wk_1', '--token', 'tok1'], { from: 'user' });
    await program.parseAsync(['claude-auth', '--workspace', 'wk_2', '--token', 'tok2'], { from: 'user' });
    await program.parseAsync(['cursor-auth', '--workspace', 'wk_3', '--token', 'tok3'], { from: 'user' });

    expect(deps.runCliAuth).toHaveBeenNthCalledWith(
      1,
      'codex',
      expect.objectContaining({ workspace: 'wk_1', token: 'tok1' })
    );
    expect(deps.runCliAuth).toHaveBeenNthCalledWith(
      2,
      'claude',
      expect.objectContaining({ workspace: 'wk_2', token: 'tok2' })
    );
    expect(deps.runCliAuth).toHaveBeenNthCalledWith(
      3,
      'cursor',
      expect.objectContaining({ workspace: 'wk_3', token: 'tok3' })
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

    const fetchMock = vi.fn(async () => ({
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
    }) as unknown as Response);

    const exitCode = await runWithTty(async () => {
      try {
        await runAuthCommand(
          'codex',
          { timeout: '60', token: 'tok_live' },
          io,
          {
            fetch: fetchMock,
            loadSSH2: vi.fn(async () => ({ Client: FailingClient } as unknown as typeof import('ssh2'))),
          }
        );
        return undefined;
      } catch (err) {
        if (err instanceof ExitSignal) return err.code;
        throw err;
      }
    });

    expect(exitCode).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Failed to connect via SSH'));
  });

  it('exits with code 1 when cli-auth is missing workspace', async () => {
    const io = createIo();

    let exitCode: number | undefined;
    try {
      await runCliAuthCommand(
        'codex',
        {
          cloudUrl: 'https://agent-relay.test',
          token: 'tok_live',
          timeout: '60',
        },
        io
      );
    } catch (err) {
      if (err instanceof ExitSignal) {
        exitCode = err.code;
      } else {
        throw err;
      }
    }

    expect(exitCode).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Missing --workspace parameter.'));
  });

  it('completes cli-auth flow successfully', async () => {
    const io = createIo();

    class ReadyClient extends EventEmitter {
      connect(): void {
        queueMicrotask(() => {
          this.emit('ready');
        });
      }

      forwardOut(
        _srcIP: string,
        _srcPort: number,
        _dstIP: string,
        _dstPort: number,
        callback: (err: Error | undefined, stream: NodeJS.ReadWriteStream) => void
      ): void {
        callback(undefined, new EventEmitter() as unknown as NodeJS.ReadWriteStream);
      }

      end(): void {
        // noop
      }
    }

    const mockServer = {
      on: vi.fn(function () {
        return this;
      }),
      listen: vi.fn(function (_port: number, _host: string, callback: () => void) {
        callback();
        return this;
      }),
      close: vi.fn(() => undefined),
    };

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes('/tunnel-info/')) {
        return {
          ok: true,
          json: async () => ({
            host: 'localhost',
            port: 2222,
            user: 'workspace',
            password: 'secret',
            tunnelPort: 1455,
            workspaceName: 'Test Workspace',
            authUrl: 'https://auth.example.com/device',
          }),
        } as unknown as Response;
      }

      if (href.includes('/auth-status/')) {
        return {
          ok: true,
          json: async () => ({ authenticated: true }),
        } as unknown as Response;
      }

      throw new Error(`unexpected url: ${href}`);
    });

    let now = 0;

    await runCliAuthCommand(
      'codex',
      {
        workspace: 'wk_success',
        cloudUrl: 'https://agent-relay.test',
        token: 'tok_live',
        timeout: '60',
      },
      io,
      {
        fetch: fetchMock,
        loadSSH2: vi.fn(async () => ({ Client: ReadyClient } as unknown as typeof import('ssh2'))),
        createServer: vi.fn(() => mockServer as unknown as ReturnType<typeof import('node:net').createServer>),
        sleep: vi.fn(async () => {
          now += 3000;
        }),
        onSignal: vi.fn(() => undefined),
        now: vi.fn(() => now),
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('Authentication Complete!'));
    expect(io.exit).not.toHaveBeenCalled();
  });
});
