import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerAgentCommands } from './agent.js';
import { registerChannelCommands } from './channel.js';
import { registerMessageCommands } from './message.js';
import { registerIntegrationCommands } from './integration.js';
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
      },
      subscriptions: { create: vi.fn(async (i: unknown) => ({ id: 'sub1', ...(i as object) })) },
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
    firstRelay.webhooks.createInbound.mockRejectedValueOnce(new Error('Invalid API key'));
    const createAgentRelay = vi.fn().mockReturnValueOnce(firstRelay).mockReturnValueOnce(secondRelay);
    const resolveLocalWorkspaceKey = vi.fn(async () => 'rk_live_local');
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
      resolveLocalWorkspaceKey,
    });

    await program.parseAsync(['integration', 'webhook', 'create-inbound', 'general'], { from: 'user' });

    expect(resolveLocalWorkspaceKey).toHaveBeenCalled();
    expect(createAgentRelay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceKey: 'rk_live_local' })
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
    const resolveLocalWorkspaceKey = vi.fn(async () => 'rk_live_local');
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
      resolveLocalWorkspaceKey,
    });

    await program.parseAsync(
      ['integration', 'webhook', 'create-inbound', 'general', '--workspace-key', 'rk_live_explicit'],
      { from: 'user' }
    );

    expect(resolveLocalWorkspaceKey).not.toHaveBeenCalled();
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
