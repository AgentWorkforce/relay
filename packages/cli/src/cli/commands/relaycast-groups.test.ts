import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerAgentCommands } from './agent.js';
import { registerChannelCommands } from './channel.js';
import { registerMessageCommands } from './message.js';
import { registerIntegrationCommands, type IntegrationCommandDependencies } from './integration.js';
import { registerCapabilitiesCommands } from './capabilities.js';
import type { SdkCommandDeps } from '../lib/sdk-command.js';

function createRelayMock() {
  return {
    agents: {
      register: vi.fn(async (i: { name: string }) => ({
        id: 'a1',
        token: 't1',
        name: i.name,
        status: 'online',
      })),
      list: vi.fn(async () => [{ id: 'a1', name: 'lead' }]),
      delete: vi.fn(async () => undefined),
    },
    channels: {
      create: vi.fn(async (i: { name: string }) => ({ id: 'c1', name: i.name })),
      list: vi.fn(async () => []),
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      invite: vi.fn(async () => undefined),
      update: vi.fn(async (name: string, i: { topic?: string }) => ({ id: 'c1', name, topic: i.topic })),
      archive: vi.fn(async () => undefined),
    },
    messages: {
      send: vi.fn(async (i: unknown) => ({ id: 'm1', ...(i as object) })),
      direct: vi.fn(async (i: unknown) => ({ id: 'd1', ...(i as object) })),
      react: vi.fn(async () => ({ emoji: 'eyes', count: 1, agents: [] })),
    },
    integrations: {
      webhooks: {
        create: vi.fn(async (i: unknown) => ({ id: 'wh1', ...(i as object) })),
        list: vi.fn(async () => []),
        delete: vi.fn(async () => undefined),
        trigger: vi.fn(async (_id: string, payload: unknown) => ({ triggered: true, payload })),
      },
      subscriptions: {
        create: vi.fn(async (i: unknown) => ({ id: 'sub1', ...(i as object) })),
        list: vi.fn(async () => []),
        get: vi.fn(async (id: string) => ({ id })),
        delete: vi.fn(async () => undefined),
      },
    },
    webhooks: {
      createInbound: vi.fn(async (i: { channel: string; name?: string }) => ({
        webhookId: 'in1',
        url: 'https://relay.example/webhooks/in1',
        token: 'tok_once',
        ...i,
      })),
      list: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      subscriptions: vi.fn(async () => []),
      unsubscribe: vi.fn(async () => undefined),
    },
    capabilities: {
      register: vi.fn(async (i: unknown) => ({ ...(i as object) })),
      list: vi.fn(async () => []),
    },
  };
}

function harness(register: (p: Command, o: Partial<SdkCommandDeps>) => void) {
  const relay = createRelayMock();
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const deps: Partial<SdkCommandDeps> = {
    createAgentRelay: () => relay as never,
    createWorkspaceRelay: () => relay as never,
    log,
    error,
    exit: exit as never,
  };
  const program = new Command();
  program.exitOverride();
  register(program, deps);
  return { program, relay, log, error };
}

describe('SDK-backed CLI groups', () => {
  it('agent register calls agents.register and prints the registration', async () => {
    const { program, relay, log } = harness(registerAgentCommands);
    await program.parseAsync(['agent', 'register', 'reviewer', '--type', 'agent'], { from: 'user' });
    expect(relay.agents.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reviewer', type: 'agent' })
    );
    expect(log).toHaveBeenCalled();
  });

  it('channel set_topic calls channels.update', async () => {
    const { program, relay } = harness(registerChannelCommands);
    await program.parseAsync(['channel', 'set_topic', 'ops', 'New topic'], { from: 'user' });
    expect(relay.channels.update).toHaveBeenCalledWith('ops', { topic: 'New topic' });
  });

  it('message post routes to messages.send with the channel', async () => {
    const { program, relay } = harness(registerMessageCommands);
    await program.parseAsync(['message', 'post', 'ops', 'hello'], { from: 'user' });
    expect(relay.messages.send).toHaveBeenCalledWith({ channel: 'ops', text: 'hello' });
  });

  it('message dm send routes to messages.direct', async () => {
    const { program, relay } = harness(registerMessageCommands);
    await program.parseAsync(['message', 'dm', 'send', 'lead', 'hi'], { from: 'user' });
    expect(relay.messages.direct).toHaveBeenCalledWith({ to: 'lead', text: 'hi' });
  });

  it('integration webhook create routes to integrations.webhooks.create', async () => {
    const { program, relay } = harness(registerIntegrationCommands);
    await program.parseAsync(
      ['integration', 'webhook', 'create', 'https://x', '--event', 'message.created'],
      { from: 'user' }
    );
    expect(relay.integrations.webhooks.create).toHaveBeenCalledWith({
      url: 'https://x',
      event: 'message.created',
    });
  });

  it('integration webhook create retries with local broker auth after unauthorized SDK auth', async () => {
    const firstRelay = createRelayMock();
    const secondRelay = createRelayMock();
    firstRelay.integrations.webhooks.create.mockRejectedValueOnce(new Error('Unauthorized'));
    const createAgentRelay = vi.fn().mockReturnValueOnce(firstRelay).mockReturnValueOnce(secondRelay);
    const resolveLocalRelayOptions = vi.fn(async () => ({
      workspaceKey: 'rk_live_local',
      baseUrl: 'https://relay.local',
    }));
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: createAgentRelay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(
      ['integration', 'webhook', 'create', 'https://x', '--event', 'message.created'],
      { from: 'user' }
    );

    expect(resolveLocalRelayOptions).toHaveBeenCalled();
    expect(createAgentRelay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceKey: 'rk_live_local', baseUrl: 'https://relay.local' })
    );
    expect(secondRelay.integrations.webhooks.create).toHaveBeenCalledWith({
      url: 'https://x',
      event: 'message.created',
    });
    expect(log).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('integration webhook create-inbound routes to webhooks.createInbound', async () => {
    const { program, relay, log } = harness(registerIntegrationCommands);
    await program.parseAsync(
      ['integration', 'webhook', 'create-inbound', 'incidents', '--name', 'Slack incidents'],
      { from: 'user' }
    );
    expect(relay.webhooks.createInbound).toHaveBeenCalledWith({
      channel: 'incidents',
      name: 'Slack incidents',
    });
    expect(log).toHaveBeenCalled();
  });

  it('integration webhook create-inbound retries with the local broker workspace key after invalid SDK auth', async () => {
    const firstRelay = createRelayMock();
    const secondRelay = createRelayMock();
    firstRelay.webhooks.createInbound.mockRejectedValueOnce(new Error('Invalid workspace key'));
    const createAgentRelay = vi.fn().mockReturnValueOnce(firstRelay).mockReturnValueOnce(secondRelay);
    const resolveLocalRelayOptions = vi.fn(async () => ({
      workspaceKey: 'rk_live_local',
      baseUrl: 'https://relay.local',
    }));
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: createAgentRelay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(['integration', 'webhook', 'create-inbound', 'general'], { from: 'user' });

    expect(resolveLocalRelayOptions).toHaveBeenCalled();
    expect(createAgentRelay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceKey: 'rk_live_local', baseUrl: 'https://relay.local' })
    );
    expect(secondRelay.webhooks.createInbound).toHaveBeenCalledWith({
      channel: 'general',
      name: undefined,
    });
    expect(log).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('integration webhook create-inbound does not retry an explicit workspace key', async () => {
    const relay = createRelayMock();
    relay.webhooks.createInbound.mockRejectedValueOnce(new Error('Invalid API key'));
    const resolveLocalRelayOptions = vi.fn(async () => ({ workspaceKey: 'rk_live_local' }));
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(
      ['integration', 'webhook', 'create-inbound', 'general', '--workspace-key', 'rk_live_explicit'],
      { from: 'user' }
    );

    expect(resolveLocalRelayOptions).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Invalid API key');
    expect(log).not.toHaveBeenCalled();
  });

  it('integration webhook list-inbound routes to webhooks.list', async () => {
    const { program, relay, log } = harness(registerIntegrationCommands);
    await program.parseAsync(['integration', 'webhook', 'list-inbound'], { from: 'user' });
    expect(relay.webhooks.list).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('integration webhook delete-inbound routes to webhooks.delete', async () => {
    const { program, relay } = harness(registerIntegrationCommands);
    await program.parseAsync(['integration', 'webhook', 'delete-inbound', 'in1'], { from: 'user' });
    expect(relay.webhooks.delete).toHaveBeenCalledWith('in1');
  });

  it('integration subscription create passes filter url and secret to subscriptions.create', async () => {
    const { program, relay } = harness(registerIntegrationCommands);
    await program.parseAsync(
      [
        'integration',
        'subscription',
        'create',
        'message.created',
        '--filter',
        'channel=#ops',
        '--url',
        'https://bridge.test/writeback',
        '--secret',
        's3cr3t',
      ],
      { from: 'user' }
    );
    expect(relay.integrations.subscriptions.create).toHaveBeenCalledWith({
      event: 'message.created',
      filter: { channel: '#ops' },
      url: 'https://bridge.test/writeback',
      secret: 's3cr3t',
    });
  });

  it('integration subscription create keeps optional subscription fields absent by default', async () => {
    const { program, relay } = harness(registerIntegrationCommands);
    await program.parseAsync(['integration', 'subscription', 'create', 'message.created'], { from: 'user' });
    expect(relay.integrations.subscriptions.create).toHaveBeenCalledWith({ event: 'message.created' });
  });

  it('integration subscribe exits with remediation when provider is not connected and no-input is set', async () => {
    const relay = createRelayMock();
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions: vi.fn(async () => ({ workspaceKey: 'rk_live_local' })),
      isInteractive: () => false,
      relayfile: {
        isConnected: vi.fn(async () => false),
        connect: vi.fn(async () => undefined),
        bind: vi.fn(async () => undefined),
        listBindings: vi.fn(async () => []),
        unbind: vi.fn(async () => undefined),
        resolveWritebackTarget: vi.fn(async () => ({
          baseUrl: 'https://file.test',
          workspaceId: 'rw_test',
        })),
      },
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(
      ['integration', 'subscribe', 'slack', '--resource', '#acme', '--to', '@slackbot', '--no-input'],
      { from: 'user' }
    );

    expect(error).toHaveBeenCalledWith(
      "slack isn't connected to this workspace yet.\nRun: relayfile integration connect slack --workspace <ws>, then re-run."
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
  });

  it('integration subscribe creates inbound webhook, subscription, and relayfile binding', async () => {
    const relay = createRelayMock();
    relay.agents.list.mockResolvedValueOnce([{ id: 'a1', name: 'slackbot' }]);
    const relayfile = {
      isConnected: vi.fn(async () => true),
      connect: vi.fn(async () => undefined),
      bind: vi.fn(async () => undefined),
      listBindings: vi.fn(async () => []),
      unbind: vi.fn(async () => undefined),
      resolveWritebackTarget: vi.fn(async () => ({
        baseUrl: 'https://file.test',
        workspaceId: 'rw_test',
      })),
    };
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions: vi.fn(async () => ({
        workspaceKey: 'rk_live_local',
        baseUrl: 'https://relay.local',
      })),
      isInteractive: () => false,
      relayfile,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(
      [
        'integration',
        'subscribe',
        'slack',
        '--resource',
        '#acme',
        '--to',
        '@slackbot',
        '--bridge-url',
        'https://bridge.test/writeback',
        '--bridge-secret',
        'secret',
      ],
      { from: 'user' }
    );

    expect(relay.webhooks.createInbound).toHaveBeenCalledWith({
      channel: 'slackbot',
      name: 'relayfile:slack',
    });
    expect(relay.integrations.subscriptions.create).toHaveBeenCalledWith({
      event: 'message.created',
      events: ['message.created', 'thread.reply'],
      filter: { channel: 'slackbot' },
      url: 'https://bridge.test/writeback',
      secret: 'secret',
    });
    expect(relayfile.bind).toHaveBeenCalledWith({
      provider: 'slack',
      resource: '#acme',
      channel: 'slackbot',
      webhookId: 'in1',
      webhookToken: 'tok_once',
      subscriptionId: 'sub1',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('integration subscribe defaults the bridge URL to the workspace-scoped relayfile ingress', async () => {
    const relay = createRelayMock();
    relay.agents.list.mockResolvedValueOnce([{ id: 'a1', name: 'slackbot' }]);
    const relayfile = {
      isConnected: vi.fn(async () => true),
      connect: vi.fn(async () => undefined),
      bind: vi.fn(async () => undefined),
      listBindings: vi.fn(async () => []),
      unbind: vi.fn(async () => undefined),
      resolveWritebackTarget: vi.fn(async () => ({
        baseUrl: 'https://file.agentrelay.com',
        workspaceId: 'rw_7ccfea89',
      })),
    };
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
      resolveLocalRelayOptions: vi.fn(async () => undefined),
      isInteractive: () => false,
      relayfile,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(
      ['integration', 'subscribe', 'slack', '--resource', '#acme', '--to', '@slackbot', '--bridge-secret', 'shared'],
      { from: 'user' }
    );

    expect(relayfile.resolveWritebackTarget).toHaveBeenCalled();
    expect(relay.integrations.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://file.agentrelay.com/v1/workspaces/rw_7ccfea89/integrations/relay/writeback',
        secret: 'shared',
      })
    );
  });

  it('integration subscribe --list prints relayfile bindings', async () => {
    const relay = createRelayMock();
    const relayfile = {
      isConnected: vi.fn(async () => true),
      connect: vi.fn(async () => undefined),
      bind: vi.fn(async () => undefined),
      listBindings: vi.fn(async () => [
        {
          provider: 'slack',
          resource: '#acme',
          channel: 'slackbot',
          webhookId: 'in1',
          subscriptionId: 'sub1',
        },
      ]),
      unbind: vi.fn(async () => undefined),
      resolveWritebackTarget: vi.fn(async () => ({
        baseUrl: 'https://file.test',
        workspaceId: 'rw_test',
      })),
    };
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions: vi.fn(async () => ({ workspaceKey: 'rk_live_local' })),
      relayfile,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(['integration', 'subscribe', '--list'], { from: 'user' });

    expect(relayfile.listBindings).toHaveBeenCalled();
    expect(relay.webhooks.list).toHaveBeenCalled();
    expect(relay.webhooks.subscriptions).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          bindings: [
            {
              provider: 'slack',
              resource: '#acme',
              channel: 'slackbot',
              webhookId: 'in1',
              subscriptionId: 'sub1',
            },
          ],
          webhooks: [],
          subscriptions: [],
        },
        null,
        2
      )
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('integration subscribe requires explicit spawn when a target agent is absent', async () => {
    const relay = createRelayMock();
    relay.agents.list.mockResolvedValueOnce([]);
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions: vi.fn(async () => ({ workspaceKey: 'rk_live_local' })),
      isInteractive: () => false,
      relayfile: {
        isConnected: vi.fn(async () => true),
        connect: vi.fn(async () => undefined),
        bind: vi.fn(async () => undefined),
        listBindings: vi.fn(async () => []),
        unbind: vi.fn(async () => undefined),
        resolveWritebackTarget: vi.fn(async () => ({
          baseUrl: 'https://file.test',
          workspaceId: 'rw_test',
        })),
      },
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(['integration', 'subscribe', 'slack', '--resource', '#acme', '--to', '@ghost'], {
      from: 'user',
    });

    expect(error).toHaveBeenCalledWith(
      'Recipient agent @ghost does not exist. Run: agent-relay integration subscribe slack --to @ghost --spawn <cli>'
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
  });

  it('integration unsubscribe removes webhook, subscription, and relayfile binding', async () => {
    const relay = createRelayMock();
    const relayfile = {
      isConnected: vi.fn(async () => true),
      connect: vi.fn(async () => undefined),
      bind: vi.fn(async () => undefined),
      listBindings: vi.fn(async () => [
        {
          provider: 'slack',
          resource: '#acme',
          channel: 'slackbot',
          webhookId: 'in1',
          subscriptionId: 'sub1',
        },
      ]),
      unbind: vi.fn(async () => undefined),
      resolveWritebackTarget: vi.fn(async () => ({
        baseUrl: 'https://file.test',
        workspaceId: 'rw_test',
      })),
    };
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerIntegrationCommands(program, {
      createAgentRelay: () => relay as never,
      log,
      error,
      exit: exit as never,
      resolveLocalRelayOptions: vi.fn(async () => ({ workspaceKey: 'rk_live_local' })),
      relayfile,
    } satisfies Partial<IntegrationCommandDependencies>);

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', '#acme'], {
      from: 'user',
    });

    expect(relay.webhooks.delete).toHaveBeenCalledWith('in1');
    expect(relay.webhooks.unsubscribe).toHaveBeenCalledWith('sub1');
    expect(relayfile.unbind).toHaveBeenCalledWith('slack', '#acme');
    expect(error).not.toHaveBeenCalled();
  });

  it('capabilities register routes to capabilities.register', async () => {
    const { program, relay } = harness(registerCapabilitiesCommands);
    await program.parseAsync(
      ['capabilities', 'register', 'deploy', '--description', 'Ship it', '--handler', 'ops'],
      { from: 'user' }
    );
    expect(relay.capabilities.register).toHaveBeenCalledWith({
      command: 'deploy',
      description: 'Ship it',
      handlerAgent: 'ops',
    });
  });
});
