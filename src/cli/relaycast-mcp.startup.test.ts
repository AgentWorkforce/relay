import { afterEach, describe, expect, it, vi } from 'vitest';

type LoadOptions = {
  wsClientThrows?: boolean;
  connectThrows?: boolean;
  forceEntrypoint?: boolean;
};

type RelayBehavior = {
  inboxImpl: (token: string) => Promise<unknown>;
  registerImpl: (input: { name: string; type?: string }) => Promise<{ name?: string; token: string }>;
};

async function loadRelaycastMcpModule(options: LoadOptions = {}) {
  vi.resetModules();

  const originalArgv = process.argv;
  if (options.forceEntrypoint) {
    process.argv = ['node', '/entry'];
    const realpathSync = vi.fn(() => '/entry');
    vi.doMock('node:fs', () => ({
      default: { realpathSync },
      realpathSync,
    }));
  }

  const serverInstances: FakeMcpServer[] = [];
  const wsBridgeInstances: FakeWsBridge[] = [];
  const subscriptionInstances: FakeSubscriptionManager[] = [];
  const channelToolGetters: Array<() => unknown> = [];
  const resourceGetters: Array<{ getAgentClient: () => unknown; getRelay: () => unknown }> = [];
  const telemetry = { capture: vi.fn() };
  const behavior: RelayBehavior = {
    inboxImpl: vi.fn(async () => ({ items: [] })),
    registerImpl: vi.fn(async ({ name }) => ({ name, token: `at_live_${name}` })),
  };
  const relayInstances: Array<{
    config: Record<string, unknown>;
    origin: Record<string, unknown>;
    inbox: ReturnType<typeof vi.fn>;
    registerOrRotate: ReturnType<typeof vi.fn>;
    as: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeSubscriptionManager {
    clear = vi.fn();

    constructor() {
      subscriptionInstances.push(this);
    }
  }

  class FakeWsBridge {
    start = vi.fn();
    stop = vi.fn();

    constructor(
      public readonly client: unknown,
      public readonly subscriptions: FakeSubscriptionManager,
      public readonly onResourceUpdated: (uri: string) => void
    ) {
      wsBridgeInstances.push(this);
    }
  }

  class FakeTransport {}

  class FakeMcpServer {
    readonly tools = new Map<string, { config: unknown; handler: (input: any) => Promise<any> }>();
    readonly prompts = new Map<string, { config: unknown; handler: () => Promise<any> }>();
    readonly connect = vi.fn(async (_transport: unknown) => {
      if (options.connectThrows) {
        throw new Error('stdio connect failed');
      }
    });
    readonly server: {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools?: Array<Record<string, unknown>> }>>;
      setRequestHandler: ReturnType<typeof vi.fn>;
      sendResourceUpdated: ReturnType<typeof vi.fn>;
    };
    listToolsHandler?: (req: unknown, extra: unknown) => Promise<{ tools?: Array<Record<string, unknown>> }>;

    constructor(_info: unknown, _capabilities: unknown) {
      this.server = {
        _requestHandlers: new Map([
          [
            'tools/list',
            vi.fn(async () => ({
              tools: [
                {
                  name: 'post_message',
                  title: 'Post Message',
                  execution: { hidden: true },
                  outputSchema: { type: 'object' },
                  _meta: { hidden: true },
                  description: 'Send a channel message',
                },
              ],
            })),
          ],
        ]),
        setRequestHandler: vi.fn((_schema: unknown, handler: (req: unknown, extra: unknown) => Promise<any>) => {
          this.listToolsHandler = handler;
        }),
        sendResourceUpdated: vi.fn(async (_payload: unknown) => undefined),
      };
      serverInstances.push(this);
    }

    registerTool(name: string, config: unknown, handler: (input: any) => Promise<any>): void {
      this.tools.set(name, { config, handler });
    }

    registerPrompt(name: string, config: unknown, handler: () => Promise<any>): void {
      this.prompts.set(name, { config, handler });
    }
  }

  const createInternalRelayCast = vi.fn((config: Record<string, unknown>, origin: Record<string, unknown>) => {
    const inbox = vi.fn(async (token?: string) => behavior.inboxImpl(String(token ?? '')));
    const registerOrRotate = vi.fn(async (input: { name: string; type?: string }) => behavior.registerImpl(input));
    const as = vi.fn((token: string) => ({
      inbox: vi.fn(async () => behavior.inboxImpl(token)),
      token,
    }));
    relayInstances.push({ config, origin, inbox, registerOrRotate, as });
    return {
      agents: { registerOrRotate },
      as,
    };
  });

  const createInternalWsClient = vi.fn((config: Record<string, unknown>, origin: Record<string, unknown>) => {
    if (options.wsClientThrows) {
      throw new Error('ws init failed');
    }
    return { config, origin };
  });

  const enablePiggyback = vi.fn();
  const registerResourceDefinitions = vi.fn(
    (_server: unknown, getAgentClient: () => unknown, getRelay: () => unknown) => {
      resourceGetters.push({ getAgentClient, getRelay });
    }
  );
  const registerChannelTools = vi.fn((_server: unknown, getAgentClient: () => unknown) => {
    channelToolGetters.push(getAgentClient);
  });
  const registerMessagingTools = vi.fn();
  const registerFeatureTools = vi.fn();
  const registerProgrammabilityTools = vi.fn();
  const createMcpTelemetry = vi.fn(() => telemetry);
  const createInitialSession = vi.fn((initial: Record<string, unknown>) => ({
    ...initial,
    wsBridge: null,
    subscriptions: null,
    wsInitAttempted: false,
  }));

  vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: FakeMcpServer }));
  vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: FakeTransport }));
  vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({ ListToolsRequestSchema: { type: 'tools/list' } }));
  vi.doMock('@relaycast/sdk/internal', () => ({ createInternalRelayCast, createInternalWsClient }));
  vi.doMock('@relaycast/mcp', () => ({ MCP_VERSION: 'test-mcp-version' }));
  vi.doMock('@relaycast/mcp/dist/piggyback.js', () => ({ enablePiggyback }));
  vi.doMock('@relaycast/mcp/dist/resources/definitions.js', () => ({ registerResourceDefinitions }));
  vi.doMock('@relaycast/mcp/dist/resources/subscriptions.js', () => ({ SubscriptionManager: FakeSubscriptionManager }));
  vi.doMock('@relaycast/mcp/dist/tools/channels.js', () => ({ registerChannelTools }));
  vi.doMock('@relaycast/mcp/dist/tools/features.js', () => ({ registerFeatureTools }));
  vi.doMock('@relaycast/mcp/dist/tools/messaging.js', () => ({ registerMessagingTools }));
  vi.doMock('@relaycast/mcp/dist/tools/programmability.js', () => ({ registerProgrammabilityTools }));
  vi.doMock('@relaycast/mcp/dist/telemetry.js', () => ({ createMcpTelemetry }));
  vi.doMock('@relaycast/mcp/dist/types.js', () => ({ createInitialSession }));
  vi.doMock('@relaycast/mcp/dist/resources/ws-bridge.js', () => ({ WsBridge: FakeWsBridge }));

  const mod = await import('./relaycast-mcp.js');
  if (options.forceEntrypoint) {
    process.argv = originalArgv;
  }

  return {
    mod,
    mocks: {
      behavior,
      serverInstances,
      relayInstances,
      wsBridgeInstances,
      subscriptionInstances,
      channelToolGetters,
      resourceGetters,
      telemetry,
      createInternalRelayCast,
      createInternalWsClient,
      enablePiggyback,
      registerResourceDefinitions,
      registerChannelTools,
      registerMessagingTools,
      registerFeatureTools,
      registerProgrammabilityTools,
      createInitialSession,
      FakeTransport,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('relaycast-mcp startup helpers', () => {
  it('parses startup options and helper flags from the environment', async () => {
    const { mod } = await loadRelaycastMcpModule();
    vi.stubEnv('RELAY_API_KEY', 'rk_live_env');
    vi.stubEnv('RELAY_BASE_URL', 'https://api.relaycast.dev///');
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_env');
    vi.stubEnv('RELAY_AGENT_NAME', '');
    vi.stubEnv('RELAY_CLAW_NAME', 'FallbackClaw');
    vi.stubEnv('RELAY_AGENT_TYPE', 'human');
    vi.stubEnv('RELAY_STRICT_AGENT_NAME', ' yes ');

    expect(mod.normalizeBaseUrl('https://api.relaycast.dev///')).toBe('https://api.relaycast.dev');
    expect(mod.envFlagEnabled(' on ')).toBe(true);
    expect(mod.envFlagEnabled('0')).toBe(false);
    expect(mod.normalizeAgentType('agent')).toBe('agent');
    expect(mod.normalizeAgentType('robot')).toBeUndefined();
    expect(mod.optionsFromEnv()).toEqual({
      apiKey: 'rk_live_env',
      baseUrl: 'https://api.relaycast.dev///',
      agentToken: 'at_live_env',
      agentName: '',
      agentType: 'human',
      strictAgentName: true,
    });
  });
});

describe('createPatchedRelayMcpServer', () => {
  it('registers startup tools, prompt text, and strips execution metadata from tools/list', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          ok: true,
          data: { api_key: 'rk_live_created', workspace_name: 'Test Workspace' },
        }),
      }))
    );

    mod.createPatchedRelayMcpServer({ baseUrl: 'https://api.relaycast.dev/' });
    const server = mocks.serverInstances[0];
    const registerTool = server.tools.get('register');
    const createWorkspaceTool = server.tools.get('create_workspace');
    const setWorkspaceKeyTool = server.tools.get('set_workspace_key');
    const prompt = server.prompts.get('system');

    expect(registerTool).toBeDefined();
    expect(createWorkspaceTool).toBeDefined();
    expect(setWorkspaceKeyTool).toBeDefined();
    expect(prompt).toBeDefined();
    expect(mocks.enablePiggyback).toHaveBeenCalledTimes(1);
    expect(mocks.registerChannelTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerMessagingTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerFeatureTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerProgrammabilityTools).toHaveBeenCalledTimes(1);

    expect(() => mocks.resourceGetters[0].getRelay()).toThrow(
      'Workspace key not configured. Set RELAY_API_KEY at startup, or call "create_workspace" or "set_workspace_key" first.'
    );
    expect(() => mocks.channelToolGetters[0]()).toThrow('Not registered. Call the "register" tool first.');
    await expect(registerTool?.handler({ name: 'WorkerA' })).rejects.toThrow(
      'Workspace key not configured. Call "create_workspace" or "set_workspace_key" first.'
    );

    const workspaceResult = await createWorkspaceTool?.handler({ name: 'Coverage Workspace' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.relaycast.dev/v1/workspaces',
      expect.objectContaining({ method: 'POST' })
    );
    expect(workspaceResult.structuredContent).toEqual({
      api_key: 'rk_live_created',
      workspace_name: 'Test Workspace',
    });

    const registerResult = await registerTool?.handler({
      name: 'WorkerA',
      type: 'human',
      persona: 'Coverage tester',
      metadata: { model: 'gpt-5' },
    });
    const workspaceRelay = mocks.relayInstances.find((instance) => instance.config.apiKey === 'rk_live_created');
    expect(workspaceRelay?.registerOrRotate).toHaveBeenCalledWith({
      name: 'WorkerA',
      type: 'human',
      persona: 'Coverage tester',
      metadata: { model: 'gpt-5' },
    });
    expect(registerResult.structuredContent).toMatchObject({
      token: 'at_live_WorkerA',
      registered_name: 'WorkerA',
    });

    const agentClient = mocks.channelToolGetters[0]();
    expect(agentClient).toMatchObject({ token: 'at_live_WorkerA' });

    const toolsList = await server.listToolsHandler?.({}, {});
    expect(toolsList?.tools).toEqual([
      {
        name: 'post_message',
        title: 'Post Message',
        description: 'Send a channel message',
      },
    ]);

    const promptResult = await prompt?.handler();
    expect(promptResult.messages[0].content.text).toContain('create_workspace');
    expect(mocks.telemetry.capture).toHaveBeenCalledWith('relaycast_mcp_server_started', {
      source_surface: 'mcp',
      transport: 'unknown',
    });
  });

  it('reinitializes the websocket bridge when the workspace changes', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    mod.createPatchedRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://api.relaycast.dev',
    });

    const server = mocks.serverInstances[0];
    const bridge = mocks.wsBridgeInstances[0];
    const subscriptions = mocks.subscriptionInstances[0];
    const setWorkspaceKeyTool = server.tools.get('set_workspace_key');

    expect(bridge?.start).toHaveBeenCalledTimes(1);
    await expect(setWorkspaceKeyTool?.handler({ api_key: 'bad_key' })).rejects.toThrow(
      'Workspace key must start with "rk_live_"'
    );

    const result = await setWorkspaceKeyTool?.handler({ api_key: 'rk_live_other' });
    expect(bridge?.stop).toHaveBeenCalledTimes(1);
    expect(subscriptions?.clear).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({
      message: 'Workspace key set. Previous agent session was cleared; call "register" again.',
    });
  });

  it('preserves the current agent session when the workspace key does not change', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    mod.createPatchedRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://api.relaycast.dev',
    });

    const server = mocks.serverInstances[0];
    const bridge = mocks.wsBridgeInstances[0];
    const setWorkspaceKeyTool = server.tools.get('set_workspace_key');

    const result = await setWorkspaceKeyTool?.handler({ api_key: 'rk_live_existing' });

    expect(bridge?.stop).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      message: 'Workspace key set.',
    });
    expect(mocks.channelToolGetters[0]()).toMatchObject({ token: 'at_live_existing' });
  });

  it('marks websocket initialization attempted even when bridge setup fails', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule({ wsClientThrows: true });
    mod.createPatchedRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
    });

    expect(mocks.createInternalWsClient).toHaveBeenCalledTimes(1);
    expect(mocks.wsBridgeInstances).toHaveLength(0);
    expect(mocks.telemetry.capture).toHaveBeenCalledWith('relaycast_mcp_session_authenticated', {
      source_surface: 'mcp',
      agent_name: 'PinnedWorker',
    });
  });

  it('swallows websocket resource update emission failures', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    mod.createPatchedRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
    });

    const server = mocks.serverInstances[0];
    const bridge = mocks.wsBridgeInstances[0];
    server.server.sendResourceUpdated.mockRejectedValueOnce(new Error('emit failed'));

    bridge?.onResourceUpdated('relaycast://channels/general');
    await Promise.resolve();

    expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'relaycast://channels/general' });
  });
});

describe('resolvePatchedStdioBootstrapOptions', () => {
  it('returns options unchanged when workspace bootstrap inputs are incomplete', async () => {
    const { mod } = await loadRelaycastMcpModule();
    await expect(mod.resolvePatchedStdioBootstrapOptions({ agentName: 'WorkerA' })).resolves.toEqual({
      agentName: 'WorkerA',
    });
  });

  it('reuses an existing agent token when inbox auth succeeds', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    const options = {
      apiKey: 'rk_live_workspace',
      baseUrl: 'https://api.relaycast.dev',
      agentName: 'WorkerA',
      agentToken: 'at_live_existing',
      agentType: 'agent' as const,
    };

    const result = await mod.resolvePatchedStdioBootstrapOptions(options);

    expect(result).toEqual(options);
    expect(mocks.behavior.inboxImpl).toHaveBeenCalledWith('at_live_existing');
    expect(mocks.behavior.registerImpl).not.toHaveBeenCalled();
  });

  it('rotates the agent token when the previous token is unauthorized', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    mocks.behavior.inboxImpl = vi.fn(async () => {
      throw { statusCode: 401 };
    });
    mocks.behavior.registerImpl = vi.fn(async () => ({
      name: 'WorkerA-rebound',
      token: 'at_live_rebound',
    }));

    const result = await mod.resolvePatchedStdioBootstrapOptions({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentToken: 'at_live_stale',
      agentType: 'human',
    });

    expect(mocks.behavior.registerImpl).toHaveBeenCalledWith({
      name: 'WorkerA',
      type: 'human',
    });
    expect(result).toEqual({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA-rebound',
      agentToken: 'at_live_rebound',
      agentType: 'human',
    });
  });

  it('rethrows non-auth inbox failures instead of silently rebinding', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();
    const failure = new Error('relay unavailable');
    mocks.behavior.inboxImpl = vi.fn(async () => {
      throw failure;
    });

    await expect(
      mod.resolvePatchedStdioBootstrapOptions({
        apiKey: 'rk_live_workspace',
        agentName: 'WorkerA',
        agentToken: 'at_live_existing',
      })
    ).rejects.toBe(failure);
  });
});

describe('startPatchedStdio', () => {
  it('boots the MCP server on stdio transport after bootstrap', async () => {
    const { mod, mocks } = await loadRelaycastMcpModule();

    await mod.startPatchedStdio({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentToken: 'at_live_existing',
    });

    const server = mocks.serverInstances[0];
    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(server.connect.mock.calls[0][0]).toBeInstanceOf(mocks.FakeTransport);
    expect(mocks.telemetry.capture).toHaveBeenCalledWith('relaycast_mcp_server_started', {
      source_surface: 'mcp',
      transport: 'stdio',
    });
  });

  it('reports entrypoint startup failures to stderr and exits', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await loadRelaycastMcpModule({ forceEntrypoint: true, connectThrows: true });

    await vi.waitFor(() => {
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('stdio connect failed'));
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
