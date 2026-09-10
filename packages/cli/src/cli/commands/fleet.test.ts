import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { CloudFleetSandboxProvisionError } from '@agent-relay/cloud';
import { defineNode, invokeNodeHandler, spawn as fleetSpawn } from '@agent-relay/fleet';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

// `fleet status` fetches the broker session (which carries the node token and
// workspace key) and queries the engine nodes API; stub both so the redaction
// path can be exercised without a running broker.
vi.mock('../lib/broker-lifecycle.js', () => ({
  readBrokerConnection: vi.fn(() => ({ url: 'http://127.0.0.1:1', api_key: 'k', pid: 1, port: 1 })),
}));
// Only the driver client is stubbed. The rest of the module stays real so the
// fleet spawn handler can resolve a static harness config through the same code
// path a node runs.
vi.mock('@agent-relay/harness-driver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-relay/harness-driver')>()),
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
    async listAgents() {
      return [];
    }
    async listFleetInventory() {
      return { nodeName: 'live-node', agents: [] };
    }
    disconnect() {}
  },
}));

import { registerFleetCommands } from './fleet.js';
import { writeProjectWorkspaceKey } from '../lib/project-workspace-key.js';

const REPLAY_SANDBOX_ID = 'sbx_123e4567-e89b-42d3-a456-426614174000';
const REPLAY_SANDBOX_NAME = 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000';
const AGENT37_RELAYCAST_TARGET = {
  route: 'agent37-isolated' as const,
  baseUrl: 'https://agent37-cast.agentrelay.com',
  workspaceId: 'rw_abc',
  relaycastApiKey: 'rk_live_agent37_target',
};
const CANONICAL_RELAYCAST_TARGET = {
  route: 'canonical' as const,
  baseUrl: 'https://cast.agentrelay.com',
  workspaceId: 'rw_abc',
  relaycastApiKey: 'rk_live_canonical_target',
};

const LIVE_AGENT_CAPABILITY_NAME = 'relay:live-agents:v1';
const liveAgentCapabilities = (...names: string[]) => [
  {
    name: LIVE_AGENT_CAPABILITY_NAME,
    kind: 'capacity',
    metadata: { names },
  },
];

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

  it('must-fire: fleet agent list --node returns the named remote node agents', async () => {
    const nodes = {
      list: vi.fn(async () => [
        {
          name: 'finn-mini',
          status: 'online',
          live: true,
          handlersLive: true,
          activeAgents: 1,
          capabilities: liveAgentCapabilities('finn-worker'),
          tags: [],
        },
      ]),
    };
    const agents = { list: vi.fn(async () => []) };
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      core: {
        getProjectPaths: () => ({ projectRoot: '/p', dataDir: '/p/.agentworkforce/relay', teamDir: '/p' }),
        exit: vi.fn(),
      } as never,
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes, agents })) as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      ['fleet', 'agent', 'list', '--node', 'finn-mini', '--json', '--workspace-key', 'rk_live_test'],
      { from: 'user' }
    );

    expect(nodes.list).toHaveBeenCalledWith({ name: 'finn-mini' });
    const output = JSON.parse(logs[0]!);
    expect(output.perNode.map((row: { node: string }) => row.node)).toEqual(['finn-mini']);
    expect(output.perNode.map((row: { name: string }) => row.name)).toEqual(['finn-worker']);
    expect(output.perNode.some((row: { node: string }) => row.node === 'live-node')).toBe(false);
  });

  it('must-not-fire: fleet agent list --node excludes other nodes and roster-only rows', async () => {
    const nodes = {
      // Deliberately return an extra node even though the query names finn-mini:
      // the CLI must enforce the filter rather than trust a remote API to do it.
      list: vi.fn(async () => [
        {
          name: 'finn-mini',
          status: 'online',
          live: true,
          handlersLive: true,
          activeAgents: 1,
          capabilities: liveAgentCapabilities('finn-mini-worker'),
          tags: [],
        },
        {
          name: 'sf-mini',
          status: 'online',
          live: true,
          handlersLive: true,
          activeAgents: 1,
          capabilities: liveAgentCapabilities('sf-mini-worker'),
          tags: [],
        },
      ]),
    };
    const agents = {
      list: vi.fn(async () => [
        { name: 'sf-mini-worker', status: 'online' },
        { name: 'historical-roster-sediment', status: 'online' },
      ]),
    };
    const logs: string[] = [];
    const warnings: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      core: {
        getProjectPaths: () => ({ projectRoot: '/p', dataDir: '/p/.agentworkforce/relay', teamDir: '/p' }),
        exit: vi.fn(),
      } as never,
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({ nodes, agents })) as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await program.parseAsync(
      ['fleet', 'agent', 'list', '--node', 'finn-mini', '--workspace-key', 'rk_live_test'],
      { from: 'user' }
    );

    expect(nodes.list).toHaveBeenCalledWith({ name: 'finn-mini' });
    expect(agents.list).not.toHaveBeenCalled();
    const output = JSON.parse(logs[0]!);
    expect(output.perNode.map((row: { node: string }) => row.node)).toEqual(['finn-mini']);
    expect(output.perNode.map((row: { name: string }) => row.name)).toEqual(['finn-mini-worker']);
    expect(output.unplacedRoster).toEqual([]);
    // A targeted --node listing skips the roster fetch. Label that skip so
    // the reader does not read the missing roster check as a negative result.
    expect(warnings.join('\n')).toMatch(/roster not queried for a targeted --node listing/);
  });

  it('fleet nodes hides offline and direct pseudo-nodes by default', async () => {
    const listedNodes = [
      {
        name: 'sf-mini',
        status: 'online',
        live: true,
        handlersLive: true,
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
        name: 'detached-runner',
        status: 'online',
        live: true,
        handlersLive: false,
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
    expect(warnings.join('\n')).toMatch(/4 offline or non-fleet records hidden/);
    expect(warnings.join('\n')).toMatch(/--all/);
  });

  it('fleet nodes --all includes offline and direct history records', async () => {
    const listedNodes = [
      { name: 'old-runner', status: 'offline', live: false, capabilities: [], tags: [] },
      {
        name: 'detached-runner',
        status: 'online',
        live: true,
        handlersLive: false,
        capabilities: [],
        tags: [],
      },
      {
        name: 'sf-mini',
        status: 'online',
        live: true,
        handlersLive: true,
        capabilities: [],
        tags: [],
      },
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

    expect(JSON.parse(logs[0]!)).toEqual({
      nodes: [listedNodes[2], listedNodes[0], listedNodes[1], listedNodes[3]],
    });
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

  it('fleet spawn targets an exact node through the agent-scoped placement action', async () => {
    const placement = {
      spawn: vi.fn(async () => ({
        invocationId: 'inv_targeted',
        actionName: 'spawn',
        node: { name: 'sf-mini' },
        placement: { capability: 'spawn:codex', node: 'sf-mini', attempts: 1, queued: false },
      })),
    };
    const createAgentRelay = vi.fn(() => ({ messaging: { placement } }));
    const createFleetWorkspaceClient = vi.fn();
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: createFleetWorkspaceClient as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--name',
        'api-worker',
        '--task',
        'ACK and wait',
        '--target-node',
        'sf-mini',
        '--channel',
        'general',
        '--model',
        'gpt-5',
        '--cwd',
        '/srv/relay',
        '--organization',
        'Agent Workforce',
        '--project',
        'Relay',
        '--workstream',
        'fleet-metadata',
        '--role',
        'implementation',
        '--session-ref',
        'session-1',
        '--workspace-key',
        'rk_live_test',
        '--token',
        'at_live_lead',
      ],
      { from: 'user' }
    );

    expect(createAgentRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: 'at_live_lead',
      baseUrl: undefined,
    });
    expect(placement.spawn).toHaveBeenCalledWith({
      capability: 'spawn:codex',
      node: 'sf-mini',
      failFast: true,
      // #1430: acceptance by the node is not evidence of a launch, so a
      // targeted spawn asks the node to confirm unless told not to.
      confirm: true,
      confirmTimeoutMs: 120_000,
      input: {
        name: 'api-worker',
        cli: 'codex',
        task: 'ACK and wait',
        channels: ['general'],
        model: 'gpt-5',
        worker_cwd: '/srv/relay',
        organization: 'Agent Workforce',
        project: 'Relay',
        workstream: 'fleet-metadata',
        role: 'implementation',
        objective: 'ACK and wait',
        session_ref: 'session-1',
      },
    });
    // Exercise the actual two-package boundary: the CLI's targeted-placement
    // input must be readable by the Fleet DSL spawn handler, which forwards it
    // to the broker's registration path.
    const fleetNode = defineNode({
      name: 'sf-mini',
      capabilities: {
        'spawn:codex': fleetSpawn({ runtime: 'pty', command: 'codex' }),
      },
    });
    const spawnAgent = vi.fn(async () => undefined);
    // `mock.calls` is an array of argument lists, so the request object is the
    // first argument of the first call — not the first call itself.
    const [[{ input: handlerInput }]] = placement.spawn.mock.calls;
    await invokeNodeHandler(fleetNode, 'spawn:codex', handlerInput, {
      node: { name: fleetNode.name, capabilities: Object.keys(fleetNode.capabilities) },
      relay: { sendMessage: vi.fn() },
      spawnAgent,
    });
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ cwd: '/srv/relay' }),
        registrationMetadata: {
          organization: 'Agent Workforce',
          project: 'Relay',
          workstream: 'fleet-metadata',
          role: 'implementation',
          objective: 'ACK and wait',
        },
      })
    );
    expect(createFleetWorkspaceClient).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({
      invocation: { invocationId: 'inv_targeted' },
    });
  });

  it('fleet spawn --sandbox-provider agent37 provisions the isolated canary and uses a temporary launcher', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', undefined);
    const placement = {
      spawn: vi.fn(async () => ({
        invocationId: 'inv_sandbox',
        node: { name: 'e2b-codex' },
      })),
    };
    const register = vi.fn(async () => ({ token: 'at_live_launcher' }));
    const release = vi.fn(async () => ({ released: true, deleted: true }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: {
        info: vi.fn(async () => ({ id: 'rw_abc' })),
        register,
        release,
      },
    }));
    const createAgentRelay = vi.fn(() => ({ messaging: { placement } }));
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      providerId: 'agent37' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-1',
      nodeName: 'e2b-codex',
      sandboxId: 'sandbox-1',
      providerSandboxId: 'provider-sandbox-1',
      relayWorkspaceId: 'rw_abc',
      relaycastTarget: {
        route: 'agent37-isolated',
        baseUrl: 'https://agent37-cast.agentrelay.com',
        workspaceId: 'rw_abc',
        relaycastApiKey: 'rk_live_agent37_target',
      },
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
    }));
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: '/tmp/agent-relay-test/workspace-key.json',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'agent37',
        '--sandbox-id',
        REPLAY_SANDBOX_ID,
        '--sandbox-name',
        REPLAY_SANDBOX_NAME,
        '--sandbox-relayfile-path',
        '/live-review/run-123/**',
        '--name',
        'sandbox-worker',
        '--task',
        'Wait for VERIFY',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );
    const ensureInput = ensureCloudFleetSandbox.mock.calls[0]?.[0];
    expect(ensureInput).toEqual({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      maxAgents: 1,
      mountRelayfile: true,
      relayfilePaths: ['/live-review/run-123/**'],
      sandboxId: REPLAY_SANDBOX_ID,
      forceProvision: true,
      providerId: 'agent37',
      workloadProfile: 'long-running-agent',
      waitTimeoutMs: 90_000,
      name: REPLAY_SANDBOX_NAME,
    });
    expect(ensureInput?.name).toBe(`fleet-sandbox-${ensureInput?.sandboxId?.slice('sbx_'.length)}`);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^fleet-spawn-launcher-[a-f0-9]{8}$/),
        metadata: { purpose: 'fleet-spawn-launcher' },
      }),
      { strict: true }
    );
    expect(createAgentRelay).toHaveBeenCalledWith({
      token: 'at_live_launcher',
      baseUrl: 'https://agent37-cast.agentrelay.com',
    });
    expect(placement.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'spawn:codex',
        node: 'e2b-codex',
        confirm: true,
        input: expect.objectContaining({
          name: 'sandbox-worker',
          worker_cwd: '/workspace',
        }),
      })
    );
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^fleet-spawn-launcher-/),
        deleteAgent: true,
      })
    );
    expect(deleteCloudFleetSandbox).not.toHaveBeenCalled();
    expect(createWorkspaceRelay).toHaveBeenNthCalledWith(1, {
      workspaceKey: 'rk_live_agent37_target',
      baseUrl: 'https://agent37-cast.agentrelay.com',
    });
    expect(JSON.parse(logs[0]!)).toMatchObject({
      sandbox: {
        sandboxId: 'sandbox-1',
        providerSandboxId: 'provider-sandbox-1',
        providerId: 'agent37',
        nodeName: 'e2b-codex',
        relayfileMountPath: '/workspace',
      },
      invocation: { invocationId: 'inv_sandbox' },
      attachCommand:
        "agent-relay node agent attach 'sandbox-worker' --node 'e2b-codex' --mode drive --base-url 'https://agent37-cast.agentrelay.com'",
    });
  });

  it('fleet spawn --sandbox reuses an Agent37 target without a Relayfile mount', async () => {
    const placement = {
      spawn: vi.fn(async () => ({ invocationId: 'inv_reused', node: { name: 'agent37-codex' } })),
    };
    const register = vi.fn(async () => ({ token: 'at_live_agent37' }));
    const release = vi.fn(async () => ({ released: true, deleted: true }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })), register, release },
    }));
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'reused' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-1',
      nodeName: 'agent37-codex',
      status: 'online',
      activeAgents: 0,
      maxAgents: 1,
      providerId: 'agent37' as const,
      relaycastTarget: AGENT37_RELAYCAST_TARGET,
    }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({ messaging: { placement } })) as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: '/tmp/agent-relay-test/workspace-key.json',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'agent37',
        '--no-sandbox-relayfile',
        '--workspace-id',
        'rw_abc',
        '--name',
        'reused-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: AGENT37_RELAYCAST_TARGET.relaycastApiKey,
      baseUrl: AGENT37_RELAYCAST_TARGET.baseUrl,
    });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^fleet-spawn-launcher-/) }),
      { strict: true }
    );
    expect(release).toHaveBeenCalled();
  });

  it('applies and persists a returned target for a reused non-Agent37 provider', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_canonical_ambient');
    const placement = {
      spawn: vi.fn(async () => ({ invocationId: 'inv_reused_e2b', node: { name: 'e2b-codex' } })),
    };
    const createAgentRelay = vi.fn(() => ({ messaging: { placement } }));
    const register = vi.fn(async () => ({ token: 'at_live_launcher' }));
    const release = vi.fn(async () => ({ released: true, deleted: true }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })), register, release },
    }));
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'reused' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-e2b',
      nodeName: 'e2b-codex',
      status: 'online',
      activeAgents: 0,
      maxAgents: 1,
      providerId: 'e2b' as const,
      relaycastTarget: CANONICAL_RELAYCAST_TARGET,
    }));
    const persistWorkspaceRelaycastTarget = vi.fn(() => true);
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: '/tmp/agent-relay-test/workspace-key.json',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'e2b',
        '--no-sandbox-relayfile',
        '--workspace-id',
        'rw_abc',
        '--name',
        'reused-e2b-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: CANONICAL_RELAYCAST_TARGET.relaycastApiKey,
      baseUrl: CANONICAL_RELAYCAST_TARGET.baseUrl,
    });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^fleet-spawn-launcher-/) }),
      { strict: true }
    );
    expect(createAgentRelay).toHaveBeenCalledWith({
      token: 'at_live_launcher',
      baseUrl: CANONICAL_RELAYCAST_TARGET.baseUrl,
    });
    expect(persistWorkspaceRelaycastTarget).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'rk_live_test' }),
      CANONICAL_RELAYCAST_TARGET
    );
    expect(ensureCloudFleetSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'e2b',
        workloadProfile: 'standard-long-running-agent',
      })
    );
  });

  it('does not inherit a persisted Agent37 target for a legacy sandbox without a returned target', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_unproven_ambient');
    const placement = {
      spawn: vi.fn(async () => ({ invocationId: 'inv_legacy_reused', node: { name: 'e2b-codex' } })),
    };
    const createAgentRelay = vi.fn(() => ({ messaging: { placement } }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: {
        register: vi.fn(async () => ({ token: 'at_live_legacy_launcher' })),
        release: vi.fn(async () => ({ released: true, deleted: true })),
      },
    }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox: vi.fn(async () => ({
        outcome: 'reused' as const,
        cloudWorkspaceId: 'cloud-workspace',
        nodeId: 'node-e2b',
        nodeName: 'e2b-codex',
        status: 'online',
        activeAgents: 0,
        maxAgents: 1,
        providerId: 'e2b' as const,
      })),
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: '/tmp/agent-relay-test/workspace-key.json',
        workspaceId: 'rw_abc',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: AGENT37_RELAYCAST_TARGET.baseUrl,
        relaycastApiKey: AGENT37_RELAYCAST_TARGET.relaycastApiKey,
      }),
      persistWorkspaceRelaycastTarget: vi.fn(() => true),
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-provider',
        'e2b',
        '--no-sandbox-relayfile',
        '--workspace-id',
        'rw_abc',
        '--name',
        'legacy-reused-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: undefined,
      ignorePersistedRelaycastTarget: true,
    });
    expect(createAgentRelay).toHaveBeenCalledWith({
      token: 'at_live_legacy_launcher',
      baseUrl: undefined,
    });
  });

  it('fleet spawn --sandbox cleans up when the target cannot be persisted', async () => {
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-1',
      nodeName: 'agent37-codex',
      sandboxId: 'sandbox-1',
      relayWorkspaceId: 'rw_abc',
      relaycastTarget: AGENT37_RELAYCAST_TARGET,
      relayfileMounted: true,
    }));
    const createAgentRelay = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: '/tmp/agent-relay-test/workspace-key.json',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget: () => false,
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'agent37',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');
    expect(deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: 'cloud-workspace',
      sandboxId: 'sandbox-1',
    });
    expect(createAgentRelay).not.toHaveBeenCalled();
  });

  it('fleet spawn --sandbox deletes a freshly provisioned sandbox when dispatch fails', async () => {
    const placement = { spawn: vi.fn(async () => Promise.reject(new Error('dispatch failed'))) };
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-1',
      nodeName: 'agent37-codex',
      sandboxId: 'sandbox-1',
      providerSandboxId: 'provider-sandbox-1',
      relayWorkspaceId: 'rw_abc',
      relaycastTarget: AGENT37_RELAYCAST_TARGET,
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
      providerId: 'agent37' as const,
    }));
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({ messaging: { placement } })) as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: {
            info: vi.fn(async () => ({ id: 'rw_abc' })),
            register: vi.fn(async () => ({ token: 'at_live_isolated_launcher' })),
            release: vi.fn(async () => ({ released: true, deleted: true })),
          },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: (...args: unknown[]) => errors.push(args.join(' ')),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'flag',
        origin: 'test',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'agent37',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(errors.join('\n')).toContain('dispatch failed');
    expect(ensureCloudFleetSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        workloadProfile: 'long-running-agent',
      })
    );
    expect(deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: 'cloud-workspace',
      sandboxId: 'sandbox-1',
      providerId: 'agent37',
    });
  });

  it('preserves legacy custom sandbox names without sending a sandbox identity', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', undefined);
    const placement = {
      spawn: vi.fn(async () => ({
        invocationId: 'inv_legacy_sandbox',
        node: { name: 'custom-node' },
      })),
    };
    const register = vi.fn(async () => ({ token: 'at_live_launcher' }));
    const release = vi.fn(async () => ({ released: true, deleted: true }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })), register, release },
    }));
    const persistWorkspaceRelaycastTarget = vi.fn(() => true);
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      providerId: 'e2b' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-legacy',
      nodeName: 'custom-node',
      sandboxId: 'legacy-public-sandbox',
      providerSandboxId: 'legacy-provider-sandbox',
      relayWorkspaceId: 'rw_abc',
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
    }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({ messaging: { placement } })) as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'flag',
        origin: 'test',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--sandbox-name',
        'custom-node',
        '--name',
        'sandbox-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    const ensureInput = ensureCloudFleetSandbox.mock.calls[0]?.[0];
    expect(persistWorkspaceRelaycastTarget).not.toHaveBeenCalled();
    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: undefined,
      ignorePersistedRelaycastTarget: true,
    });
    expect(ensureInput).toMatchObject({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      forceProvision: true,
      workloadProfile: 'long-running-agent',
      name: 'custom-node',
    });
    expect(ensureInput).not.toHaveProperty('sandboxId');
  });

  it('rejects an explicit workspace ID that conflicts with the captured selection', async () => {
    const ensureCloudFleetSandbox = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: 'test',
        workspaceId: 'rw_captured',
      }),
      persistWorkspaceRelaycastTarget: vi.fn(() => true),
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--workspace-id',
          'rw_other',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');
    expect(ensureCloudFleetSandbox).not.toHaveBeenCalled();
  });

  it('accepts an explicit workspace ID matching the captured selection', async () => {
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-generated',
      nodeName: 'generated-node',
      sandboxId: 'generated-public-sandbox',
      relayWorkspaceId: 'rw_captured',
      relayfileMounted: true,
    }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({ messaging: { placement: { spawn: vi.fn() } } })) as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: {
            register: vi.fn(async () => ({ token: 'at_live_launcher' })),
            release: vi.fn(async () => ({ released: true, deleted: true })),
          },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'project',
        origin: 'test',
        workspaceId: 'rw_captured',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--no-sandbox-relayfile',
        '--workspace-id',
        'rw_captured',
        '--name',
        'sandbox-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );
    expect(ensureCloudFleetSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'rw_captured' })
    );
  });

  it('accepts a Cloud UUID request when Cloud returns its Relaycast workspace target', async () => {
    const cloudWorkspaceId = '50587328-0000-4000-8000-000000000003';
    const target = { ...CANONICAL_RELAYCAST_TARGET, workspaceId: 'rw_7ccfea89' };
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-generated',
      nodeName: 'generated-node',
      sandboxId: 'generated-public-sandbox',
      relayWorkspaceId: 'rw_7ccfea89',
      relaycastTarget: target,
      relayfileMounted: true,
    }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: {
        info: vi.fn(async () => ({ id: 'rw_7ccfea89' })),
        register: vi.fn(async () => ({ token: 'at_live_launcher' })),
        release: vi.fn(async () => ({ released: true, deleted: true })),
      },
    }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({ messaging: { placement: { spawn: vi.fn() } } })) as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => undefined,
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet', 'spawn', 'codex', '--sandbox', '--no-sandbox-relayfile',
        '--workspace-id', cloudWorkspaceId, '--name', 'sandbox-worker', '--task', 'Work',
        '--workspace-key', 'rk_live_test',
      ],
      { from: 'user' },
    );

    expect(ensureCloudFleetSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: cloudWorkspaceId }),
    );
    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: target.relaycastApiKey,
      baseUrl: target.baseUrl,
    });
  });

  it('rejects a Relaycast target whose workspace differs from Cloud identity', async () => {
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const ensureCloudFleetSandbox = vi.fn(async () => ({
      outcome: 'provisioned' as const,
      cloudWorkspaceId: 'cloud-workspace',
      nodeId: 'node-generated',
      nodeName: 'generated-node',
      sandboxId: 'generated-public-sandbox',
      relayWorkspaceId: 'rw_expected',
      relaycastTarget: { ...CANONICAL_RELAYCAST_TARGET, workspaceId: 'rw_other' },
      relayfileMounted: true,
    }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => { throw new Error('__exit__'); }) as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => undefined,
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(program.parseAsync(
      [
        'fleet', 'spawn', 'codex', '--sandbox', '--no-sandbox-relayfile',
        '--workspace-id', '50587328-0000-4000-8000-000000000003', '--name', 'sandbox-worker',
        '--task', 'Work', '--workspace-key', 'rk_live_test',
      ],
      { from: 'user' },
    )).rejects.toThrow('__exit__');
    expect(deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: 'cloud-workspace', sandboxId: 'generated-public-sandbox',
    });
  });

  it('generates a stable identity and matching name when neither option is supplied', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', undefined);
    const events: string[] = [];
    const ensureCloudFleetSandbox = vi
      .fn(async () => ({
        outcome: 'provisioned' as const,
        cloudWorkspaceId: 'cloud-workspace',
        nodeId: 'node-generated',
        nodeName: 'generated-node',
        sandboxId: 'generated-public-sandbox',
        providerSandboxId: 'generated-provider-sandbox',
        relayWorkspaceId: 'rw_abc',
        relaycastTarget: AGENT37_RELAYCAST_TARGET,
        relayfileMounted: true,
        relayfileMountPath: '/workspace',
      }))
      .mockImplementationOnce(async () => {
        events.push('ensure');
        return {
          outcome: 'provisioned' as const,
          cloudWorkspaceId: 'cloud-workspace',
          nodeId: 'node-generated',
          nodeName: 'generated-node',
          sandboxId: 'generated-public-sandbox',
          providerSandboxId: 'generated-provider-sandbox',
          relayWorkspaceId: 'rw_abc',
          relaycastTarget: AGENT37_RELAYCAST_TARGET,
          relayfileMounted: true,
          relayfileMountPath: '/workspace',
        };
      });
    const createWorkspaceRelay = vi.fn(() => {
      events.push('workspace-relay');
      return {
        workspace: {
          info: vi.fn(async () => ({ id: 'rw_abc' })),
          register: vi.fn(async () => ({ token: 'at_live_launcher' })),
          release: vi.fn(async () => ({ released: true, deleted: true })),
        },
      };
    });
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({
          messaging: { placement: { spawn: vi.fn(async () => ({ invocationId: 'inv_generated' })) } },
        })) as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      ensureCloudFleetSandbox,
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'flag',
        origin: 'test',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--sandbox',
        '--name',
        'sandbox-worker',
        '--task',
        'Work',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    const ensureInput = ensureCloudFleetSandbox.mock.calls[0]?.[0];
    expect(events.slice(0, 2)).toEqual(['ensure', 'workspace-relay']);
    expect(createWorkspaceRelay).not.toHaveBeenCalledWith(
      expect.objectContaining({ ignorePersistedRelaycastTarget: true })
    );
    expect(ensureInput?.sandboxId).toMatch(
      /^sbx_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(ensureInput?.name).toBe(`fleet-sandbox-${ensureInput?.sandboxId?.slice('sbx_'.length)}`);
  });

  it('rejects a replay sandbox name that does not match its identity', async () => {
    const ensureCloudFleetSandbox = vi.fn();
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: (...args: unknown[]) => errors.push(args.join(' ')),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-id',
          REPLAY_SANDBOX_ID,
          '--sandbox-name',
          'custom-node',
          '--workspace-id',
          'rw_abc',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(ensureCloudFleetSandbox).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--sandbox-name');
    expect(errors.join('\n')).toContain('when --sandbox-id is supplied');
  });

  it('rejects an invalid replay sandbox ID before provisioning', async () => {
    const ensureCloudFleetSandbox = vi.fn();
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: (...args: unknown[]) => errors.push(args.join(' ')),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox,
      deleteCloudFleetSandbox: vi.fn(async () => undefined),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-id',
          'sandbox-1',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(ensureCloudFleetSandbox).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--sandbox-id must match lowercase sbx_<UUID>');
  });

  it('preserves the stable sandbox ID for replay when Cloud reports an unknown outcome', async () => {
    const warnings: string[] = [];
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox: vi.fn(async () => {
        throw new CloudFleetSandboxProvisionError('malformed response', {
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
          sandboxId: REPLAY_SANDBOX_ID,
          nodeName: REPLAY_SANDBOX_NAME,
          outcomeUnknown: true,
        });
      }),
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-id',
          REPLAY_SANDBOX_ID,
          '--sandbox-name',
          REPLAY_SANDBOX_NAME,
          '--workspace-id',
          'rw_abc',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(deleteCloudFleetSandbox).not.toHaveBeenCalled();
    expect(warnings.join('\n')).toContain(`check Cloud Fleet for node '${REPLAY_SANDBOX_NAME}'`);
    expect(warnings.join('\n')).toContain(`--sandbox-id '${REPLAY_SANDBOX_ID}'`);
  });

  it('deletes only the checkpointed Daytona ID after a matched malformed provisioned response', async () => {
    const warnings: string[] = [];
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const createWorkspaceRelay = vi.fn();
    const ensureCloudFleetSandbox = vi.fn(async () => {
      throw new CloudFleetSandboxProvisionError('missing valid Daytona providerSandboxId', {
        cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
        sandboxId: REPLAY_SANDBOX_ID,
        nodeName: REPLAY_SANDBOX_NAME,
        providerId: 'daytona',
        confirmedProvisioned: true,
      });
    });
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox,
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'daytona',
          '--sandbox-id',
          REPLAY_SANDBOX_ID,
          '--sandbox-name',
          REPLAY_SANDBOX_NAME,
          '--workspace-id',
          'rw_abc',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(deleteCloudFleetSandbox).toHaveBeenCalledTimes(1);
    expect(deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      sandboxId: REPLAY_SANDBOX_ID,
      providerId: 'daytona',
    });
    expect(createWorkspaceRelay).not.toHaveBeenCalled();
    expect(ensureCloudFleetSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'daytona',
        workloadProfile: 'standard-long-running-agent',
      })
    );
    expect(warnings).toEqual([]);
  });

  it('deletes only the checkpointed Daytona ID after a matched malformed timeout response', async () => {
    const warnings: string[] = [];
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox: vi.fn(async () => {
        throw new CloudFleetSandboxProvisionError('missing valid Daytona providerSandboxId after timeout', {
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
          sandboxId: REPLAY_SANDBOX_ID,
          nodeName: REPLAY_SANDBOX_NAME,
          providerId: 'daytona',
          confirmedProvisioned: true,
        });
      }),
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'daytona',
          '--sandbox-id',
          REPLAY_SANDBOX_ID,
          '--sandbox-name',
          REPLAY_SANDBOX_NAME,
          '--workspace-id',
          'rw_abc',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(deleteCloudFleetSandbox).toHaveBeenCalledTimes(1);
    expect(deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      sandboxId: REPLAY_SANDBOX_ID,
      providerId: 'daytona',
    });
    expect(warnings).toEqual([]);
  });

  it('pins cleanup to the requested E2B provider for a known post-provision failure', async () => {
    const deleteCloudFleetSandbox = vi.fn(async () => undefined);
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox: vi.fn(async () => {
        throw new CloudFleetSandboxProvisionError('Cloud did not prove requested provider e2b.', {
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
          sandboxId: 'sandbox-e2b',
          nodeName: 'e2b-codex',
          providerId: 'e2b',
        });
      }),
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'e2b',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      sandboxId: 'sandbox-e2b',
      providerId: 'e2b',
    });
  });

  it('keeps the caller sandbox ID for replay guidance after an identifier-less server failure', async () => {
    const warnings: string[] = [];
    const deleteCloudFleetSandbox = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox: vi.fn(async () => {
        throw new CloudFleetSandboxProvisionError('request interrupted', {
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
          nodeName: 'daytona-codex',
          providerId: 'e2b',
          outcomeUnknown: true,
        });
      }),
      deleteCloudFleetSandbox,
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'e2b',
          '--sandbox-id',
          REPLAY_SANDBOX_ID,
          '--sandbox-name',
          REPLAY_SANDBOX_NAME,
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(deleteCloudFleetSandbox).not.toHaveBeenCalled();
    expect(warnings.join('\n')).toContain("check Cloud Fleet for node 'daytona-codex'");
    expect(warnings.join('\n')).toContain(`--sandbox-id '${REPLAY_SANDBOX_ID}'`);
  });

  it('warns when an unmounted sandbox cannot be cleaned up automatically', async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn(() => ({
          workspace: { info: vi.fn(async () => ({ id: 'rw_abc' })) },
        })) as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: (...args: unknown[]) => errors.push(args.join(' ')),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      ensureCloudFleetSandbox: vi.fn(async () => ({
        outcome: 'provisioned' as const,
        cloudWorkspaceId: 'cloud-workspace',
        nodeId: 'node-1',
        nodeName: 'daytona-codex',
        sandboxId: 'sandbox-1',
        providerSandboxId: 'provider-sandbox-1',
        relayWorkspaceId: 'rw_abc',
        relaycastTarget: AGENT37_RELAYCAST_TARGET,
        relayfileMounted: false,
        providerId: 'agent37' as const,
      })),
      resolveWorkspaceSelection: () => ({
        key: 'rk_live_test',
        source: 'flag',
        origin: 'test',
        workspaceId: 'rw_abc',
      }),
      persistWorkspaceRelaycastTarget: () => true,
      deleteCloudFleetSandbox: vi.fn(async () => Promise.reject(new Error('delete failed'))),
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args.join(' ')),
      error: () => undefined,
    });

    await expect(
      program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--sandbox',
          '--sandbox-provider',
          'agent37',
          '--name',
          'sandbox-worker',
          '--task',
          'Work',
          '--workspace-key',
          'rk_live_test',
          '--token',
          'at_live_lead',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('__exit__');

    expect(errors.join('\n')).toContain('without the required Relayfile mount');
    expect(warnings.join('\n')).toContain('may still be running');
    expect(warnings.join('\n')).toContain('delete failed');
  });

  it('fleet spawn --no-confirm accepts an unconfirmed targeted dispatch', async () => {
    const placement = {
      spawn: vi.fn(async () => ({
        invocationId: 'inv_unconfirmed',
        actionName: 'spawn',
        node: { name: 'sf-mini' },
        placement: {
          capability: 'spawn:codex',
          node: 'sf-mini',
          attempts: 1,
          queued: false,
          confirmed: false,
        },
      })),
    };
    const createAgentRelay = vi.fn(() => ({ messaging: { placement } }));
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: () => undefined,
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--name',
        'api-worker',
        '--task',
        'ACK and wait',
        '--node',
        'sf-mini',
        '--no-confirm',
        '--workspace-key',
        'rk_live_test',
        '--token',
        'at_live_lead',
      ],
      { from: 'user' }
    );

    // The escape hatch must actually disable confirmation, and must not smuggle
    // a timeout through that would imply the caller is still waiting.
    const call = placement.spawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.confirm).toBe(false);
    expect(call).not.toHaveProperty('confirmTimeoutMs');
  });

  it('fleet spawn rejects a non-numeric --confirm-timeout', async () => {
    const placement = { spawn: vi.fn() };
    const program = new Command();
    program.exitOverride();
    const errors: unknown[] = [];
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn(() => ({ messaging: { placement } })) as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: () => undefined,
        error: (message: unknown) => errors.push(message),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--name',
        'api-worker',
        '--task',
        'ACK and wait',
        '--node',
        'sf-mini',
        '--confirm-timeout',
        'soon',
        '--workspace-key',
        'rk_live_test',
        '--token',
        'at_live_lead',
      ],
      { from: 'user' }
    );

    expect(placement.spawn).not.toHaveBeenCalled();
    expect(String(errors.join('\n'))).toContain('--confirm-timeout');
  });

  it('fleet spawn uses workspace-scoped automatic placement when no node is named', async () => {
    const spawn = vi.fn(async () => ({ invocation_id: 'inv_auto', status: 'accepted' }));
    const createFleetWorkspaceClient = vi.fn(() => ({ agents: { spawn } }));
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: createFleetWorkspaceClient as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'spawn',
        'codex',
        '--name',
        'api-worker',
        '--task',
        'Review the diff',
        '--channel',
        'general',
        '--persona',
        'Reviewer',
        '--model',
        'gpt-5',
        '--cwd',
        '/srv/relay',
        '--organization',
        'Agent Workforce',
        '--project',
        'Relay',
        '--workstream',
        'fleet-metadata',
        '--role',
        'reviewer',
        '--objective',
        'Review the fleet change',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    expect(createFleetWorkspaceClient).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: undefined,
    });
    expect(spawn).toHaveBeenCalledWith({
      name: 'api-worker',
      cli: 'codex',
      task: 'Review the diff',
      channel: 'general',
      persona: 'Reviewer',
      metadata: {
        model: 'gpt-5',
        worker_cwd: '/srv/relay',
        organization: 'Agent Workforce',
        project: 'Relay',
        workstream: 'fleet-metadata',
        role: 'reviewer',
        objective: 'Review the fleet change',
      },
    });
    expect(JSON.parse(logs[0]!)).toEqual({
      invocation: { invocation_id: 'inv_auto', status: 'accepted' },
    });
  });

  it('fleet spawn mints and removes a temporary launcher for tokenless targeted placement', async () => {
    const previousToken = process.env.RELAY_AGENT_TOKEN;
    delete process.env.RELAY_AGENT_TOKEN;
    const placement = {
      spawn: vi.fn(async () => ({
        invocationId: 'inv_targeted_tokenless',
        actionName: 'spawn',
        node: { name: 'sf-mini' },
      })),
    };
    const createAgentRelay = vi.fn(() => ({ messaging: { placement } }));
    const register = vi.fn(async () => ({ token: 'at_live_temporary_launcher' }));
    const release = vi.fn(async () => ({ released: true, deleted: true }));
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: { register, release },
    }));
    const createFleetWorkspaceClient = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: createFleetWorkspaceClient as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    try {
      await program.parseAsync(
        [
          'fleet',
          'spawn',
          'codex',
          '--name',
          'api-worker',
          '--task',
          'ACK',
          '--node',
          'sf-mini',
          '--workspace-key',
          'rk_live_test',
        ],
        { from: 'user' }
      );
    } finally {
      if (previousToken === undefined) delete process.env.RELAY_AGENT_TOKEN;
      else process.env.RELAY_AGENT_TOKEN = previousToken;
    }

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: undefined,
    });
    expect(register).toHaveBeenCalledWith(
      {
        name: expect.stringMatching(/^fleet-spawn-launcher-[a-f0-9]{8}$/),
        metadata: { purpose: 'fleet-spawn-launcher' },
      },
      { strict: true }
    );
    expect(createAgentRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: 'at_live_temporary_launcher',
      baseUrl: undefined,
    });
    expect(placement.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'spawn:codex',
        node: 'sf-mini',
        confirm: true,
      })
    );
    expect(release).toHaveBeenCalledWith({
      name: expect.stringMatching(/^fleet-spawn-launcher-[a-f0-9]{8}$/),
      reason: 'Temporary fleet spawn launcher completed',
      deleteAgent: true,
    });
    expect(createFleetWorkspaceClient).not.toHaveBeenCalled();
  });

  it('fleet spawn does not release an existing agent when temporary launcher registration fails', async () => {
    const previousToken = process.env.RELAY_AGENT_TOKEN;
    delete process.env.RELAY_AGENT_TOKEN;
    const registrationError = new Error('Agent already exists');
    const register = vi.fn(async () => {
      throw registrationError;
    });
    const release = vi.fn();
    const createWorkspaceRelay = vi.fn(() => ({
      workspace: { register, release },
    }));
    const createAgentRelay = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: createAgentRelay as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: vi.fn(),
        error: vi.fn(),
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      },
      createFleetWorkspaceClient: vi.fn() as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    try {
      await expect(
        program.parseAsync(
          [
            'fleet',
            'spawn',
            'codex',
            '--name',
            'api-worker',
            '--task',
            'ACK',
            '--node',
            'sf-mini',
            '--workspace-key',
            'rk_live_test',
          ],
          { from: 'user' }
        )
      ).rejects.toThrow('__exit__');
    } finally {
      if (previousToken === undefined) delete process.env.RELAY_AGENT_TOKEN;
      else process.env.RELAY_AGENT_TOKEN = previousToken;
    }

    expect(register).toHaveBeenCalledWith(
      {
        name: expect.stringMatching(/^fleet-spawn-launcher-[a-f0-9]{8}$/),
        metadata: { purpose: 'fleet-spawn-launcher' },
      },
      { strict: true }
    );
    expect(release).not.toHaveBeenCalled();
    expect(createAgentRelay).not.toHaveBeenCalled();
  });

  it('fleet release delegates to the workspace lifecycle API with a default reason and actor', async () => {
    const release = vi.fn(async () => ({
      name: 'api-worker',
      released: true,
      deleted: false,
      reason: 'Work accepted',
    }));
    const createFleetWorkspaceClient = vi.fn(() => ({ agents: { release } }));
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: createFleetWorkspaceClient as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(['fleet', 'release', 'api-worker', '--workspace-key', 'rk_live_test'], {
      from: 'user',
    });

    expect(release).toHaveBeenCalledWith({
      name: 'api-worker',
      reason: expect.stringMatching(/^fleet agent released \(actor: .+\)$/),
      deleteAgent: false,
    });
    expect(JSON.parse(logs[0]!)).toMatchObject({ name: 'api-worker', released: true });
  });

  it('fleet release passes an explicit --reason through unchanged, with the actor still attributed', async () => {
    const release = vi.fn(async () => ({
      name: 'api-worker',
      released: true,
      deleted: false,
      reason: 'Work accepted',
    }));
    const createFleetWorkspaceClient = vi.fn(() => ({ agents: { release } }));
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: vi.fn() as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn() as never,
      },
      createFleetWorkspaceClient: createFleetWorkspaceClient as never,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      [
        'fleet',
        'release',
        'api-worker',
        '--reason',
        'Work accepted',
        '--delete-agent',
        '--workspace-key',
        'rk_live_test',
      ],
      { from: 'user' }
    );

    expect(release).toHaveBeenCalledWith({
      name: 'api-worker',
      reason: expect.stringMatching(/^Work accepted \(actor: .+\)$/),
      deleteAgent: true,
    });
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
