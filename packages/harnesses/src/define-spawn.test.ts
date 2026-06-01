import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentRelay } from '@agent-relay/sdk';

const spawnMock = vi.fn(async (input: { name: string; cli: string }) => ({
  agent: { name: input.name, id: `sess_${input.cli}` },
  delivery: { mode: 'managed' as const },
  status: async () => 'idle' as const,
  release: async () => {},
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
const { claude, codex } = await import('./index.js');

const fakeRelay = (workspaceKey?: string): AgentRelay => ({ workspaceKey }) as unknown as AgentRelay;

describe('create({ relay }) — live PTY spawn', () => {
  beforeEach(() => {
    spawnMock.mockClear();
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
});
