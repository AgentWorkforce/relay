import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { RelayCliCommandSpec, RelayCliIo, RelayCliSurface } from '@agent-relay/cli-surface';

import {
  mountRelayCliSurface,
  renderSurfaceHelp,
  resolveSpecPath,
  runSurface,
  type RelayCliSurfaceDependencies,
} from './relay-cli-surface.js';

const COMMANDS: RelayCliCommandSpec[] = [
  {
    name: 'ls',
    description: 'List files',
    args: [{ name: 'path', description: 'Directory to list', required: false }],
    options: [
      { flags: '--json', description: 'Emit JSON' },
      { flags: '-l, --long', description: 'Long format', defaultValue: false },
    ],
  },
  {
    name: 'integration',
    description: 'Manage provider integrations',
    subcommands: [
      {
        name: 'connect',
        description: 'Connect a provider',
        args: [{ name: 'provider', description: 'Provider slug', required: true }],
      },
      { name: 'list', description: 'List integrations', aliases: ['ls'] },
    ],
  },
  { name: 'legacy-run', description: 'Run a v1 workflow', deprecated: { replacement: 'agent-relay flows run', since: '12.3.0' } },
  { name: 'internal-debug', description: 'Dump internal state', hidden: true },
];

function makeIo(): RelayCliIo & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(chunk: string) {
      sink.out += chunk;
    },
    stderr(chunk: string) {
      sink.err += chunk;
    },
  };
  return sink;
}

function makeSurface(overrides: Partial<RelayCliSurface> = {}): RelayCliSurface {
  return {
    id: 'relayfile',
    version: '0.10.56',
    contract: 1,
    commands: COMMANDS,
    run: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeDeps(io: RelayCliIo): RelayCliSurfaceDependencies {
  return {
    io,
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never,
  };
}

describe('resolveSpecPath', () => {
  it('resolves a nested command', () => {
    const resolved = resolveSpecPath(COMMANDS, ['integration', 'connect', 'linear']);
    expect(resolved.command?.name).toBe('connect');
    expect(resolved.path).toEqual(['integration', 'connect']);
    expect(resolved.rest).toEqual(['linear']);
  });

  it('resolves through an alias but reports the canonical name', () => {
    // `integration ls` must reach `list`; the path is what help and the
    // deprecation notice render, so it has to be canonical.
    const resolved = resolveSpecPath(COMMANDS, ['integration', 'ls']);
    expect(resolved.command?.name).toBe('list');
    expect(resolved.path).toEqual(['integration', 'list']);
  });

  it('stops at the first flag so product options are never eaten', () => {
    const resolved = resolveSpecPath(COMMANDS, ['ls', '--json', 'integration']);
    expect(resolved.command?.name).toBe('ls');
    expect(resolved.rest).toEqual(['--json', 'integration']);
  });

  it('reports no command when the first token matches nothing', () => {
    const resolved = resolveSpecPath(COMMANDS, ['bogus', 'x']);
    expect(resolved.command).toBeUndefined();
    expect(resolved.rest).toEqual(['bogus', 'x']);
  });

  it('keeps the parent when only the child fails to match', () => {
    const resolved = resolveSpecPath(COMMANDS, ['integration', 'bogus']);
    expect(resolved.command?.name).toBe('integration');
    expect(resolved.rest).toEqual(['bogus']);
  });
});

describe('renderSurfaceHelp', () => {
  it('lists top-level commands at the group root and hides hidden ones', () => {
    const help = renderSurfaceHelp('agent-relay file', undefined, COMMANDS);
    expect(help).toContain('Usage: agent-relay file [options]');
    expect(help).toContain('ls');
    expect(help).toContain('List files');
    expect(help).not.toContain('internal-debug');
  });

  it('marks a deprecated command in the command list', () => {
    expect(renderSurfaceHelp('agent-relay file', undefined, COMMANDS)).toContain(
      'Run a v1 workflow (deprecated)'
    );
  });

  it('renders args, options, and defaults for a leaf command', () => {
    const help = renderSurfaceHelp('agent-relay file ls', COMMANDS[0], COMMANDS);
    expect(help).toContain('Usage: agent-relay file ls [path] [options]');
    expect(help).toContain('path');
    expect(help).toContain('Directory to list');
    expect(help).toContain('--json');
    expect(help).toContain('Long format (default: false)');
  });

  it('renders a required positional in angle brackets', () => {
    const connect = COMMANDS[1]!.subcommands![0]!;
    expect(renderSurfaceHelp('agent-relay file integration connect', connect, COMMANDS)).toContain(
      'Usage: agent-relay file integration connect <provider>'
    );
  });

  it('names the replacement in the help of a deprecated command', () => {
    expect(renderSurfaceHelp('agent-relay file legacy-run', COMMANDS[2], COMMANDS)).toContain(
      'Deprecated. Use `agent-relay flows run` instead.'
    );
  });
});

describe('runSurface', () => {
  it('forwards argv to the product verbatim, flags included', async () => {
    // The whole point of the mount: relay never re-serializes product options,
    // because it does not know them.
    const io = makeIo();
    const run = vi.fn(async () => 0);
    const surface = makeSurface({ run });
    const argv = ['ls', '/tmp', '--json', '--unknown-to-relay', 'value'];

    await runSurface(surface, 'agent-relay file', argv, makeDeps(io));

    expect(run).toHaveBeenCalledWith(argv, io);
  });

  it('returns the product exit code unchanged', async () => {
    const surface = makeSurface({ run: async () => 42 });
    await expect(runSurface(surface, 'agent-relay file', ['ls'], makeDeps(makeIo()))).resolves.toBe(42);
  });

  it('renders group help for empty argv without loading the product', async () => {
    const run = vi.fn(async () => 0);
    const io = makeIo();
    const code = await runSurface(makeSurface({ run }), 'agent-relay file', [], makeDeps(io));
    expect(code).toBe(0);
    expect(io.out).toContain('Commands:');
    expect(run).not.toHaveBeenCalled();
  });

  it('renders help for the deepest matched command on --help', async () => {
    const io = makeIo();
    const run = vi.fn(async () => 0);
    await runSurface(makeSurface({ run }), 'agent-relay file', ['integration', 'connect', '--help'], makeDeps(io));
    expect(io.out).toContain('Usage: agent-relay file integration connect <provider>');
    expect(run).not.toHaveBeenCalled();
  });

  it('exits 2 with the available commands when the command is unknown', async () => {
    const io = makeIo();
    const code = await runSurface(makeSurface(), 'agent-relay file', ['bogus'], makeDeps(io));
    expect(code).toBe(2);
    expect(io.err).toContain("unknown command 'bogus'");
    expect(io.err).toContain('Available commands: ls, integration, legacy-run');
    expect(io.err).not.toContain('internal-debug');
  });

  it('warns on a deprecated command but still runs it', async () => {
    const io = makeIo();
    const run = vi.fn(async () => 0);
    const code = await runSurface(makeSurface({ run }), 'agent-relay file', ['legacy-run'], makeDeps(io));
    expect(code).toBe(0);
    expect(io.err).toContain('`agent-relay file legacy-run` is deprecated since 12.3.0');
    expect(io.err).toContain('Use `agent-relay flows run` instead.');
    expect(run).toHaveBeenCalled();
  });

  it('runs a hidden command even though help omits it', async () => {
    const run = vi.fn(async () => 0);
    const code = await runSurface(makeSurface({ run }), 'agent-relay file', ['internal-debug'], makeDeps(makeIo()));
    expect(code).toBe(0);
    expect(run).toHaveBeenCalled();
  });

  it('converts a thrown product error into exit 1 and a readable line', async () => {
    // A product that throws instead of returning a code is violating the
    // contract; it must still not reach the user as an unhandled rejection.
    const io = makeIo();
    const surface = makeSurface({
      run: async () => {
        throw new Error('relayfile daemon is not running');
      },
    });
    const code = await runSurface(surface, 'agent-relay file', ['ls'], makeDeps(io));
    expect(code).toBe(1);
    expect(io.err).toContain('relayfile daemon is not running');
  });

  it('describes a non-Error rejection instead of [object Object]', async () => {
    const io = makeIo();
    const surface = makeSurface({
      run: async () => {
        throw { status: 401, message: 'unauthorized' };
      },
    });
    await runSurface(surface, 'agent-relay file', ['ls'], makeDeps(io));
    expect(io.err).not.toContain('[object Object]');
    expect(io.err).toContain('401');
  });
});

describe('mountRelayCliSurface', () => {
  function programWith(load: () => Promise<RelayCliSurface>, io: RelayCliIo) {
    const program = new Command();
    program.exitOverride();
    program.enablePositionalOptions();
    mountRelayCliSurface(
      program,
      { as: 'file', description: 'relayfile commands', load, hiddenAliases: ['files'] },
      makeDeps(io)
    );
    return program;
  }

  it('does not load the product SDK until the group is invoked', async () => {
    // Cold `agent-relay --help` must not pay for three product SDKs, so the
    // import has to sit behind the action rather than at registration.
    const load = vi.fn(async () => makeSurface());
    const io = makeIo();
    const program = programWith(load, io);

    expect(load).not.toHaveBeenCalled();
    program.helpInformation();
    expect(load).not.toHaveBeenCalled();

    await program.parseAsync(['file', 'ls'], { from: 'user' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('passes product flags through commander untouched', async () => {
    const run = vi.fn(async () => 0);
    const io = makeIo();
    const program = programWith(async () => makeSurface({ run }), io);

    await program.parseAsync(['file', 'ls', '--json', '-l', '/tmp'], { from: 'user' });

    expect(run).toHaveBeenCalledWith(['ls', '--json', '-l', '/tmp'], io);
  });

  it('routes --help to the surface renderer rather than commander', async () => {
    const run = vi.fn(async () => 0);
    const io = makeIo();
    const program = programWith(async () => makeSurface({ run }), io);

    await program.parseAsync(['file', '--help'], { from: 'user' });

    expect(io.out).toContain('Usage: agent-relay file');
    expect(run).not.toHaveBeenCalled();
  });

  it('reaches the same surface through a hidden alias', async () => {
    const run = vi.fn(async () => 0);
    const io = makeIo();
    const program = programWith(async () => makeSurface({ run }), io);

    await program.parseAsync(['files', 'ls'], { from: 'user' });

    expect(run).toHaveBeenCalledWith(['ls'], io);
  });

  it('renders the group in parent help without the argv placeholder', () => {
    // Commander would otherwise derive the term from the catch-all argument
    // and show `file [args...]`, leaking a mount detail into user-facing help.
    const program = programWith(async () => makeSurface(), makeIo());
    const help = program.helpInformation();
    expect(help).toMatch(/^\s+file\s{2,}relayfile commands/m);
    expect(help).not.toContain('[args...]');
  });

  it('hides the alias but not the canonical group from help', () => {
    const program = programWith(async () => makeSurface(), makeIo());
    const help = program.helpInformation();
    expect(help).toContain('file');
    expect(help).not.toMatch(/^\s+files\b/m);
  });

  it('exits non-zero when the product does', async () => {
    const io = makeIo();
    const program = programWith(async () => makeSurface({ run: async () => 3 }), io);

    await expect(program.parseAsync(['file', 'ls'], { from: 'user' })).rejects.toThrow('exit:3');
  });
});
