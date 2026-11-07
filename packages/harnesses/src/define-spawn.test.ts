import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentRelay } from '@agent-relay/sdk';

const observeAgentEventsMock = vi.fn(
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
  observeAgentEvents: observeAgentEventsMock,
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
    observeAgentEventsMock.mockClear();
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

  it('spawns an explicit native runtime through the broker-owned AI SDK sidecar', async () => {
    const agent = await claude.create({
      relay: fakeRelay('rk_live_native'),
      runtime: 'native',
      model: 'sonnet',
      cwd: '/tmp/relay-native-harness-test',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: 'claude',
        transport: 'headless',
        harnessConfig: expect.objectContaining({
          runtime: 'native',
          command: process.execPath,
          sessionId: expect.stringMatching(/^native-/),
          metadata: expect.objectContaining({
            runtimeKind: 'native',
            nativeHarnessProtocolVersion: 1,
            nativeHarnessCapabilities: expect.objectContaining({
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
      workspace: '/tmp/relay-native-harness-test',
      settings: { model: 'sonnet' },
    });
    expect(agent).toMatchObject({ runtime: 'native', adapter: 'claude' });
    expect(observeAgentEventsMock).toHaveBeenCalledTimes(1);
  });

  it('bridges broker normalized activity into AgentRelay listeners without manual emission', async () => {
    const relay = fakeRelay('rk_live_agent_events');
    await claude.create({ relay, runtime: 'native', name: 'Observed' });
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
    const descriptor = claude.new({ runtime: 'auto' });
    expect(descriptor).toMatchObject({ runtime: 'pty' });
  });

  it('requires explicit opt-in for experimental native-only adapters', async () => {
    await expect(pi.create()).rejects.toThrow(/experimental native-only harness/);
    const descriptor = await pi.create({ runtime: 'native' });
    expect(descriptor).toMatchObject({
      runtime: 'native',
      adapter: 'pi',
    });
  });

  it('rejects native selection for unsupported PTY harnesses', async () => {
    await expect(gemini.create({ runtime: 'native' })).rejects.toThrow(
      /No native harness adapter is registered/
    );
  });
});
