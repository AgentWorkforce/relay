import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

// `fleet status` fetches the broker session (which carries the node token and
// workspace key) and queries the engine nodes API; stub both so the redaction
// path can be exercised without a running broker.
vi.mock('../lib/broker-lifecycle.js', () => ({
  readBrokerConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1', api_key: 'k', pid: 1, port: 1 })),
}));
vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: class {
    async getSession() {
      return {
        workspace_key: 'rk_live_secret',
        node_token: 'nt_live_secret',
        node_id: 'node_1',
        node_name: 'live-node',
        broker_version: '9.2.3',
        protocol_version: 2,
        mode: 'persist',
        uptime_secs: 1,
      };
    }
    disconnect() {}
  },
}));

import { registerFleetCommands } from './fleet.js';
import { writeProjectWorkspaceKey } from '../lib/project-workspace-key.js';

describe('fleet command support', () => {
  it.each([
    ['config', 'get', undefined],
    ['enable', 'set', true],
    ['disable', 'set', false],
    ['inherit', 'inherit', undefined],
  ] as const)('fleet %s delegates to workspace fleet node config API', async (command, method, value) => {
    const fleetNodes = {
      get: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
      set: vi.fn(async (enabled: boolean) => ({ enabled, defaultEnabled: false, override: enabled })),
      inherit: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
    };
    const createWorkspaceRelay = vi.fn(() => ({ workspace: { fleetNodes } }));
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn(() => {
          throw new Error('__exit__');
        }) as never,
      },
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      ['fleet', command, '--workspace-key', 'rk_live_test', '--base-url', 'https://relay.example'],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: 'https://relay.example',
    });
    if (method === 'set') {
      expect(fleetNodes.set).toHaveBeenCalledWith(value);
    } else {
      expect(fleetNodes[method]).toHaveBeenCalledTimes(1);
    }
    expect(JSON.parse(logs[0]!)).toMatchObject({
      enabled: method === 'set' ? value : false,
      defaultEnabled: false,
    });
  });

  it('fleet nodes accepts --wk as an alias for --workspace-key', async () => {
    const nodes = { list: vi.fn(async () => []) };
    const createWorkspaceRelay = vi.fn(() => ({ nodes }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn() as never,
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(['fleet', 'nodes', '--wk', 'rk_live_alias'], { from: 'user' });

    // The alias is folded into workspaceKey before the action resolves the client.
    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_alias',
      token: undefined,
      baseUrl: undefined,
    });
    expect(nodes.list).toHaveBeenCalledTimes(1);
  });

  it('fleet nodes prefers an explicit --workspace-key over --wk', async () => {
    const nodes = { list: vi.fn(async () => []) };
    const createWorkspaceRelay = vi.fn(() => ({ nodes }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn() as never,
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      ['fleet', 'nodes', '--workspace-key', 'rk_live_explicit', '--wk', 'rk_live_alias'],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_explicit',
      token: undefined,
      baseUrl: undefined,
    });
  });

  it('fleet nodes hides offline and direct pseudo-nodes by default', async () => {
    const listedNodes = [
      {
        name: 'sf-mini',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:codex' }],
        tags: [],
      },
      {
        name: 'legacy-live-runner',
        status: 'online',
        capabilities: [{ name: 'spawn:codex' }],
        tags: [],
      },
      {
        name: 'old-runner',
        status: 'offline',
        live: false,
        capabilities: [{ name: 'spawn:codex' }],
        tags: [],
      },
      {
        name: 'stale-online-runner',
        status: 'online',
        live: false,
        capabilities: [{ name: 'spawn:codex' }],
        tags: [],
      },
      {
        name: 'direct-123',
        status: 'online',
        live: true,
        capabilities: [],
        tags: ['implicit', 'direct'],
      },
    ];
    const nodes = { list: vi.fn(async () => listedNodes) };
    const logs: string[] = [];
    const warnings: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes })) as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await program.parseAsync(['fleet', 'nodes', '--workspace-key', 'rk_live_test'], {
      from: 'user',
    });

    expect(JSON.parse(logs[0]!)).toEqual({ nodes: listedNodes.slice(0, 2) });
    expect(warnings.join('\n')).toMatch(/3 offline or non-fleet records hidden/);
    expect(warnings.join('\n')).toMatch(/--all/);
  });

  it('fleet nodes --all includes offline and direct history records', async () => {
    const listedNodes = [
      { name: 'sf-mini', status: 'online', live: true, capabilities: [], tags: [] },
      { name: 'old-runner', status: 'offline', live: false, capabilities: [], tags: [] },
      {
        name: 'direct-123',
        status: 'offline',
        live: false,
        capabilities: [],
        tags: ['implicit', 'direct'],
      },
    ];
    const nodes = { list: vi.fn(async () => listedNodes) };
    const logs: string[] = [];
    const warnings: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes })) as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await program.parseAsync(['fleet', 'nodes', '--workspace-key', 'rk_live_test', '--all'], {
      from: 'user',
    });

    expect(JSON.parse(logs[0]!)).toEqual({ nodes: listedNodes });
    expect(warnings).toEqual([]);
  });

  it('fleet nodes warns when the workspace key is inferred from the project broker', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fleet-proj-'));
    const saved = {
      project: process.env.AGENT_RELAY_PROJECT,
      ws: process.env.RELAY_WORKSPACE_KEY,
      agentWs: process.env.AGENT_RELAY_WORKSPACE_KEY,
      api: process.env.RELAY_API_KEY,
    };
    process.env.AGENT_RELAY_PROJECT = projectRoot;
    delete process.env.RELAY_WORKSPACE_KEY;
    delete process.env.AGENT_RELAY_WORKSPACE_KEY;
    delete process.env.RELAY_API_KEY;
    writeProjectWorkspaceKey(path.join(projectRoot, '.agentworkforce/relay'), 'rk_project_broker');

    const warnings: string[] = [];
    const nodes = { list: vi.fn(async () => []) };
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn() as never,
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    try {
      await program.parseAsync(['fleet', 'nodes'], { from: 'user' });
    } finally {
      if (saved.project === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = saved.project;
      if (saved.ws !== undefined) process.env.RELAY_WORKSPACE_KEY = saved.ws;
      if (saved.agentWs === undefined) delete process.env.AGENT_RELAY_WORKSPACE_KEY;
      else process.env.AGENT_RELAY_WORKSPACE_KEY = saved.agentWs;
      if (saved.api !== undefined) process.env.RELAY_API_KEY = saved.api;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }

    // The warning is advisory only — the roster is still fetched and printed.
    expect(warnings.join('\n')).toMatch(/workspace session pinned to this project/);
    expect(nodes.list).toHaveBeenCalledTimes(1);
  });

  it('fleet nodes does not warn when an explicit key overrides a recorded project key', async () => {
    // A recorded project key IS present (the same context that makes the sibling
    // test warn); the explicit --wk must take precedence and suppress the advisory.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fleet-proj-'));
    const saved = {
      project: process.env.AGENT_RELAY_PROJECT,
      ws: process.env.RELAY_WORKSPACE_KEY,
      agentWs: process.env.AGENT_RELAY_WORKSPACE_KEY,
      api: process.env.RELAY_API_KEY,
    };
    process.env.AGENT_RELAY_PROJECT = projectRoot;
    delete process.env.RELAY_WORKSPACE_KEY;
    delete process.env.AGENT_RELAY_WORKSPACE_KEY;
    delete process.env.RELAY_API_KEY;
    writeProjectWorkspaceKey(path.join(projectRoot, '.agentworkforce/relay'), 'rk_project_broker');

    const warnings: string[] = [];
    const nodes = { list: vi.fn(async () => []) };
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn() as never,
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    try {
      await program.parseAsync(['fleet', 'nodes', '--wk', 'rk_live_alias'], { from: 'user' });
    } finally {
      if (saved.project === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = saved.project;
      if (saved.ws !== undefined) process.env.RELAY_WORKSPACE_KEY = saved.ws;
      if (saved.agentWs === undefined) delete process.env.AGENT_RELAY_WORKSPACE_KEY;
      else process.env.AGENT_RELAY_WORKSPACE_KEY = saved.agentWs;
      if (saved.api !== undefined) process.env.RELAY_API_KEY = saved.api;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }

    expect(warnings).toEqual([]);
    expect(nodes.list).toHaveBeenCalledTimes(1);
  });

  it('fleet status output redacts the node token and workspace key from the session', async () => {
    const logs: string[] = [];
    const nodes = { list: vi.fn(async () => [{ name: 'live-node', status: 'online', capabilities: [] }]) };
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      core: {
        getProjectPaths: () => ({ projectRoot: '/p', dataDir: '/p/.agentworkforce/relay', teamDir: '/p' }),
        exit: vi.fn(),
      } as never,
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn() as never,
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(['fleet', 'status'], { from: 'user' });

    const output = logs.join('\n');
    // The session carried rk_live_/nt_live_ secrets; the printed status must not.
    expect(output).not.toMatch(/rk_live_|nt_live_/);
    expect(output).toContain('[redacted]');
    // Non-secret identity is still shown.
    expect(output).toContain('node_1');
    expect(output).toContain('live-node');
  });

  it('registers `fleet serve` as a hidden stub that prints migration guidance and exits 1', async () => {
    const errors: string[] = [];
    const exit = vi.fn(() => {
      throw new Error('__exit__');
    });
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      error: (...args: unknown[]) => errors.push(args.join(' ')),
      log: () => undefined,
      warn: () => undefined,
      exit: exit as never,
    });

    const fleet = program.commands.find((command) => command.name() === 'fleet');
    const serve = fleet?.commands.find((command) => command.name() === 'serve');
    expect(serve).toBeDefined();
    expect((serve as unknown as { _hidden?: boolean })._hidden).toBe(true);

    await program
      .parseAsync(['fleet', 'serve', 'some-file.ts', '--enrollment-token', 'x'], {
        from: 'user',
      })
      .catch(() => undefined);

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toMatch(/'fleet serve' has been replaced/);
    expect(errors.join('\n')).toMatch(/relay node up/);
    expect(errors.join('\n')).toMatch(/relay cloud enroll/);
  });
});
