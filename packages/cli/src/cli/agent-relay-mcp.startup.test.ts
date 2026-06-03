import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LoadOptions = {
  wsClientThrows?: boolean;
  connectThrows?: boolean;
  forceEntrypoint?: boolean;
};

type RelayBehavior = {
  createWorkspaceImpl: (name: string) => Promise<Record<string, unknown>>;
  inboxImpl: (token: string) => Promise<unknown>;
  registerImpl: (input: { name: string; type?: string }) => Promise<{ name?: string; token: string }>;
};

async function loadAgentRelayMcpModule(options: LoadOptions = {}) {
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
  const wsClientInstances: FakeWsClient[] = [];
  const telemetryTrack = vi.fn();
  const telemetryInit = vi.fn();
  const telemetryShutdown = vi.fn(async () => undefined);
  const relayInstances: Array<{
    config: Record<string, unknown>;
    registerOrRotate: ReturnType<typeof vi.fn>;
    agentsList: ReturnType<typeof vi.fn>;
    spawn: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    as: ReturnType<typeof vi.fn>;
  }> = [];
  const behavior: RelayBehavior = {
    createWorkspaceImpl: vi.fn(async () => ({
      workspaceKey: 'rk_live_created',
      workspaceName: 'Test Workspace',
    })),
    inboxImpl: vi.fn(async () => ({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    })),
    registerImpl: vi.fn(async ({ name }) => ({ name, token: `at_live_${name}` })),
  };

  class FakeResourceTemplate {
    constructor(
      public readonly template: string,
      public readonly options: unknown
    ) {}
  }

  class FakeWsClient {
    readonly handlers = new Map<string, Set<(event: unknown) => void>>();
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();

    constructor(public readonly config: Record<string, unknown>) {
      if (options.wsClientThrows) {
        throw new Error('ws init failed');
      }
      wsClientInstances.push(this);
    }

    on(event: string, handler: (event: unknown) => void): () => void {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
      return () => handlers.delete(handler);
    }

    emit(event: unknown): void {
      for (const handler of this.handlers.get('*') ?? []) {
        handler(event);
      }
    }
  }

  class FakeTransport {}

  class FakeMcpServer {
    readonly tools = new Map<string, { config: unknown; handler: (input: any) => Promise<any> }>();
    readonly prompts = new Map<string, { config: unknown; handler: () => Promise<any> }>();
    readonly resources = new Map<
      string,
      { uriOrTemplate: unknown; config: unknown; handler: (...args: any[]) => Promise<any> }
    >();
    readonly connect = vi.fn(async (_transport: unknown) => {
      if (options.connectThrows) {
        throw new Error('stdio connect failed');
      }
    });
    readonly server: {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<any>>;
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
        setRequestHandler: vi.fn(
          (schema: unknown, handler: (req: unknown, extra: unknown) => Promise<any>) => {
            const method =
              (schema as { method?: string; type?: string }).method ?? (schema as { type?: string }).type;
            if (method) {
              this.server._requestHandlers.set(method, handler);
            }
            if (method === 'tools/list') {
              this.listToolsHandler = handler;
            }
          }
        ),
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

    registerResource(
      name: string,
      uriOrTemplate: unknown,
      config: unknown,
      handler: (...args: any[]) => Promise<any>
    ): void {
      this.resources.set(name, { uriOrTemplate, config, handler });
    }
  }

  const createAgentClient = (token: string) => ({
    token,
    send: vi.fn(async (channel: string, text: string) => ({ id: 'msg_1', channel, text })),
    messages: vi.fn(async () => []),
    reply: vi.fn(async (messageId: string, text: string) => ({ id: 'reply_1', messageId, text })),
    thread: vi.fn(async () => ({ parent: {}, replies: [] })),
    dm: vi.fn(async (to: string, text: string) => ({ id: 'dm_1', to, text })),
    dms: {
      conversations: vi.fn(async () => []),
      messages: vi.fn(async () => []),
      createGroup: vi.fn(async () => ({ id: 'group_1' })),
      sendMessage: vi.fn(async () => ({ id: 'group_msg_1' })),
    },
    channels: {
      create: vi.fn(async (data: unknown) => data),
      list: vi.fn(async () => []),
      join: vi.fn(async () => ({})),
      leave: vi.fn(async () => ({})),
      invite: vi.fn(async () => ({})),
      setTopic: vi.fn(async (channel: string, topic: string) => ({ channel, topic })),
      archive: vi.fn(async () => ({})),
    },
    react: vi.fn(async () => ({})),
    unreact: vi.fn(async () => ({})),
    search: vi.fn(async () => []),
    inbox: vi.fn(async () => behavior.inboxImpl(token)),
    markRead: vi.fn(async () => ({})),
    readers: vi.fn(async () => []),
  });

  const RelayCast = vi.fn(function (this: unknown, config: Record<string, unknown>) {
    const registerOrRotate = vi.fn(async (input: { name: string; type?: string }) =>
      behavior.registerImpl(input)
    );
    const agentsList = vi.fn(async () => []);
    const spawn = vi.fn(async (input: unknown) => ({ spawned: true, input }));
    const release = vi.fn(async (input: { name: string; reason?: string; deleteAgent?: boolean }) => ({
      name: input.name,
      released: true,
      deleted: Boolean(input.deleteAgent),
      reason: input.reason ?? null,
    }));
    const as = vi.fn((token: string) => createAgentClient(token));
    relayInstances.push({ config, registerOrRotate, agentsList, spawn, release, as });
    return {
      agents: {
        registerOrRotate,
        list: agentsList,
        spawn,
        release,
      },
      as,
    };
  }) as any;
  RelayCast.createWorkspace = vi.fn((name: string) => behavior.createWorkspaceImpl(name));

  vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: FakeMcpServer,
    ResourceTemplate: FakeResourceTemplate,
  }));
  vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: FakeTransport }));
  vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
    ListToolsRequestSchema: { method: 'tools/list' },
    SubscribeRequestSchema: { method: 'resources/subscribe' },
    UnsubscribeRequestSchema: { method: 'resources/unsubscribe' },
  }));
  vi.doMock('@relaycast/sdk', () => ({
    RelayCast,
    WsClient: FakeWsClient,
    SDK_VERSION: 'test-sdk-version',
  }));
  vi.doMock('./telemetry/index.js', () => ({
    initTelemetry: telemetryInit,
    shutdown: telemetryShutdown,
    track: telemetryTrack,
  }));

  const mod = await import('./agent-relay-mcp.js');
  if (options.forceEntrypoint) {
    process.argv = originalArgv;
  }

  return {
    mod,
    mocks: {
      behavior,
      serverInstances,
      relayInstances,
      wsClientInstances,
      telemetryTrack,
      telemetryInit,
      telemetryShutdown,
      RelayCast,
      FakeTransport,
    },
  };
}

beforeEach(() => {
  vi.stubEnv('AGENT_RELAY_HARNESS', '');
  vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_HARNESS', '');
  vi.stubEnv('RELAYCAST_HARNESS', '');
  vi.stubEnv('X_RELAYCAST_HARNESS', '');
  vi.stubEnv('AGENT_RELAY_DISTINCT_ID', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('agent-relay-mcp startup helpers', () => {
  it('parses startup options and helper flags from the environment', async () => {
    const { mod } = await loadAgentRelayMcpModule();
    vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_env');
    vi.stubEnv('RELAY_BASE_URL', 'https://api.relaycast.dev///');
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_env');
    vi.stubEnv('RELAY_AGENT_NAME', '');
    vi.stubEnv('RELAY_CLAW_NAME', 'FallbackClaw');
    vi.stubEnv('RELAY_AGENT_TYPE', 'human');
    vi.stubEnv('RELAY_STRICT_AGENT_NAME', ' yes ');
    vi.stubEnv('RELAY_SKIP_BOOTSTRAP', '1');

    expect(mod.normalizeBaseUrl('https://api.relaycast.dev///')).toBe('https://api.relaycast.dev');
    expect(mod.envFlagEnabled(' on ')).toBe(true);
    expect(mod.envFlagEnabled('0')).toBe(false);
    expect(mod.normalizeAgentType('agent')).toBe('agent');
    expect(mod.normalizeAgentType('robot')).toBeUndefined();
    expect(mod.optionsFromEnv()).toEqual({
      workspaceKey: 'rk_live_env',
      baseUrl: 'https://api.relaycast.dev///',
      agentToken: 'at_live_env',
      agentName: 'FallbackClaw',
      agentType: 'human',
      strictAgentName: true,
      skipBootstrap: true,
    });
  });
});

describe('createAgentRelayMcpServer', () => {
  it('registers owned tools, resources, prompt text, and strips execution metadata from tools/list', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();

    mod.createAgentRelayMcpServer({ baseUrl: 'https://api.relaycast.dev/' });
    const server = mocks.serverInstances[0];

    expect(server.tools.get('create_workspace')).toBeDefined();
    expect(server.tools.get('register_agent')).toBeDefined();
    expect(server.tools.get('list_agents')).toBeDefined();
    expect(server.tools.get('post_message')).toBeDefined();
    expect(server.tools.get('add_agent')).toBeDefined();
    expect([...server.tools.keys()].filter((name) => name.includes('.'))).toEqual([]);
    expect(server.resources.get('inbox')).toBeDefined();
    expect(server.resources.get('channel-messages')).toBeDefined();
    expect(server.prompts.get('system')).toBeDefined();

    await expect(server.resources.get('agents')?.handler(new URL('relay://agents'))).rejects.toThrow(
      'Workspace key not configured. Call "create_workspace" first, or provide a shared workspace key with "set_workspace_key".'
    );
    await expect(server.tools.get('register_agent')?.handler({ name: 'WorkerA' })).rejects.toThrow(
      'Workspace key not configured. Call "create_workspace" first, or "set_workspace_key" if someone shared a workspace key.'
    );

    const workspaceResult = await server.tools
      .get('create_workspace')
      ?.handler({ name: 'Coverage Workspace' });
    expect(mocks.RelayCast.createWorkspace).toHaveBeenCalledWith('Coverage Workspace', {
      baseUrl: 'https://api.relaycast.dev/',
    });
    expect(workspaceResult.structuredContent).toEqual({
      workspaceKey: 'rk_live_created',
      workspaceName: 'Test Workspace',
    });

    const registerResult = await server.tools.get('register_agent')?.handler({
      name: 'WorkerA',
      type: 'human',
      persona: 'Coverage tester',
      metadata: { model: 'gpt-5' },
    });
    const workspaceRelay = mocks.relayInstances.find(
      (instance) => instance.config.apiKey === 'rk_live_created'
    );
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

    const toolsList = await server.listToolsHandler?.({}, {});
    expect(toolsList?.tools).toEqual([
      {
        name: 'post_message',
        title: 'Post Message',
        description: 'Send a channel message',
      },
    ]);

    const promptResult = await server.prompts.get('system')?.handler();
    expect(promptResult.messages[0].content.text).toContain('create_workspace');
    expect(promptResult.messages[0].content.text).not.toContain('workspace.create');
  });

  it('registers submit_result when a spawned-agent result callback is configured', async () => {
    vi.stubEnv('AGENT_RELAY_RESULT_URL', 'http://127.0.0.1:3889/api/agent-result');
    vi.stubEnv('AGENT_RELAY_RESULT_TOKEN', 'arr_test');
    vi.stubEnv('AGENT_RELAY_RESULT_SCHEMA', '{"type":"object","properties":{"ok":{"type":"boolean"}}}');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer arr_test',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        agent: 'ResultWorker',
        data: { ok: true },
        final: true,
        metadata: { source: 'test' },
      });
      return new Response(JSON.stringify({ success: true, result_id: 'ar_test' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({ agentName: 'ResultWorker' });

    const server = mocks.serverInstances[0];
    const submitResult = server.tools.get('submit_result');
    expect(submitResult).toBeDefined();
    const response = await submitResult?.handler({
      data: { ok: true },
      metadata: { source: 'test' },
    });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3889/api/agent-result', expect.any(Object));
    expect(response.structuredContent).toEqual({ success: true, result_id: 'ar_test' });
  });

  it('passes Relaycast telemetry context to direct MCP Relaycast clients', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_HARNESS', 'claude/opus-48');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_test');

    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://api.relaycast.dev/',
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];
    expect(mocks.wsClientInstances[0]?.config).toMatchObject({
      token: 'at_live_existing',
      baseUrl: 'https://api.relaycast.dev/',
      harness: 'claude/opus-48',
      agentRelayDistinctId: 'distinct_test',
    });

    await server.tools.get('check_inbox')?.handler({});
    const agentRelay = mocks.relayInstances.find((instance) => instance.config.apiKey === 'at_live_existing');
    expect(agentRelay?.config).toMatchObject({
      apiKey: 'at_live_existing',
      baseUrl: 'https://api.relaycast.dev/',
      harness: 'claude/opus-48',
      agentRelayDistinctId: 'distinct_test',
    });

    await server.tools.get('add_agent')?.handler({
      name: 'WorkerB',
      cli: 'claude',
      task: 'help',
    });
    const workspaceRelay = mocks.relayInstances.find(
      (instance) => instance.config.apiKey === 'rk_live_existing'
    );
    expect(workspaceRelay?.config).toMatchObject({
      apiKey: 'rk_live_existing',
      baseUrl: 'https://api.relaycast.dev/',
      harness: 'claude/opus-48',
      agentRelayDistinctId: 'distinct_test',
    });

    await server.tools.get('create_workspace')?.handler({ name: 'Telemetry Workspace' });
    expect(mocks.RelayCast.createWorkspace).toHaveBeenCalledWith('Telemetry Workspace', {
      baseUrl: 'https://api.relaycast.dev/',
      agentRelayDistinctId: 'distinct_test',
    });

    await mod.resolveStdioBootstrapOptions({
      apiKey: 'rk_live_bootstrap',
      agentName: 'BootstrapWorker',
      agentToken: 'jwt_or_external_token',
      baseUrl: 'https://api.relaycast.dev/',
    });
    const bootstrapRelay = mocks.relayInstances.find(
      (instance) => instance.config.apiKey === 'rk_live_bootstrap'
    );
    expect(bootstrapRelay?.config).toMatchObject({
      apiKey: 'rk_live_bootstrap',
      baseUrl: 'https://api.relaycast.dev/',
      harness: 'claude/opus-48',
      agentRelayDistinctId: 'distinct_test',
    });
  });

  it('tracks MCP action calls with Relaycast action names and coarse categories', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      workspaceKey: 'rk_live_existing',
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];
    await server.tools.get('add_agent')?.handler({
      name: 'WorkerB',
      cli: 'claude',
      task: 'help',
    });
    expect(mocks.telemetryTrack).toHaveBeenCalledWith(
      'mcp_action_call',
      expect.objectContaining({
        tool_name: 'add_agent',
        action_type: 'agent.create',
        action_category: 'spawn',
        transport: 'stdio',
        success: true,
        duration_ms: expect.any(Number),
      })
    );

    await server.tools.get('remove_agent')?.handler({ name: 'WorkerB', reason: 'done' });
    expect(mocks.telemetryTrack).toHaveBeenCalledWith(
      'mcp_action_call',
      expect.objectContaining({
        tool_name: 'remove_agent',
        action_type: 'agent.release',
        action_category: 'release',
        transport: 'stdio',
        success: true,
        duration_ms: expect.any(Number),
      })
    );
  });

  it('uses registered action tool names as action types', async () => {
    const actions = {
      list: vi.fn(async () => [
        {
          name: 'agent.create',
          description: 'Create an agent',
          visibility: 'agent' as const,
        },
      ]),
      invoke: vi.fn(async () => ({ ok: true, action: 'agent.create', output: {} })),
    };
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      actions: actions as any,
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];
    await vi.waitFor(() => {
      expect(server.tools.get('agent.create')).toBeDefined();
    });

    await server.tools.get('agent.create')?.handler({ name: 'WorkerB', cli: 'claude' });

    expect(mocks.telemetryTrack).toHaveBeenCalledWith(
      'mcp_action_call',
      expect.objectContaining({
        tool_name: 'agent.create',
        action_type: 'agent.create',
        action_category: 'spawn',
        transport: 'stdio',
        success: true,
      })
    );
  });

  it('uses invoke_action names as action types without argument values', async () => {
    const actions = {
      list: vi.fn(async () => []),
      invoke: vi.fn(async () => ({ ok: true, action: 'github.open_pr', output: {} })),
    };
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      actions: actions as any,
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];
    await server.tools.get('invoke_action')?.handler({
      name: 'github.open_pr',
      input: { title: 'private PR title' },
    });

    expect(mocks.telemetryTrack).toHaveBeenCalledWith(
      'mcp_action_call',
      expect.objectContaining({
        tool_name: 'invoke_action',
        action_type: 'github.open_pr',
        action_category: 'action',
        transport: 'stdio',
        success: true,
      })
    );
    const telemetryPayload = mocks.telemetryTrack.mock.calls.find(
      ([eventName]) => eventName === 'mcp_action_call'
    )?.[1];
    expect(JSON.stringify(telemetryPayload)).not.toContain('private PR title');
  });

  it('tracks failed MCP action calls without argument values', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({ telemetryTransport: 'http' });

    const server = mocks.serverInstances[0];
    await expect(
      server.tools.get('add_agent')?.handler({
        name: 'WorkerB',
        cli: 'claude',
        task: 'private task text',
      })
    ).rejects.toThrow('Workspace key not configured');

    expect(mocks.telemetryTrack).toHaveBeenCalledWith('mcp_action_call', {
      tool_name: 'add_agent',
      action_type: 'agent.create',
      action_category: 'spawn',
      transport: 'http',
      success: false,
      duration_ms: expect.any(Number),
      error_class: 'Error',
    });
  });

  it('dispatches websocket resource callbacks only to subscribed resources', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://api.relaycast.dev',
    });

    const server = mocks.serverInstances[0];
    const ws = mocks.wsClientInstances[0];
    const subscribe = server.server._requestHandlers.get('resources/subscribe');
    await subscribe?.({ params: { uri: 'relay://inbox' } }, {});

    ws.emit({ type: 'message.created', channel: 'general' });
    expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'relay://inbox' });
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalledWith({
      uri: 'relay://channels/general/messages',
    });
  });

  it('reinitializes the websocket bridge when the workspace changes', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://api.relaycast.dev',
    });

    const server = mocks.serverInstances[0];
    const ws = mocks.wsClientInstances[0];
    const setWorkspaceKeyTool = server.tools.get('set_workspace_key');

    expect(ws.connect).toHaveBeenCalledTimes(1);
    await expect(setWorkspaceKeyTool?.handler({ api_key: 'bad_key' })).rejects.toThrow(
      'Workspace key must start with "rk_live_"'
    );

    const result = await setWorkspaceKeyTool?.handler({ workspace_key: 'rk_live_other' });
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({
      message: 'Workspace key set. Call "register_agent" to join this workspace.',
    });
  });

  it('preserves the current agent session when the workspace key does not change', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://api.relaycast.dev',
    });

    const server = mocks.serverInstances[0];
    const ws = mocks.wsClientInstances[0];
    const setWorkspaceKeyTool = server.tools.get('set_workspace_key');

    const result = await setWorkspaceKeyTool?.handler({ workspace_key: 'rk_live_existing' });

    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      message: 'Workspace key set.',
    });

    await server.tools.get('check_inbox')?.handler({});
    const agentRelay = mocks.relayInstances.find((instance) => instance.config.apiKey === 'at_live_existing');
    expect(agentRelay?.as).toHaveBeenCalledWith('at_live_existing', { autoHeartbeatMs: false });
  });

  it('marks websocket initialization attempted even when bridge setup fails', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule({ wsClientThrows: true });
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
    });

    expect(mocks.wsClientInstances).toHaveLength(0);
  });

  it('swallows websocket resource update emission failures', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
    });

    const server = mocks.serverInstances[0];
    const ws = mocks.wsClientInstances[0];
    const subscribe = server.server._requestHandlers.get('resources/subscribe');
    await subscribe?.({ params: { uri: 'relay://inbox' } }, {});
    server.server.sendResourceUpdated.mockRejectedValueOnce(new Error('emit failed'));

    ws.emit({ type: 'reaction.added' });
    await Promise.resolve();

    expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'relay://inbox' });
  });
});

describe('resolveStdioBootstrapOptions', () => {
  it('returns options unchanged when workspace bootstrap inputs are incomplete', async () => {
    const { mod } = await loadAgentRelayMcpModule();
    await expect(mod.resolveStdioBootstrapOptions({ agentName: 'WorkerA' })).resolves.toEqual({
      agentName: 'WorkerA',
    });
  });

  it('trusts an at_live_* agent token without probing or rotating', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    const options = {
      apiKey: 'rk_live_workspace',
      baseUrl: 'https://api.relaycast.dev',
      agentName: 'WorkerA',
      agentToken: 'at_live_existing',
      agentType: 'agent' as const,
    };

    const result = await mod.resolveStdioBootstrapOptions(options);

    expect(result).toEqual(options);
    expect(mocks.behavior.inboxImpl).not.toHaveBeenCalled();
    expect(mocks.behavior.registerImpl).not.toHaveBeenCalled();
  });

  it('respects explicit bootstrap skipping', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    const options = {
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentToken: 'jwt_or_external_token',
      skipBootstrap: true,
    };

    await expect(mod.resolveStdioBootstrapOptions(options)).resolves.toEqual(options);
    expect(mocks.behavior.registerImpl).not.toHaveBeenCalled();
  });

  it('mints a relaycast token when the caller provides a non-relaycast token (e.g. JWT)', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.behavior.registerImpl = vi.fn(async () => ({
      name: 'WorkerA',
      token: 'at_live_minted',
    }));

    const result = await mod.resolveStdioBootstrapOptions({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentToken: 'eyJhbGciOiJSUzI1NiJ9.payload.sig',
      agentType: 'human',
    });

    expect(mocks.behavior.registerImpl).toHaveBeenCalledWith({
      name: 'WorkerA',
      type: 'human',
    });
    expect(result).toEqual({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentToken: 'at_live_minted',
      agentType: 'human',
    });
  });

  it('mints a relaycast token when no agentToken is provided', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.behavior.registerImpl = vi.fn(async () => ({
      name: 'WorkerA',
      token: 'at_live_minted',
    }));

    const result = await mod.resolveStdioBootstrapOptions({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentType: 'agent',
    });

    expect(mocks.behavior.registerImpl).toHaveBeenCalledWith({
      name: 'WorkerA',
      type: 'agent',
    });
    expect(result.agentToken).toBe('at_live_minted');
  });
});

describe('startAgentRelayMcpStdio', () => {
  it('boots the MCP server on stdio transport after bootstrap', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();

    await mod.startAgentRelayMcpStdio({
      apiKey: 'rk_live_workspace',
      agentName: 'WorkerA',
      agentToken: 'at_live_existing',
    });

    const server = mocks.serverInstances[0];
    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(server.connect.mock.calls[0][0]).toBeInstanceOf(mocks.FakeTransport);
    expect(mocks.telemetryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        showNotice: false,
        app: 'cli',
        surface: 'mcp',
      })
    );
  });

  it('reports entrypoint startup failures to stderr and exits', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await loadAgentRelayMcpModule({ forceEntrypoint: true, connectThrows: true });

    await vi.waitFor(() => {
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('stdio connect failed'));
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
