import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram, propagateTelemetryContextToChildren } from './bootstrap.js';

const expectedLeafCommands = [
  // node broker + agent group (local is a hidden alias, filtered out below)
  'node up',
  'node down',
  'node status',
  'node metrics',
  'node deadletters',
  'node redeliver',
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
  'fleet agent list',
  'fleet config',
  'fleet disable',
  'fleet enable',
  'fleet inherit',
  'fleet nodes',
  'fleet release',
  'fleet spawn',
  'fleet status',
  // cloud
  'cloud login',
  'cloud logout',
  'cloud whoami',
  'cloud workspaces',
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
  'cloud room invite',
  'cloud room invites',
  'cloud room revoke-invite',
  'cloud room members',
  'cloud room remove-member',
  'cloud room session',
  'cloud room revoke-session',
  'cloud room accept',
  'cloud integration catalog',
  'cloud integration connections',
  'cloud integration connect',
  'cloud integration disconnect',
  // workspace
  'workspace create',
  'workspace active',
  'workspace list',
  'workspace set_key',
  'workspace join',
  'workspace key',
  'workspace switch',
  'workspace restore',
  'workspace rebind',
  // workspace agents
  'agent register',
  'agent rotate',
  'agent list',
  'agent add',
  'agent remove',
  'agent me',
  'agent presence',
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

describe('createProgram output redaction', () => {
  it('masks a credential echoed by an unknown-option parse error', async () => {
    const program = createProgram();
    program.exitOverride();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    try {
      await expect(
        program.parseAsync(['node', 'agent-relay', 'node', 'up', '--workspce-key=rk_live_0123456789abcdef'])
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    const stderr = writes.join('');
    expect(stderr).toContain('rk_live_…cdef');
    expect(stderr).not.toContain('rk_live_0123456789abcdef');
  });
});

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

describe('telemetry context propagation', () => {
  const IDENTITY_KEYS = [
    'AGENT_RELAY_USER_ID',
    'AGENT_RELAY_USER_EMAIL',
    'AGENT_RELAY_ORG_ID',
    'AGENT_RELAY_ORG_SLUG',
    'AGENT_RELAY_CLOUD_WORKSPACE_ID',
    'AGENT_RELAY_MACHINE_ID',
    'AGENT_RELAY_DISTINCT_ID',
  ] as const;

  function setup(): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bootstrap-'));
    fs.writeFileSync(
      path.join(dataDir, 'cloud-identity.json'),
      JSON.stringify({
        userId: 'usr_abc123',
        email: 'will@agentrelay.com',
        organizationId: 'org_xyz789',
        organizationSlug: 'agentworkforce',
        apiUrl: 'https://api.agentrelay.com',
        updatedAt: '2026-07-25T00:00:00.000Z',
      })
    );

    vi.stubEnv('AGENT_RELAY_DATA_DIR', dataDir);
    // Short-circuit the process-tree walk; irrelevant here and slow.
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_HARNESS', 'codex');
    // Establish the telemetry-enabled premise rather than inheriting it. CI
    // sets AGENT_RELAY_TELEMETRY_DISABLED=1 workflow-wide, which silently
    // flipped these cases onto the opted-out path. Opt-out cases re-stub these
    // after calling setup().
    vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    for (const key of IDENTITY_KEYS) vi.stubEnv(key, '');
    return dataDir;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('publishes cloud identity to children when telemetry is enabled', () => {
    const dataDir = setup();
    try {
      propagateTelemetryContextToChildren();

      expect(process.env.AGENT_RELAY_USER_ID).toBe('usr_abc123');
      expect(process.env.AGENT_RELAY_ORG_ID).toBe('org_xyz789');
      // A signed-in user id is the person key children inherit.
      expect(process.env.AGENT_RELAY_DISTINCT_ID).toBe('usr_abc123');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each(['AGENT_RELAY_TELEMETRY_DISABLED', 'DO_NOT_TRACK'])(
    'publishes no identity to children when opted out via %s',
    (optOut) => {
      const dataDir = setup();
      vi.stubEnv(optOut, '1');
      try {
        propagateTelemetryContextToChildren();

        // These are inherited by every spawned child, including third-party
        // harness CLIs, and one carries the operator's email. Opting out must
        // keep them out of the environment entirely, not merely unsent.
        for (const key of IDENTITY_KEYS) {
          expect(process.env[key], `${key} leaked while opted out`).toBeFalsy();
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  );

  it.each(['AGENT_RELAY_TELEMETRY_DISABLED', 'DO_NOT_TRACK'])(
    'removes identity inherited from an ancestor when opted out via %s',
    (optOut) => {
      const dataDir = setup();
      // An ancestor process, a wrapper CLI, or the user's shell exported these.
      // Declining to publish is not enough — they are inherited, so without an
      // explicit delete they still reach every child we spawn.
      vi.stubEnv('AGENT_RELAY_USER_ID', 'usr_inherited');
      vi.stubEnv('AGENT_RELAY_USER_EMAIL', 'will@agentrelay.com');
      vi.stubEnv('AGENT_RELAY_ORG_ID', 'org_inherited');
      vi.stubEnv('AGENT_RELAY_ORG_SLUG', 'inherited-org');
      vi.stubEnv('AGENT_RELAY_CLOUD_WORKSPACE_ID', 'ws_inherited');
      vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'usr_inherited');
      vi.stubEnv('AGENT_RELAY_MACHINE_ID', 'abc123def4567890');
      vi.stubEnv(optOut, '1');

      try {
        propagateTelemetryContextToChildren();

        for (const key of IDENTITY_KEYS) {
          expect(process.env[key], `${key} survived while opted out`).toBeUndefined();
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  );

  it('keeps identity inherited from an ancestor when telemetry is enabled', () => {
    const dataDir = setup();
    vi.stubEnv('AGENT_RELAY_USER_ID', 'usr_inherited');
    vi.stubEnv('AGENT_RELAY_ORG_ID', 'org_inherited');

    try {
      propagateTelemetryContextToChildren();

      // An ancestor's identity still wins over the local identity file.
      expect(process.env.AGENT_RELAY_USER_ID).toBe('usr_inherited');
      expect(process.env.AGENT_RELAY_ORG_ID).toBe('org_inherited');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('still propagates non-identity context when opted out', () => {
    const dataDir = setup();
    vi.stubEnv('DO_NOT_TRACK', '1');
    try {
      propagateTelemetryContextToChildren();

      // Versions and harness are not identity and stay unconditional.
      expect(process.env.AGENT_RELAY_CLI_VERSION).toBeTruthy();
      expect(process.env.AGENT_RELAY_TELEMETRY_CLIENT).toBe('agent-relay');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
