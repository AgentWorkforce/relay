import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LoadOptions = {
  connectThrows?: boolean;
  forceEntrypoint?: boolean;
  persistedWorkspaceKey?: string;
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
  const telemetryTrack = vi.fn();
  const telemetryInit = vi.fn();
  const telemetryShutdown = vi.fn(async () => undefined);
  // Returns a result object describing what the write changed beyond the key.
  const persistWorkspaceSession = vi.fn(() => ({}));
  const resolveWorkspaceSessionKey = vi.fn(() => options.persistedWorkspaceKey);
  const validateWorkspaceSessionName = vi.fn((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Workspace name is required.');
    return trimmed;
  });
  const relayInstances: Array<{
    config: Record<string, unknown>;
    registerOrRotate: ReturnType<typeof vi.fn>;
    agentsList: ReturnType<typeof vi.fn>;
    nodesList: ReturnType<typeof vi.fn>;
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

  class FakeTransport {}

  class FakeMcpServer {
    readonly options: unknown;
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

    constructor(_info: unknown, capabilities: unknown) {
      this.options = capabilities;
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
    actions: {
      invoke: vi.fn(async (name: string, input: unknown) => ({
        invocationId: 'inv_1',
        actionName: name,
        input,
      })),
      getInvocation: vi.fn(async (name: string, invocationId: string) => ({
        invocationId,
        actionName: name,
        status: 'completed',
        output: { spawned: true, ready: true },
      })),
    },
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
    const nodesList = vi.fn(async () => [
      {
        name: 'node-a',
        status: 'online',
        capabilities: [{ name: 'spawn:codex' }],
      },
    ]);
    const spawn = vi.fn(async (input: unknown) => ({ spawned: true, input }));
    const release = vi.fn(async (input: { name: string; reason?: string; deleteAgent?: boolean }) => ({
      name: input.name,
      released: true,
      deleted: Boolean(input.deleteAgent),
      reason: input.reason ?? null,
    }));
    const as = vi.fn((token: string) => createAgentClient(token));
    relayInstances.push({ config, registerOrRotate, agentsList, nodesList, spawn, release, as });
    return {
      agents: {
        registerOrRotate,
        list: agentsList,
        spawn,
        release,
      },
      nodes: {
        list: nodesList,
      },
      as,
    };
  }) as any;
  RelayCast.createWorkspace = vi.fn((name: string) => behavior.createWorkspaceImpl(name));

  // The query_nodes tool constructs `new AgentRelay(...)` from @agent-relay/sdk
  // and calls `.nodes.list()`. AgentRelay wraps @relaycast/sdk internally, so
  // mocking only @relaycast/sdk leaves this path dependent on the two packages
  // resolving the SAME physical @relaycast/sdk copy. A fresh publish-time
  // `npm install` can nest a duplicate @relaycast/sdk under packages/sdk, at
  // which point AgentRelay's internal client is the real (unmocked) one and the
  // call escapes to a live HTTP request. Mock the direct boundary so the test is
  // independent of node_modules hoisting.
  const agentRelayNodesList = vi.fn(async (_query?: { capability?: string; name?: string }) => [
    {
      name: 'node-a',
      status: 'online',
      capabilities: [{ name: 'spawn:codex' }],
    },
  ]);
  const agentRelayMessagingCommands = {
    invoke: vi.fn(async (name: string, input: unknown) => ({
      invocationId: 'inv_1',
      actionName: name,
      input,
    })),
    getInvocation: vi.fn(async (name: string, invocationId: string) => ({
      invocationId,
      actionName: name,
      status: 'completed',
      output: { spawned: true, ready: true },
    })),
  };
  const AgentRelayMock = vi.fn(function (this: unknown) {
    return {
      nodes: { list: agentRelayNodesList },
      messaging: {
        commands: agentRelayMessagingCommands,
      },
    };
  }) as any;

  vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: FakeMcpServer,
    ResourceTemplate: class ResourceTemplate {
      constructor(
        public readonly uriTemplate: string,
        public readonly options: { list?: unknown }
      ) {}
    },
  }));
  vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: FakeTransport }));
  vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
    ListToolsRequestSchema: { method: 'tools/list' },
    SubscribeRequestSchema: { method: 'resources/subscribe' },
    UnsubscribeRequestSchema: { method: 'resources/unsubscribe' },
  }));
  vi.doMock('@relaycast/sdk', () => ({
    RelayCast,
    SDK_VERSION: 'test-sdk-version',
  }));
  vi.doMock('@agent-relay/sdk', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@agent-relay/sdk');
    return { ...actual, AgentRelay: AgentRelayMock };
  });
  vi.doMock('./telemetry/index.js', () => ({
    initTelemetry: telemetryInit,
    shutdown: telemetryShutdown,
    track: telemetryTrack,
  }));
  vi.doMock('./lib/workspace-session.js', async (importOriginal) => ({
    persistWorkspaceSession,
    // The real formatter, not a copy, so the warning these tools return cannot
    // drift away from what the CLI prints for the same event.
    describeClearedEnrollment: (await importOriginal<typeof import('./lib/workspace-session.js')>())
      .describeClearedEnrollment,
    resolveWorkspaceSessionKey,
    validateWorkspaceSessionName,
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
      telemetryTrack,
      telemetryInit,
      telemetryShutdown,
      persistWorkspaceSession,
      resolveWorkspaceSessionKey,
      validateWorkspaceSessionName,
      RelayCast,
      FakeTransport,
      agentRelayMessagingCommands,
    },
  };
}

beforeEach(() => {
  vi.stubEnv('AGENT_RELAY_HARNESS', '');
  vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_HARNESS', '');
  vi.stubEnv('RELAYCAST_HARNESS', '');
  vi.stubEnv('X_RELAYCAST_HARNESS', '');
  vi.stubEnv('AGENT_RELAY_DISTINCT_ID', '');
  vi.stubEnv('AGENT_RELAY_MACHINE_ID', '');
  vi.stubEnv('AGENT_RELAY_USER_ID', '');
  vi.stubEnv('AGENT_RELAY_ORG_ID', '');
  vi.stubEnv('AGENT_RELAY_ORG_SLUG', '');
  vi.stubEnv('AGENT_RELAY_USER_EMAIL', '');
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
    vi.stubEnv('RELAY_BASE_URL', 'https://relay.example.com///');
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_env');
    vi.stubEnv('RELAY_AGENT_NAME', '');
    vi.stubEnv('RELAY_CLAW_NAME', 'FallbackClaw');
    vi.stubEnv('RELAY_AGENT_TYPE', 'human');
    vi.stubEnv('RELAY_STRICT_AGENT_NAME', ' yes ');
    vi.stubEnv('RELAY_SKIP_BOOTSTRAP', '1');

    expect(mod.normalizeBaseUrl('https://relay.example.com///')).toBe('https://relay.example.com');
    expect(mod.normalizeBaseUrl(`https://relay.example.com${'/'.repeat(1000)}`)).toBe(
      'https://relay.example.com'
    );
    expect(mod.normalizeBaseUrl(undefined)).toBeUndefined();
    expect(mod.envFlagEnabled(' on ')).toBe(true);
    expect(mod.envFlagEnabled('0')).toBe(false);
    expect(mod.normalizeAgentType('agent')).toBe('agent');
    expect(mod.normalizeAgentType('robot')).toBeUndefined();
    expect(mod.optionsFromEnv()).toEqual({
      workspaceKey: 'rk_live_env',
      baseUrl: 'https://relay.example.com///',
      agentToken: 'at_live_env',
      agentName: 'FallbackClaw',
      agentType: 'human',
      strictAgentName: true,
      skipBootstrap: true,
    });
  });

  it('resumes the persisted project workspace when no workspace env is set', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule({
      persistedWorkspaceKey: 'rk_live_persisted',
    });
    vi.stubEnv('RELAY_WORKSPACE_KEY', '');
    vi.stubEnv('AGENT_RELAY_WORKSPACE_KEY', '');
    vi.stubEnv('RELAY_API_KEY', '');
    vi.stubEnv('RELAY_AGENT_TOKEN', '');
    vi.stubEnv('RELAY_AGENT_NAME', '');
    vi.stubEnv('RELAY_CLAW_NAME', '');

    expect(mod.optionsFromEnv()).toMatchObject({
      workspaceKey: 'rk_live_persisted',
      agentName: 'orchestrator',
    });
    expect(mocks.resolveWorkspaceSessionKey).toHaveBeenCalledTimes(1);
  });

  it('does not pair a persisted workspace with an unbound ambient agent token', async () => {
    const { mod } = await loadAgentRelayMcpModule({
      persistedWorkspaceKey: 'rk_live_persisted',
    });
    vi.stubEnv('RELAY_WORKSPACE_KEY', '');
    vi.stubEnv('AGENT_RELAY_WORKSPACE_KEY', '');
    vi.stubEnv('RELAY_API_KEY', '');
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_stale_workspace');
    vi.stubEnv('RELAY_AGENT_NAME', '');
    vi.stubEnv('RELAY_CLAW_NAME', '');

    expect(mod.optionsFromEnv()).toMatchObject({
      workspaceKey: 'rk_live_persisted',
      agentToken: undefined,
      agentName: 'orchestrator',
    });
  });

  it('keeps an agent token paired with an explicitly configured agent-relay workspace key', async () => {
    const { mod } = await loadAgentRelayMcpModule({
      persistedWorkspaceKey: 'rk_live_unrelated_persisted',
    });
    vi.stubEnv('RELAY_WORKSPACE_KEY', '');
    vi.stubEnv('AGENT_RELAY_WORKSPACE_KEY', 'rk_live_agent_env');
    vi.stubEnv('RELAY_API_KEY', '');
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_agent_env');

    expect(mod.optionsFromEnv()).toMatchObject({
      workspaceKey: 'rk_live_agent_env',
      agentToken: 'at_live_agent_env',
    });
  });

  it('trims workspace env values and falls through whitespace-only primary candidates', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule({
      persistedWorkspaceKey: 'rk_live_unrelated_persisted',
    });
    vi.stubEnv('RELAY_WORKSPACE_KEY', '   ');
    vi.stubEnv('AGENT_RELAY_WORKSPACE_KEY', ' rk_live_agent_env ');
    vi.stubEnv('RELAY_API_KEY', 'rk_live_legacy');
    vi.stubEnv('RELAY_AGENT_TOKEN', ' at_live_agent_env ');

    expect(mod.optionsFromEnv()).toMatchObject({
      workspaceKey: 'rk_live_agent_env',
      agentToken: 'at_live_agent_env',
    });
    expect(mocks.resolveWorkspaceSessionKey).not.toHaveBeenCalled();
  });
});

describe('createAgentRelayMcpServer', () => {
  it('registers owned tools, prompt text, fleet tools, and strips execution metadata from tools/list', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();

    mod.createAgentRelayMcpServer({ baseUrl: 'https://relay.example.com/' });
    const server = mocks.serverInstances[0];

    expect(server.tools.get('create_workspace')).toBeDefined();
    expect(server.tools.get('register_agent')).toBeDefined();
    expect(server.tools.get('list_agents')).toBeDefined();
    expect(server.tools.get('query_nodes')).toBeDefined();
    expect(server.tools.get('post_message')).toBeDefined();
    expect(server.tools.get('add_agent')).toBeDefined();
    expect(server.tools.get('spawn')).toBeDefined();
    expect([...server.tools.keys()].filter((name) => name.includes('.'))).toEqual([]);
    expect([...server.resources.keys()]).toEqual([
      'inbox',
      'agents',
      'channels',
      'channel-messages',
      'message-thread',
      'dm-conversation',
    ]);
    expect(server.server._requestHandlers.has('resources/subscribe')).toBe(true);
    expect(server.server._requestHandlers.has('resources/unsubscribe')).toBe(true);
    expect(server.prompts.get('system')).toBeDefined();
    expect(server.options).toMatchObject({
      instructions: expect.stringContaining(
        'Existing Relay participants are not local or built-in subagents'
      ),
    });

    await expect(server.tools.get('register_agent')?.handler({ name: 'WorkerA' })).rejects.toThrow(
      'Workspace key not configured. Call "create_workspace" first, or "set_workspace_key" if someone shared a workspace key.'
    );

    const workspaceResult = await server.tools
      .get('create_workspace')
      ?.handler({ name: 'Coverage Workspace' });
    expect(mocks.RelayCast.createWorkspace).toHaveBeenCalledWith('Coverage Workspace', {
      baseUrl: 'https://relay.example.com/',
    });
    expect(workspaceResult.structuredContent).toEqual({
      workspaceKey: 'rk_live_created',
      workspaceName: 'Test Workspace',
    });
    expect(mocks.persistWorkspaceSession).toHaveBeenCalledWith({
      name: 'Test Workspace',
      workspaceKey: 'rk_live_created',
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

    const queryNodesResult = await server.tools.get('query_nodes')?.handler({ capability: 'spawn:codex' });
    expect(queryNodesResult.structuredContent.nodes).toEqual([
      {
        name: 'node-a',
        status: 'online',
        capabilities: [{ name: 'spawn:codex' }],
      },
    ]);

    const spawnResult = await server.tools.get('spawn')?.handler({
      name: 'FleetWorker',
      cli: 'codex',
      task: 'Implement a fix',
      channel: 'general',
      target_node: 'node-a',
    });
    expect(spawnResult.structuredContent.invocation).toEqual({
      invocationId: 'inv_1',
      actionName: 'spawn',
      input: {
        name: 'FleetWorker',
        cli: 'codex',
        task: 'Implement a fix',
        target_node: 'node-a',
        channels: ['general'],
      },
    });

    const personaSpawnResult = await server.tools.get('spawn')?.handler({
      name: 'IntegrationExpert',
      persona: 'nango-integrations',
      task: 'Fix the sync',
      cwd: '/workspace/project',
      target_node: 'node-a',
    });
    expect(personaSpawnResult.structuredContent.invocation).toEqual({
      invocationId: 'inv_1',
      actionName: 'spawn',
      status: 'completed',
      output: { spawned: true, ready: true },
    });
    expect(mocks.agentRelayMessagingCommands.invoke).toHaveBeenCalledWith('spawn', {
      name: 'IntegrationExpert',
      persona: 'nango-integrations',
      capability: 'spawn:persona',
      task: 'Fix the sync',
      cwd: '/workspace/project',
      target_node: 'node-a',
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
    expect(promptResult.messages[0].content.text).toContain('query_nodes');
    expect(promptResult.messages[0].content.text).toContain('spawn');
    expect(promptResult.messages[0].content.text).not.toContain('workspace.create');
  });

  it('sends an unresolved DM from an agent-token-only session', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();

    mod.createAgentRelayMcpServer({
      agentToken: 'at_live_token_only',
      agentName: 'TokenWorker',
    });
    const server = mocks.serverInstances[0];
    const result = await server.tools.get('send_dm')?.handler({
      to: 'chief',
      text: 'token-scoped send',
    });

    expect(result.structuredContent).toMatchObject({
      id: 'dm_1',
      delivery: {
        status: 'recipient_unresolved',
        requestedRecipient: 'chief',
        resolvedRecipient: null,
        recipientMatched: null,
      },
    });
    expect(result.structuredContent).not.toHaveProperty('target');
    const agentRelay = mocks.relayInstances.find(
      (instance) => instance.config.apiKey === 'at_live_token_only'
    );
    expect(agentRelay?.as).toHaveBeenCalledWith('at_live_token_only', { autoHeartbeatMs: false });
  });

  it('returns a created workspace key when local session persistence fails', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.persistWorkspaceSession.mockImplementationOnce(() => {
      throw new Error('project directory is read-only');
    });

    mod.createAgentRelayMcpServer({ baseUrl: 'https://relay.example.com/' });
    const server = mocks.serverInstances[0];
    const result = await server.tools.get('create_workspace')?.handler({ name: 'Durable Workspace' });

    expect(result.structuredContent).toEqual({
      workspaceKey: 'rk_live_created',
      workspaceName: 'Test Workspace',
      warning:
        'Workspace created, but its session could not be persisted locally: project directory is read-only. ' +
        'Keep the returned workspace key and retry persistence before starting another session.',
    });
    expect(mocks.RelayCast.createWorkspace).toHaveBeenCalledTimes(1);

    await server.tools.get('register_agent')?.handler({ name: 'WorkerAfterWarning' });
    expect(mocks.relayInstances.some((instance) => instance.config.apiKey === 'rk_live_created')).toBe(true);
  });

  it('follows a persona provider result to the nested verified spawn invocation', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.agentRelayMessagingCommands.invoke.mockResolvedValueOnce({
      invocationId: 'inv_outer',
      actionName: 'spawn',
      status: 'dispatched',
    });
    mocks.agentRelayMessagingCommands.getInvocation.mockImplementation(
      async (_name: string, invocationId: string) => {
        if (invocationId === 'inv_outer') {
          return {
            invocationId,
            actionName: 'spawn',
            status: 'completed',
            output: {
              invocationId: 'inv_nested',
              actionName: 'spawn',
              status: 'dispatched',
            },
          };
        }
        if (invocationId === 'inv_nested') {
          return {
            invocationId,
            actionName: 'spawn',
            status: 'completed',
            output: { spawned: true, ready: true, name: 'PersonaWorker' },
          };
        }
        throw new Error(`unexpected invocation ${invocationId}`);
      }
    );

    mod.createAgentRelayMcpServer({
      workspaceKey: 'rk_live_existing',
      agentToken: 'at_live_fleet',
      agentName: 'orchestrator',
    });
    const server = mocks.serverInstances[0];
    const result = await server.tools.get('spawn')?.handler({
      name: 'PersonaWorker',
      persona: 'reviewer',
      target_node: 'node-a',
    });

    expect(mocks.agentRelayMessagingCommands.invoke).toHaveBeenCalledWith('spawn', {
      name: 'PersonaWorker',
      persona: 'reviewer',
      capability: 'spawn:persona',
      target_node: 'node-a',
    });
    expect(result.structuredContent.invocation).toEqual({
      invocationId: 'inv_nested',
      actionName: 'spawn',
      status: 'completed',
      output: { spawned: true, ready: true, name: 'PersonaWorker' },
    });
    expect(mocks.agentRelayMessagingCommands.getInvocation).toHaveBeenNthCalledWith(1, 'spawn', 'inv_outer');
    expect(mocks.agentRelayMessagingCommands.getInvocation).toHaveBeenNthCalledWith(2, 'spawn', 'inv_nested');
  });

  it('times out when a persona spawn invocation lookup never settles', async () => {
    vi.useFakeTimers();
    try {
      const { mod, mocks } = await loadAgentRelayMcpModule();
      mocks.agentRelayMessagingCommands.getInvocation.mockImplementation(
        async () => new Promise<never>(() => undefined)
      );

      mod.createAgentRelayMcpServer({
        agentToken: 'at_live_fleet',
        agentName: 'orchestrator',
      });
      const server = mocks.serverInstances[0];
      const spawn = server.tools.get('spawn')?.handler({
        name: 'PersonaWorker',
        persona: 'reviewer',
      });
      const outcome = Promise.race([
        spawn?.then(
          () => 'resolved unexpectedly',
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still pending after the persona spawn deadline'), 130_001)
        ),
      ]);

      await vi.advanceTimersByTimeAsync(130_001);

      await expect(outcome).resolves.toBe(
        'Persona spawn timed out before broker registration and harness readiness.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a nested verified spawn failure from the workforce persona result', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.agentRelayMessagingCommands.invoke.mockResolvedValueOnce({
      invocationId: 'inv_outer',
      actionName: 'spawn',
      status: 'dispatched',
    });
    mocks.agentRelayMessagingCommands.getInvocation.mockImplementation(
      async (_name: string, invocationId: string) => {
        if (invocationId === 'inv_outer') {
          return {
            invocationId,
            actionName: 'spawn',
            status: 'completed',
            output: {
              spawned: true,
              name: 'PersonaWorker',
              persona: 'reviewer',
              harness: 'codex',
              model: 'gpt-5',
              source: '/personas/reviewer.json',
              result: {
                invocationId: 'inv_nested',
                actionName: 'spawn',
                status: 'dispatched',
              },
            },
          };
        }
        if (invocationId === 'inv_nested') {
          return {
            invocationId,
            actionName: 'spawn',
            status: 'failed',
            error: 'spawn_readiness_timeout',
          };
        }
        throw new Error(`unexpected invocation ${invocationId}`);
      }
    );

    mod.createAgentRelayMcpServer({
      workspaceKey: 'rk_live_existing',
      agentToken: 'at_live_fleet',
      agentName: 'orchestrator',
    });
    const server = mocks.serverInstances[0];

    await expect(
      server.tools.get('spawn')?.handler({
        name: 'PersonaWorker',
        persona: 'reviewer',
        target_node: 'node-a',
      })
    ).rejects.toThrow('spawn_readiness_timeout');
    expect(mocks.agentRelayMessagingCommands.invoke).toHaveBeenCalledWith('spawn', {
      name: 'PersonaWorker',
      persona: 'reviewer',
      capability: 'spawn:persona',
      target_node: 'node-a',
    });
    expect(mocks.agentRelayMessagingCommands.getInvocation).toHaveBeenNthCalledWith(2, 'spawn', 'inv_nested');
  });

  it('rejects a blank workspace name before provisioning a remote workspace', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({ baseUrl: 'https://relay.example.com/' });
    const server = mocks.serverInstances[0];

    await expect(server.tools.get('create_workspace')?.handler({ name: '   ' })).rejects.toThrow(
      'Workspace name is required.'
    );
    expect(mocks.RelayCast.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.persistWorkspaceSession).not.toHaveBeenCalled();
  });

  it('keeps a selected workspace usable when local session persistence fails', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.persistWorkspaceSession.mockImplementationOnce(() => {
      throw new Error('project directory is read-only');
    });

    mod.createAgentRelayMcpServer({ baseUrl: 'https://relay.example.com/' });
    const server = mocks.serverInstances[0];
    const result = await server.tools
      .get('set_workspace_key')
      ?.handler({ workspace_key: 'rk_live_selected' });

    expect(result.structuredContent).toEqual({
      message:
        'Workspace key set. Call "register_agent" to join this workspace. ' +
        'The workspace is active for this process, but its session could not be persisted locally: ' +
        'project directory is read-only. Retry persistence before restarting this MCP server.',
    });

    await server.tools.get('register_agent')?.handler({ name: 'WorkerAfterSetWarning' });
    expect(mocks.relayInstances.some((instance) => instance.config.apiKey === 'rk_live_selected')).toBe(true);
  });

  it('reports an enrolled fleet node dropped by joining another workspace', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mocks.persistWorkspaceSession.mockReturnValueOnce({ clearedEnrolledNodeId: 'node_abc' });

    mod.createAgentRelayMcpServer({ baseUrl: 'https://relay.example.com/' });
    const server = mocks.serverInstances[0];
    const result = await server.tools
      .get('set_workspace_key')
      ?.handler({ workspace_key: 'rk_live_selected' });

    // Silence here is what left the fleet node shadowed until some later
    // `node up` mentioned it.
    expect(result.structuredContent.message).toContain('node_abc');
    expect(result.structuredContent.message).toContain('relay cloud enroll');
    // A cleared enrollment means the write SUCCEEDED. Reporting it through the
    // persistence-failure wording would tell the caller the key never landed.
    expect(result.structuredContent.message).toContain('persisted for this project');
    expect(result.structuredContent.message).not.toContain('could not be persisted');
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

  it('passes telemetry context through Agent Relay MCP clients', async () => {
    vi.stubEnv('AGENT_RELAY_ORIGIN_ACTOR', 'agent-relay-cli/agent/claude-code');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_test');

    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://relay.example.com/',
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];

    await server.tools.get('check_inbox')?.handler({});
    const agentRelay = mocks.relayInstances.find((instance) => instance.config.apiKey === 'at_live_existing');
    expect(agentRelay?.config).toMatchObject({
      apiKey: 'at_live_existing',
      baseUrl: 'https://relay.example.com/',
      originActor: 'agent-relay-cli/agent/claude-code',
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
      baseUrl: 'https://relay.example.com/',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });

    await server.tools.get('create_workspace')?.handler({ name: 'Telemetry Workspace' });
    expect(mocks.RelayCast.createWorkspace).toHaveBeenCalledWith('Telemetry Workspace', {
      baseUrl: 'https://relay.example.com/',
      agentRelayDistinctId: 'distinct_test',
    });

    await mod.resolveStdioBootstrapOptions({
      apiKey: 'rk_live_bootstrap',
      agentName: 'BootstrapWorker',
      agentToken: 'jwt_or_external_token',
      baseUrl: 'https://relay.example.com/',
    });
    const bootstrapRelay = mocks.relayInstances.find(
      (instance) => instance.config.apiKey === 'rk_live_bootstrap'
    );
    expect(bootstrapRelay?.config).toMatchObject({
      apiKey: 'rk_live_bootstrap',
      baseUrl: 'https://relay.example.com/',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });
  });

  it('tracks Agent Relay tool calls with action names and coarse categories', async () => {
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
      'agent_relay_tool_call',
      expect.objectContaining({
        tool_name: 'add_agent',
        tool_type: 'agent.create',
        tool_category: 'spawn',
        transport: 'stdio',
        success: true,
        duration_ms: expect.any(Number),
      })
    );

    await server.tools.get('remove_agent')?.handler({ name: 'WorkerB', reason: 'done' });
    expect(mocks.telemetryTrack).toHaveBeenCalledWith(
      'agent_relay_tool_call',
      expect.objectContaining({
        tool_name: 'remove_agent',
        tool_type: 'agent.release',
        tool_category: 'release',
        transport: 'stdio',
        success: true,
        duration_ms: expect.any(Number),
      })
    );
  });

  it('adds post-task exit instructions for task-exit add_agent spawns', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      workspaceKey: 'rk_live_existing',
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];
    await server.tools.get('add_agent')?.handler({
      name: 'WorkerB',
      cli: 'codex',
      task: 'Ship it',
      spawn_mode: 'task_exit',
    });

    const workspaceRelay = mocks.relayInstances.find(
      (instance) => instance.config.apiKey === 'rk_live_existing'
    );
    expect(workspaceRelay?.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'WorkerB',
        cli: 'codex',
        task: expect.stringContaining('output `/exit` on its own line'),
      })
    );
  });

  it('uses registered action tool names for dynamic action tools', async () => {
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

    expect(actions.invoke).toHaveBeenCalledWith({
      name: 'agent.create',
      input: { name: 'WorkerB', cli: 'claude' },
      context: {
        caller: { type: 'agent', name: 'mcp' },
        emit: undefined,
      },
    });
  });

  it('invokes registered actions without routing through per-tool telemetry', async () => {
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

    expect(actions.invoke).toHaveBeenCalledWith({
      name: 'github.open_pr',
      input: { title: 'private PR title' },
      context: {
        caller: { type: 'agent', name: 'mcp' },
        emit: undefined,
      },
    });
    expect(mocks.telemetryTrack).not.toHaveBeenCalledWith('agent_relay_tool_call', expect.anything());
  });

  it('does not emit per-tool telemetry for the action-routed spawn tool', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      agentToken: 'at_live_fleet',
      telemetryTransport: 'stdio',
    });

    const server = mocks.serverInstances[0];
    const spawnResult = await server.tools.get('spawn')?.handler({
      name: 'FleetWorker',
      cli: 'codex',
      task: 'Implement a fix',
    });

    // The tool still runs (delegates to the actions surface)...
    expect(spawnResult.structuredContent.invocation).toMatchObject({ actionName: 'spawn' });
    // ...but, like invoke_action, it must not double-count as a per-tool call.
    expect(mocks.telemetryTrack).not.toHaveBeenCalledWith('agent_relay_tool_call', expect.anything());
  });

  it('still emits inbox piggyback and resource updates for legacy consumers', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({ telemetryTransport: 'http' });

    const server = mocks.serverInstances[0];
    expect(server.server._requestHandlers.has('resources/subscribe')).toBe(true);
    expect(server.server._requestHandlers.has('resources/unsubscribe')).toBe(true);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();

    await expect(
      server.tools.get('add_agent')?.handler({
        name: 'WorkerB',
        cli: 'claude',
        task: 'private task text',
      })
    ).rejects.toThrow('Workspace key not configured');
  });

  it('registers websocket resource subscriptions for legacy consumers', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://relay.example.com',
    });

    const server = mocks.serverInstances[0];
    expect(server.server._requestHandlers.has('resources/subscribe')).toBe(true);
    expect(server.server._requestHandlers.has('resources/unsubscribe')).toBe(true);
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
  });

  it('preserves the current agent session when the workspace key does not change', async () => {
    const { mod, mocks } = await loadAgentRelayMcpModule();
    mod.createAgentRelayMcpServer({
      apiKey: 'rk_live_existing',
      agentToken: 'at_live_existing',
      agentName: 'PinnedWorker',
      baseUrl: 'https://relay.example.com',
    });

    const server = mocks.serverInstances[0];
    const setWorkspaceKeyTool = server.tools.get('set_workspace_key');

    const result = await setWorkspaceKeyTool?.handler({ workspace_key: 'rk_live_existing' });

    expect(result.structuredContent).toEqual({
      message: 'Workspace key set and persisted for this project.',
    });
    expect(mocks.persistWorkspaceSession).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_existing',
    });

    await server.tools.get('check_inbox')?.handler({});
    const agentRelay = mocks.relayInstances.find((instance) => instance.config.apiKey === 'at_live_existing');
    expect(agentRelay?.as).toHaveBeenCalledWith('at_live_existing', { autoHeartbeatMs: false });
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
      baseUrl: 'https://relay.example.com',
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
