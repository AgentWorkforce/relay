import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './bootstrap.js';

const expectedLeafCommands = [
  'driver up',
  'driver start',
  'driver down',
  'driver status',
  'driver uninstall',
  'driver version',
  'driver update',
  'driver bridge',
  'status',
  'version',
  'update',
  'uninstall',
  'mcp',
  'send',
  'read',
  'history',
  'inbox',
  'replies',
  'metrics',
  'health',
  'profile',
  'init',
  'setup',
  'telemetry',
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

  it('registers the expected simplified command groups', () => {
    const program = createProgram();
    const topLevelCommands = program.commands.map((command) => command.name());

    expect(topLevelCommands).toEqual(
      expect.arrayContaining([
        'driver',
        'cloud',
        'status',
        'version',
        'update',
        'uninstall',
        'mcp',
        'send',
        'read',
        'history',
        'inbox',
        'replies',
        'metrics',
        'health',
        'profile',
        'init',
        'setup',
        'telemetry',
      ])
    );
    expect(topLevelCommands).not.toEqual(
      expect.arrayContaining(['spawn', 'agents', 'swarm', 'on', 'drive', 'new', 'rm'])
    );
  });

  it('registers the expected number of executable commands', () => {
    const program = createProgram();
    const leafCommandPaths = collectLeafCommandPaths(program);

    expect(leafCommandPaths).toHaveLength(expectedLeafCommands.length);
    expect(leafCommandPaths).toEqual(expect.arrayContaining(expectedLeafCommands));
    expect(leafCommandPaths).not.toEqual(
      expect.arrayContaining(['spawn', 'agents', 'swarm', 'drive', 'new'])
    );

    // `runtime` is an alias of `driver`, so its leaves are not double-counted.
    expect(program.commands.find((c) => c.name() === 'driver')?.aliases()).toContain('runtime');
  });
});
