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

vi.mock('@agent-relay/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/sdk')>();
  return {
    ...actual,
    AgentRelay: vi.fn(function (this: unknown, options: unknown) {
      sdkMocks.AgentRelay(options);
      return { triggers: sdkMocks.triggers };
    }),
  };
});

import { defineNode, spawn } from '@agent-relay/fleet';

import type { CoreTeamsConfig } from '../commands/core.js';
import {
  createTriggerSyncClient,
  nodeCapacityHarnesses,
  resolveNodeCapacityHarnesses,
  resolveNodeMaxAgents,
} from './fleet-sidecar.js';

describe('nodeCapacityHarnesses', () => {
  it('advertises the default harness set (matching the broker default) when there is no config', () => {
    expect(nodeCapacityHarnesses(null)).toEqual(['claude', 'codex', 'opencode', 'muse', 'devin']);
  });

  it('advertises spawn:muse capacity from the default set', () => {
    expect(nodeCapacityHarnesses(null)).toContain('muse');
  });

  it('adds teams.json clis, de-duplicated and order-preserving', () => {
    const teams: CoreTeamsConfig = {
      team: 't',
      agents: [
        { name: 'a', cli: 'custom-native' },
        { name: 'removed', cli: 'aider' },
        { name: 'b', cli: 'claude' },
      ],
    };
    expect(nodeCapacityHarnesses(teams)).toEqual([
      'claude',
      'codex',
      'opencode',
      'muse',
      'devin',
      'custom-native',
    ]);
  });

  it('adds spawn:<harness> definitions from a discovered node config', () => {
    const definition = defineNode({
      name: 'p',
      capabilities: { 'spawn:custom-native': spawn({ runtime: 'pty', command: 'custom-native' }) },
    });
    expect(nodeCapacityHarnesses(null, definition)).toEqual([
      'claude',
      'codex',
      'opencode',
      'muse',
      'devin',
      'custom-native',
    ]);
  });

  it('does not advertise removed providers from legacy node descriptors', () => {
    expect(
      nodeCapacityHarnesses(null, {
        capabilities: { 'spawn:gemini': {}, 'spawn:cursor-agent': {}, 'spawn:custom-native': {} },
      })
    ).toEqual(['claude', 'codex', 'opencode', 'muse', 'devin', 'custom-native']);
  });
});

describe('resolveNodeCapacityHarnesses', () => {
  it('uses a pre-set AGENT_RELAY_NODE_HARNESSES value while filtering removed providers', () => {
    const teams: CoreTeamsConfig = { team: 't', agents: [{ name: 'a', cli: 'aider' }] };
    // A pinned value wins over the computed default+config set.
    expect(resolveNodeCapacityHarnesses('  claude  ', teams)).toBe('claude');
    expect(resolveNodeCapacityHarnesses('claude,codex', null)).toBe('claude,codex');
    expect(resolveNodeCapacityHarnesses('claude,gemini,cursor-agent', null)).toBe('claude');
  });

  it('rejects a preset containing only removed providers instead of advertising defaults', () => {
    expect(() => resolveNodeCapacityHarnesses('gemini,cursor-agent,aider,goose,droid', null)).toThrow(
      /does not contain a supported provider/
    );
  });

  it('computes defaults ∪ config when no value is pre-set', () => {
    const definition = defineNode({
      name: 'p',
      capabilities: { 'spawn:custom-native': spawn({ runtime: 'pty', command: 'custom-native' }) },
    });
    expect(resolveNodeCapacityHarnesses(undefined, null, definition)).toBe(
      'claude,codex,opencode,muse,devin,custom-native'
    );
    // A blank/whitespace value is treated as unset.
    expect(resolveNodeCapacityHarnesses('   ', null)).toBe('claude,codex,opencode,muse,devin');
  });
});

describe('resolveNodeMaxAgents', () => {
  it('uses a pre-set AGENT_RELAY_NODE_MAX_AGENTS value verbatim (operator authority)', () => {
    const definition = defineNode({
      name: 'p',
      maxAgents: 15,
      capabilities: { 'spawn:custom-native': spawn({ runtime: 'pty', command: 'custom-native' }) },
    });
    // A pinned value wins over the definition's cap.
    expect(resolveNodeMaxAgents('  32  ', definition)).toBe('32');
    expect(resolveNodeMaxAgents('4', undefined)).toBe('4');
  });

  it('forwards the node definition maxAgents when no value is pre-set', () => {
    const definition = defineNode({
      name: 'p',
      maxAgents: 15,
      capabilities: { 'spawn:custom-native': spawn({ runtime: 'pty', command: 'custom-native' }) },
    });
    expect(resolveNodeMaxAgents(undefined, definition)).toBe('15');
    // A blank/whitespace value is treated as unset.
    expect(resolveNodeMaxAgents('   ', definition)).toBe('15');
  });

  it('returns undefined when neither a preset nor the definition declares a cap', () => {
    const definition = defineNode({
      name: 'p',
      capabilities: { 'spawn:custom-native': spawn({ runtime: 'pty', command: 'custom-native' }) },
    });
    expect(resolveNodeMaxAgents(undefined, definition)).toBeUndefined();
    expect(resolveNodeMaxAgents(undefined, undefined)).toBeUndefined();
    expect(resolveNodeMaxAgents('   ', undefined)).toBeUndefined();
  });

  it('drops definition caps the broker cannot parse instead of reporting unlimited', () => {
    // Above u32::MAX the broker rejects the env value and reports unlimited,
    // so the forwarder must not emit it; the boundary itself stays valid.
    expect(resolveNodeMaxAgents(undefined, { capabilities: {}, maxAgents: 4294967296 })).toBeUndefined();
    expect(resolveNodeMaxAgents(undefined, { capabilities: {}, maxAgents: 4294967295 })).toBe('4294967295');
    expect(resolveNodeMaxAgents(undefined, { capabilities: {}, maxAgents: 0 })).toBeUndefined();
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
