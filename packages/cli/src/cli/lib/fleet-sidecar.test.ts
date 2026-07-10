import { describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  AgentRelay: vi.fn(),
  triggers: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
  },
}));

vi.mock('@agent-relay/sdk', () => ({
  AgentRelay: vi.fn(function (this: unknown, options: unknown) {
    sdkMocks.AgentRelay(options);
    return { triggers: sdkMocks.triggers };
  }),
}));

import { defineNode, spawn } from '@agent-relay/fleet';

import type { CoreTeamsConfig } from '../commands/core.js';
import { createTriggerSyncClient, nodeCapacityHarnesses } from './fleet-sidecar.js';

describe('nodeCapacityHarnesses', () => {
  it('advertises the default harness set when there is no config', () => {
    expect(nodeCapacityHarnesses(null)).toEqual(['claude', 'codex', 'gemini']);
  });

  it('adds teams.json clis, de-duplicated and order-preserving', () => {
    const teams: CoreTeamsConfig = {
      team: 't',
      agents: [
        { name: 'a', cli: 'aider' },
        { name: 'b', cli: 'claude' },
      ],
    };
    expect(nodeCapacityHarnesses(teams)).toEqual(['claude', 'codex', 'gemini', 'aider']);
  });

  it('adds spawn:<harness> definitions from a discovered node config', () => {
    const definition = defineNode({
      name: 'p',
      capabilities: { 'spawn:opencode': spawn({ runtime: 'pty', command: 'opencode' }) },
    });
    expect(nodeCapacityHarnesses(null, definition)).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
    ]);
  });
});

describe('createTriggerSyncClient', () => {
  it('constructs an AgentRelay with the workspace key and base URL', () => {
    createTriggerSyncClient({ workspaceKey: 'rk_live_test', baseUrl: 'https://relay.example' });

    expect(sdkMocks.AgentRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      baseUrl: 'https://relay.example',
    });
  });

  it('omits baseUrl when not provided', () => {
    sdkMocks.AgentRelay.mockClear();
    createTriggerSyncClient({ workspaceKey: 'rk_live_test' });

    expect(sdkMocks.AgentRelay).toHaveBeenCalledWith({ workspaceKey: 'rk_live_test' });
  });

  it('maps list/create/update/delete onto the relay triggers API', async () => {
    const client = createTriggerSyncClient({ workspaceKey: 'rk_live_test' });

    await client.list();
    await client.create({ actionName: 'echo', enabled: true });
    await client.update('trigger-1', { actionName: 'echo', enabled: false });
    await client.delete('trigger-1');

    expect(sdkMocks.triggers.list).toHaveBeenCalledTimes(1);
    expect(sdkMocks.triggers.create).toHaveBeenCalledWith({ actionName: 'echo', enabled: true });
    expect(sdkMocks.triggers.update).toHaveBeenCalledWith('trigger-1', {
      actionName: 'echo',
      enabled: false,
    });
    expect(sdkMocks.triggers.delete).toHaveBeenCalledWith('trigger-1');
  });
});
