import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { createProgram } from './bootstrap.js';

const expectedLeafCommands = [
  // node broker + agent group (local is a hidden alias, filtered out below)
  'node up',
  'node down',
  'node status',
  'node metrics',
  'node tail',
  'node agent list',
  'node agent spawn',
  'node agent new',
  'node agent release',
  'node agent set-model',
  'node agent attach',
  'node agent message flush',
  'node agent message hold',
  'node agent message auto',
  'node workflow run',
  'node workflow logs',
  'node workflow sync',
  // top-level composite status + maintenance + telemetry + mcp
  'status',
  'version',
  'update',
  'uninstall',
  'telemetry',
  'mcp',
  // reflex
  'reflex on',
  'reflex off',
  'reflex status',
  // fleet (serve is a hidden error stub, filtered out below)
  'fleet config',
  'fleet disable',
  'fleet enable',
  'fleet inherit',
  'fleet nodes',
  'fleet status',
  // cloud
  'cloud login',
  'cloud logout',
  'cloud whoami',
  'cloud connect',
  'cloud enroll',
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
  'integration subscribe',
  'integration unsubscribe',
  'integration webhook create',
  'integration webhook list',
  'integration webhook delete',
  'integration webhook trigger',
  'integration webhook create-inbound',
  'integration webhook list-inbound',
  'integration webhook delete-inbound',
  'integration subscription create',
  'integration subscription list',
  'integration subscription get',
  'integration subscription delete',
  // capabilities
  'capabilities register',
  'capabilities list',
  'capabilities delete',
  // skills
  'skills add',
];

function isHidden(command: Command): boolean {
  return (command as unknown as { _hidden?: boolean })._hidden === true;
}

function collectLeafCommandPaths(program: Command): string[] {
  const paths: string[] = [];

  const visit = (command: Command, parents: string[]): void => {
    for (const subcommand of command.commands) {
      // Hidden commands (deprecated `local` alias, `fleet serve` stub) are still
      // routable but excluded from the visible surface assertions.
      if (isHidden(subcommand)) {
        continue;
      }
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
        'node',
        'local',
        'cloud',
        'workspace',
        'agent',
        'channel',
        'message',
        'integration',
        'capabilities',
        'fleet',
        'reflex',
        'status',
        'version',
        'update',
        'uninstall',
        'telemetry',
        'mcp',
      ])
    );
    // The legacy command surface is gone.
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

  it('keeps `local` as a hidden, routable alias of `node`', () => {
    const program = createProgram();
    const local = program.commands.find((command) => command.name() === 'local');

    expect(local).toBeDefined();
    expect(isHidden(local as Command)).toBe(true);
    // Hidden from the rendered help output.
    expect(program.helpInformation()).not.toContain('Deprecated alias');
    // Still routable: the flat `local run|logs|sync` + agent surface is intact.
    expect(local?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['up', 'down', 'status', 'metrics', 'run', 'logs', 'sync', 'agent', 'tail'])
    );
  });

  it('keeps `fleet serve` as a hidden error stub', () => {
    const program = createProgram();
    const fleet = program.commands.find((command) => command.name() === 'fleet');
    const serve = fleet?.commands.find((command) => command.name() === 'serve');

    expect(serve).toBeDefined();
    expect(isHidden(serve as Command)).toBe(true);
  });

  it("warns once when the deprecated 'local' alias is used", () => {
    const program = createProgram();
    const local = program.commands.find((command) => command.name() === 'local')!;
    const hooks = (
      local as unknown as { _lifeCycleHooks?: { preAction?: Array<(...args: unknown[]) => void> } }
    )._lifeCycleHooks;
    const preAction = hooks?.preAction?.[0];
    expect(preAction).toBeTypeOf('function');

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      preAction!();
      preAction!();
    } finally {
      spy.mockRestore();
    }

    const warnings = writes.filter((line) => line.includes("'local' is deprecated"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("use 'relay node ...' instead");

    // The hook is attached to the deprecated alias only — the `node` group
    // must never carry it.
    const nodeCommand = program.commands.find((command) => command.name() === 'node')!;
    const nodeHooks = (nodeCommand as unknown as { _lifeCycleHooks?: { preAction?: unknown[] } })
      ._lifeCycleHooks;
    expect(nodeHooks?.preAction ?? []).toHaveLength(0);
  });
});
