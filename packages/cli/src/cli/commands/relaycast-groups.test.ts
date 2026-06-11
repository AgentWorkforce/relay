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
