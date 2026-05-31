import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './bootstrap.js';

const expectedLeafCommands = [
  // runtime/driver group (driver is aliased to runtime)
  'driver up',
  'driver down',
  'driver status',
  'driver agent list',
  'driver agent spawn',
  'driver agent new',
  'driver agent release',
  'driver agent kill',
  'driver agent attach',
  'driver tail',
  // top-level lifecycle aliases
  'status',
  'version',
  'update',
  'uninstall',
  'mcp',
  // messaging (legacy flat) + monitoring + setup
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
  // cloud
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
  // workspace
  'workspace create',
  'workspace list',
  'workspace set_key',
  'workspace join',
  'workspace switch',
  // agent
  'agent register',
  'agent list',
  'agent add',
  'agent remove',
  // channel
  'channel create',
  'channel list',
  'channel join',
  'channel leave',
  'channel invite',
  'channel set_topic',
  'channel archive',
  // message
  'message post',
  'message list',
  'message reply',
  'message get_thread',
  'message search',
  'message dm send',
  'message dm list',
  'message dm send_group',
  'message reaction add',
  'message reaction remove',
  'message inbox check',
  'message inbox mark_read',
  'message inbox get_readers',
  'message file upload',
  // integration
  'integration webhook create',
  'integration webhook list',
  'integration webhook delete',
  'integration webhook trigger',
  'integration subscription create',
  'integration subscription list',
  'integration subscription get',
  'integration subscription delete',
  // capabilities
  'capabilities register',
  'capabilities list',
  'capabilities delete',
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
        'workspace',
        'agent',
        'channel',
        'message',
        'integration',
        'capabilities',
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
      expect.arrayContaining(['spawn', 'agents', 'swarm', 'on', 'drive', 'rm'])
    );
  });

  it('registers the expected number of executable commands', () => {
    const program = createProgram();
    const leafCommandPaths = collectLeafCommandPaths(program);

    expect([...leafCommandPaths].sort()).toEqual([...expectedLeafCommands].sort());
    expect(leafCommandPaths).not.toEqual(
      expect.arrayContaining(['spawn', 'agents', 'swarm', 'drive', 'new'])
    );

    // `runtime` is an alias of `driver`, so its leaves are not double-counted.
    expect(program.commands.find((c) => c.name() === 'driver')?.aliases()).toContain('runtime');
  });
});
