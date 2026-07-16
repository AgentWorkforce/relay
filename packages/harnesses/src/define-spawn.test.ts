import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentRelay } from '@agent-relay/sdk';

const observeSemanticEventsMock = vi.fn(
  async (listener: (event: Record<string, unknown>) => void | Promise<void>) => {
    await listener({
      protocol_version: 1,
      name: 'Worker',
      sequence: 1,
      timestamp: '2026-07-16T00:00:00.000Z',
      event: {
        kind: 'activity.changed',
        activity: 'starting',
        previousActivity: 'idle',
        reason: 'session_starting',
        observability: {
          source: 'ai-sdk',
          fidelity: 'exact',
          sequence: 1,
          timestamp: '2026-07-16T00:00:00.000Z',
        },
      },
    });
    return async () => undefined;
  }
);
const observeBrokerEventsMock = vi.fn(
  async (listener: (event: Record<string, unknown>) => void | Promise<void>) => {
    await listener({ kind: 'agent_spawned', name: 'Worker', runtime: 'pty', cli: 'claude' });
    await listener({ kind: 'worker_stream', name: 'Worker', stream: 'stdout', chunk: 'working' });
    await listener({ kind: 'agent_idle', name: 'Worker', idle_secs: 1 });
    return async () => undefined;
  }
);

const spawnMock = vi.fn(async (input: { name: string; cli: string }) => ({
  agent: { name: input.name, id: `sess_${input.cli}` },
  delivery: { mode: 'managed' as const },
  status: async () => 'idle' as const,
  release: async () => {},
  observeSemanticEvents: observeSemanticEventsMock,
  observeBrokerEvents: observeBrokerEventsMock,
}));

const constructed: Array<Record<string, unknown> | undefined> = [];

vi.mock('@agent-relay/harness-driver', async (importActual) => {
  const actual = await importActual<typeof import('@agent-relay/harness-driver')>();
  return {
    ...actual,
    BrokerDriver: class {
      constructor(options?: Record<string, unknown>) {
        constructed.push(options);
      }
      spawn = spawnMock;
    },
  };
});

// Imported after the mock is registered (vi.mock is hoisted).
const { claude, codex, gemini, pi } = await import('./index.js');

const fakeRelay = (workspaceKey?: string): AgentRelay =>
  ({
    workspaceKey,
    emitSessionEvent: vi.fn(),
    publishSessionEvent: vi.fn(async () => undefined),
  }) as unknown as AgentRelay;

describe('create({ relay }) — live PTY spawn', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    observeSemanticEventsMock.mockClear();
    observeBrokerEventsMock.mockClear();
    constructed.length = 0;
  });

  it('spawns through the broker driver and returns a live handle', async () => {
    const relay = fakeRelay('rk_live_abc');
    const agent = await claude.create({ relay, model: 'sonnet' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ cli: 'claude', transport: 'pty', model: 'sonnet' })
    );
    expect(agent.cli).toBe('claude');
    expect(agent.runtime).toBe('pty');
    // Handle is keyed by the registered agent name so status predicates match.
    expect(agent.id).toBe(agent.name);
    expect(typeof agent.status.becomes('idle').subscribe).toBe('function');
  });

  it('binds the broker to the relay workspace key', async () => {
    const relay = fakeRelay('rk_live_xyz');
    await codex.create({ relay });
    expect(constructed[0]).toEqual({ env: { RELAY_API_KEY: 'rk_live_xyz' } });
  });

  it('translates live broker PTY boundaries into canonical published activity', async () => {
    const relay = fakeRelay('rk_live_pty_events');
    await claude.create({ relay, name: 'Worker' });

    expect(observeBrokerEventsMock).toHaveBeenCalledTimes(1);
    expect(relay.emitSessionEvent).toHaveBeenCalledWith(
      'Worker',
      expect.objectContaining({
        type: 'activity.changed',
        activity: 'thinking',
        observability: expect.objectContaining({ source: 'broker', fidelity: 'inferred' }),
      })
    );
    expect(relay.emitSessionEvent).toHaveBeenCalledWith(
      'Worker',
      expect.objectContaining({ type: 'activity.changed', activity: 'idle' })
    );
  });

  it('reuses one broker driver across agents for the same relay', async () => {
    const relay = fakeRelay('rk_live_shared');
    await claude.create({ relay });
    await codex.create({ relay });
    expect(constructed).toHaveLength(1);
  });

  it('throws a clear error when the relay has no workspace', async () => {
    await expect(claude.create({ relay: fakeRelay(undefined) })).rejects.toThrow(/needs a workspace/);
  });

  it('without relay, create() builds a descriptor and never spawns', async () => {
    const agent = await claude.create({ model: 'sonnet' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(agent.cli).toBe('claude');
  });

  it('spawns an explicit AI SDK backend through the broker-owned semantic sidecar', async () => {
    const agent = await claude.create({
      relay: fakeRelay('rk_live_semantic'),
      backend: 'ai-sdk',
      model: 'sonnet',
      cwd: '/tmp/relay-semantic-test',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: 'claude',
        transport: 'headless',
        harnessConfig: expect.objectContaining({
          runtime: 'semantic',
          command: process.execPath,
          sessionId: expect.stringMatching(/^semantic-/),
          metadata: expect.objectContaining({
            runtimeKind: 'semantic-harness',
            semanticProtocolVersion: 1,
            semanticCapabilities: expect.objectContaining({
              activeInput: true,
              toolApprovals: true,
              compact: true,
              continueTurn: false,
              suspendTurn: false,
              detach: false,
              stop: false,
              destroy: false,
            }),
          }),
        }),
      })
    );
    const spawn = spawnMock.mock.calls[0]?.[0] as {
      harnessConfig: { env: { RELAY_AI_SDK_SIDECAR_CONFIG: string } };
    };
    expect(JSON.parse(spawn.harnessConfig.env.RELAY_AI_SDK_SIDECAR_CONFIG)).toMatchObject({
      harness: 'claude',
      workspace: '/tmp/relay-semantic-test',
      settings: { model: 'sonnet' },
    });
    expect(agent).toMatchObject({ runtime: 'semantic-harness', backend: 'ai-sdk' });
    expect(observeSemanticEventsMock).toHaveBeenCalledTimes(1);
  });

  it('bridges broker semantic activity into AgentRelay listeners without manual emission', async () => {
    const relay = fakeRelay('rk_live_semantic_events');
    await claude.create({ relay, backend: 'ai-sdk', name: 'Observed' });
    expect(relay.emitSessionEvent).toHaveBeenCalledWith(
      'Observed',
      expect.objectContaining({
        type: 'activity.changed',
        activity: 'starting',
        observability: expect.objectContaining({ source: 'ai-sdk', fidelity: 'exact' }),
      })
    );
  });

  it('keeps experimental shared adapters on PTY in auto mode', async () => {
    const descriptor = claude.new({ backend: 'auto' });
    expect(descriptor).toMatchObject({ runtime: 'pty', backend: 'pty' });
  });

  it('requires explicit opt-in for experimental AI SDK-only adapters', async () => {
    await expect(pi.create()).rejects.toThrow(/experimental AI SDK-only harness/);
    const descriptor = await pi.create({ backend: 'ai-sdk' });
    expect(descriptor).toMatchObject({
      runtime: 'semantic-harness',
      backend: 'ai-sdk',
      adapter: 'pi',
    });
  });

  it('rejects AI SDK selection for unsupported PTY harnesses', async () => {
    await expect(gemini.create({ backend: 'ai-sdk' })).rejects.toThrow(
      /No AI SDK harness adapter is registered/
    );
  });
});
