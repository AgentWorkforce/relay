import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './bootstrap.js';
import { parseVerblessAlias } from './lib/spawn-and-attach.js';

const expectedLeafCommands = [
  'up',
  'start',
  'down',
  'status',
  'uninstall',
  'version',
  'update',
  'bridge',
  'spawn',
  'agents',
  'who',
  'agents:logs',
  'broker-spawn',
  'release',
  'set-model',
  'agents:kill',
  'send',
  'read',
  'history',
  'inbox',
  'login',
  'metrics',
  'health',
  'profile',
  'auth',
  'init',
  'setup',
  'swarm',
  'telemetry',
  'on',
  'off',
  'run',
  'connect',
  'view',
  'drive',
  'relay',
  'new',
  'rm',
  'dlq list',
  'dlq inspect',
  'dlq replay',
  'dlq purge',
  'workflows list',
  'workspaces create',
  'tokens issue',
  'cloud login',
  'cloud logout',
  'cloud whoami',
  'cloud connect',
  'cloud run',
  'cloud schedule',
  'cloud schedules',
  'cloud status',
  'cloud logs',
  'cloud sync',
  'cloud cancel',
];

function collectLeafCommandPaths(program: Command): string[] {
  const paths: string[] = [];

  const visit = (command: Command, parents: string[]): void => {
    for (const subcommand of command.commands) {
      const currentPath = [...parents, subcommand.name()];
      if (subcommand.commands.length === 0) {
        paths.push(currentPath.join(' '));
      } else {
        visit(subcommand, currentPath);
      }
    }
  };

  visit(program, []);
  return paths;
}

describe('bootstrap CLI', () => {
  it('uses the expected program name', () => {
    const program = createProgram();
    expect(program.name()).toBe('agent-relay');
  });

  it('registers all expected command groups and leaves out create-agent', () => {
    const program = createProgram();
    const topLevelCommands = program.commands.map((command) => command.name());

    expect(topLevelCommands).toEqual(
      expect.arrayContaining([
        'up',
        'start',
        'down',
        'status',
        'uninstall',
        'version',
        'update',
        'bridge',
        'spawn',
        'agents',
        'who',
        'agents:logs',
        'broker-spawn',
        'release',
        'set-model',
        'agents:kill',
        'send',
        'read',
        'history',
        'inbox',
        'login',
        'cloud',
        'metrics',
        'health',
        'profile',
        'auth',
        'init',
        'setup',
        'swarm',
        'telemetry',
        'on',
        'off',
        'run',
        'dlq',
        'workspaces',
        'workflows',
        'tokens',
      ])
    );
    expect(topLevelCommands).not.toContain('create-agent');
  });

  it('registers the expected number of executable commands', () => {
    const program = createProgram();
    const leafCommandPaths = collectLeafCommandPaths(program);

    expect(leafCommandPaths).toHaveLength(expectedLeafCommands.length);
    expect(leafCommandPaths).toEqual(expect.arrayContaining(expectedLeafCommands));
    expect(leafCommandPaths).not.toContain('create-agent');
  });
});

describe('verbless `-n NAME CLI` silent alias', () => {
  // Build the verb set the same way `runCli` does so the test exercises
  // the real exclusion list. If a new verb is registered without
  // updating `expectedLeafCommands`, the leaf-count test above catches
  // that — here we just need the live snapshot.
  function knownVerbs(): Set<string> {
    const program = createProgram();
    return new Set(program.commands.map((c) => c.name()));
  }

  it('recognises `-n NAME CLI`', () => {
    const result = parseVerblessAlias(['-n', 'Alice', 'claude'], knownVerbs());
    expect(result).toEqual({ name: 'Alice', cli: 'claude', args: [] });
  });

  it('recognises `--name NAME CLI [args...]`', () => {
    const result = parseVerblessAlias(['--name', 'Alice', 'claude', '--say', 'hi'], knownVerbs());
    expect(result).toEqual({ name: 'Alice', cli: 'claude', args: ['--say', 'hi'] });
  });

  it('recognises the joined `-nNAME` short-flag form', () => {
    const result = parseVerblessAlias(['-nAlice', 'claude'], knownVerbs());
    expect(result).toEqual({ name: 'Alice', cli: 'claude', args: [] });
  });

  it('recognises the `--name=NAME` equals form', () => {
    const result = parseVerblessAlias(['--name=Alice', 'claude'], knownVerbs());
    expect(result).toEqual({ name: 'Alice', cli: 'claude', args: [] });
  });

  it('returns null when no -n flag is present (lets commander handle it)', () => {
    expect(parseVerblessAlias(['spawn', 'Alice', 'claude'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['view', 'Alice'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias([], knownVerbs())).toBeNull();
  });

  it('returns null when -n has no value', () => {
    expect(parseVerblessAlias(['-n'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['--name'], knownVerbs())).toBeNull();
  });

  it('returns null when -n has a value but no CLI positional follows', () => {
    expect(parseVerblessAlias(['-n', 'Alice'], knownVerbs())).toBeNull();
  });

  it('returns null when the first positional after -n is a known verb', () => {
    // `-n NAME drive` is too ambiguous — let commander error.
    expect(parseVerblessAlias(['-n', 'Alice', 'drive'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['-n', 'Alice', 'view'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['-n', 'Alice', 'relay'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['-n', 'Alice', 'new'], knownVerbs())).toBeNull();
  });

  it('returns null when help / version flags are present', () => {
    expect(parseVerblessAlias(['-n', 'Alice', 'claude', '--help'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['-n', 'Alice', 'claude', '-h'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['-n', 'Alice', 'claude', '--version'], knownVerbs())).toBeNull();
    expect(parseVerblessAlias(['-n', 'Alice', 'claude', '-V'], knownVerbs())).toBeNull();
  });

  it('byte-equivalence: alias parse matches what `new NAME CLI --attach --mode relay --ephemeral` would dispatch', () => {
    // The alias dispatcher hardcodes `mode: 'relay'` and `ephemeral: true`
    // and feeds the parsed `name`, `cli`, `args` to `runSpawnAndAttach`.
    // The `new --attach` command path receives the same three positions
    // from commander and feeds them to the same function. The two paths
    // are byte-equivalent iff the parser extracts the same triplet here.
    const argvForAlias = ['-n', 'Alice', 'claude', '--say', 'hi'];
    // What `new Alice claude --attach --mode relay --ephemeral --say hi`
    // decomposes into at the commander action layer: positional
    // `<name>` ('Alice'), positional `<cli>` ('claude'), variadic
    // `[args...]` (['--say', 'hi']). `--attach` / `--mode` / `--ephemeral`
    // are flags that tell the action to take the spawn-and-attach path
    // with the alias's hardcoded preset.
    const newAttachArgv = [
      'new',
      'Alice',
      'claude',
      '--attach',
      '--mode',
      'relay',
      '--ephemeral',
      '--say',
      'hi',
    ];

    const aliasParsed = parseVerblessAlias(argvForAlias, knownVerbs());
    expect(aliasParsed).toEqual({ name: 'Alice', cli: 'claude', args: ['--say', 'hi'] });

    // Pull the same triplet out of the `new --attach` argv:
    const newName = newAttachArgv[1]; // 'Alice'
    const newCli = newAttachArgv[2]; // 'claude'
    // Commander strips known flags from the variadic; the user-passed
    // `--say hi` survives as part of `[args...]`. Simulated here by
    // taking everything after the trailing flag block.
    const newVariadic = newAttachArgv.slice(7); // ['--say', 'hi']
    expect({ name: newName, cli: newCli, args: newVariadic }).toEqual(aliasParsed);
  });
});
