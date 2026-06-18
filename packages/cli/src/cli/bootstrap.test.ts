import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from './bootstrap.js';

const expectedLeafCommands = [
  // local broker + agent group
  'local up',
  'local down',
  'local status',
  'local metrics',
  'local run',
  'local logs',
  'local sync',
  'local tail',
  'local agent list',
  'local agent spawn',
  'local agent new',
  'local agent release',
  'local agent set-model',
  'local agent attach',
  'local agent message flush',
  'local agent message hold',
  'local agent message auto',
  // top-level composite status + maintenance + telemetry + mcp
  'status',
  'version',
  'update',
  'uninstall',
  'telemetry',
  'mcp',
  // fleet
  'fleet config',
  'fleet disable',
  'fleet enable',
  'fleet inherit',
  'fleet serve',
  'fleet nodes',
  'fleet status',
  // cloud
  'cloud login',
  'cloud logout',
  'cloud whoami',
  'cloud connect',
  'cloud run',
  'cloud schedule',
  'cloud schedules',
  'cloud session',
  'cloud status',
  'cloud logs',
  'cloud sync',
  'cloud cancel',
  'cloud worker register',
  'cloud worker start',
  'cloud worker status',
  'cloud worker logs',
  // workspace
  'workspace create',
  'workspace active',
  'workspace list',
  'workspace set_key',
  'workspace join',
  'workspace switch',
  // workspace agents
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

  it('registers the expected command groups', () => {
    const program = createProgram();
    const topLevelCommands = program.commands.map((command) => command.name());

    expect(topLevelCommands).toEqual(
      expect.arrayContaining([
        'local',
        'cloud',
        'workspace',
        'agent',
        'channel',
        'message',
        'integration',
        'capabilities',
        'fleet',
        'status',
        'version',
        'update',
        'uninstall',
        'telemetry',
        'mcp',
      ])
    );
    // The dashboard-era surface is gone.
    expect(topLevelCommands).not.toEqual(
      expect.arrayContaining([
        'driver',
        'start',
        'view',
        'drive',
        'passthrough',
        'metrics',
        'health',
        'profile',
        'send',
        'read',
        'history',
        'replies',
        'spawn',
        'agents',
        'swarm',
        'on',
        'rm',
      ])
    );
  });

  it('registers the expected executable commands', () => {
    const program = createProgram();
    const leafCommandPaths = collectLeafCommandPaths(program);

    expect([...leafCommandPaths].sort()).toEqual([...expectedLeafCommands].sort());
  });
});
