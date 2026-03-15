import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './bootstrap.js';

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
  'metrics',
  'health',
  'profile',
  'auth',
  'init',
  'setup',
  'swarm',
  'telemetry',
  'run',
  'connect',
  'workflows list',
  'cloud link',
  'cloud unlink',
  'cloud status',
  'cloud sync',
  'cloud agents',
  'cloud send',
  'cloud brokers',
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
  // Pass --help to createProgram so all command modules are loaded
  const helpArgv = ['node', 'agent-relay', '--help'];

  it('uses the expected program name', async () => {
    const program = await createProgram(helpArgv);
    expect(program.name()).toBe('agent-relay');
  });

  it('registers all expected command groups and leaves out create-agent', async () => {
    const program = await createProgram(helpArgv);
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
        'cloud',
        'metrics',
        'health',
        'profile',
        'auth',
        'init',
        'setup',
        'swarm',
        'telemetry',
        'run',
        'workflows',
      ])
    );
    expect(topLevelCommands).not.toContain('create-agent');
  });

  it('registers the expected number of executable commands', async () => {
    const program = await createProgram(helpArgv);
    const leafCommandPaths = collectLeafCommandPaths(program);

    expect(leafCommandPaths).toHaveLength(38);
    expect(leafCommandPaths).toEqual(expect.arrayContaining(expectedLeafCommands));
    expect(leafCommandPaths).not.toContain('create-agent');
  });
});
