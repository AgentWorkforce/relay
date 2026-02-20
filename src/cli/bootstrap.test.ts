import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './bootstrap.js';

const expectedLeafCommands = [
  'up',
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
  'doctor',
  'health',
  'profile',
  'auth',
  'cli-auth',
  'codex-auth',
  'claude-auth',
  'cursor-auth',
  'init',
  'setup',
  'telemetry',
  'mcp',
  'run',
  'trail',
  'cloud link',
  'cloud unlink',
  'cloud status',
  'cloud sync',
  'cloud agents',
  'cloud send',
  'cloud daemons',
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
        'doctor',
        'health',
        'profile',
        'auth',
        'cli-auth',
        'codex-auth',
        'claude-auth',
        'cursor-auth',
        'init',
        'setup',
        'telemetry',
        'mcp',
        'run',
        'trail',
      ])
    );
    expect(topLevelCommands).not.toContain('create-agent');
  });

  it('registers the expected number of executable commands', () => {
    const program = createProgram();
    const leafCommandPaths = collectLeafCommandPaths(program);

    expect(leafCommandPaths).toHaveLength(41);
    expect(leafCommandPaths).toEqual(expect.arrayContaining(expectedLeafCommands));
    expect(leafCommandPaths).not.toContain('create-agent');
  });
});
