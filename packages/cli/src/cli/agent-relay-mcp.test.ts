import { describe, expect, it, vi } from 'vitest';

import { optionsFromEnv, registerAgentWithRebind } from './agent-relay-mcp.js';

describe('registerAgentWithRebind', () => {
  it('reuses the pre-registered strict token without re-registering', async () => {
    const setSession = vi.fn();
    const registerOrRotate = vi.fn();

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: 'at_live_existing',
        agentName: 'WorkerA',
      },
      setSession,
      getRelay: () =>
        ({
          agents: {
            registerOrRotate,
          },
        }) as never,
      name: 'DifferentName',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(payload).toEqual({
      name: 'WorkerA',
      token: 'at_live_existing',
      registered_name: 'WorkerA',
      warnings: [
        'Strict worker identity is enabled; ignoring requested name "DifferentName" and using "WorkerA".',
      ],
    });
  });

  const IDENTITY = {
    organization: 'AgentWorkforce',
    project: 'chief-delegation-governance',
    workstream: 'dispatch-contract',
    role: 'lead',
    reportsTo: 'chief-khaliq',
  };

  const strictSession = () => ({
    workspaceKey: 'rk_live_test',
    agentToken: 'at_live_existing',
    agentName: 'WorkerA',
    agents: new Map([['WorkerA', { agentName: 'WorkerA', agentToken: 'at_live_existing' }]]),
  });

  /**
   * A relay that actually stores what it is given, so a test can read the
   * record back instead of trusting that the call was made. Asserting only
   * "registerOrRotate was called with metadata" would repeat the mistake this
   * whole change is about: the parameter being passed is not the field
   * landing. `persists: false` models the broken platform.
   */
  function fakeRelay({ persists = true }: { persists?: boolean } = {}) {
    // The platform writes its own block; a verifier must ignore it.
    const records = new Map<string, Record<string, unknown>>([['WorkerA', { fleet: { nodeId: 'node_x' } }]]);
    const registerOrRotate = vi.fn(async (input: any) => {
      if (persists && input.metadata) {
        records.set(input.name, { ...records.get(input.name), ...input.metadata });
      }
      return { id: 'agent_123', name: input.name, token: 'at_live_rotated', status: 'online' };
    });
    const list = vi.fn(async () => [...records].map(([name, metadata]) => ({ name, metadata })));
    return { agents: { registerOrRotate, list }, records };
  }

  it('writes supplied metadata through and proves it landed on the record', async () => {
    // The short-circuit exists to avoid handing back a dead token. It must not
    // also swallow a write: a caller supplying metadata is asking for the
    // agent record to change, and returning a cached token discarded that
    // silently — success, no warnings, record untouched.
    const relay = fakeRelay();

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      metadata: IDENTITY,
      verifyMetadata: true,
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(relay.agents.registerOrRotate).toHaveBeenCalledOnce();

    // The round trip, not just the call: read the record back and assert the
    // fields are actually there.
    const [record] = (await relay.agents.list()).filter((a) => a.name === 'WorkerA');
    expect(record.metadata).toMatchObject(IDENTITY);
    expect(record.metadata.fleet, 'must not clobber platform keys').toEqual({ nodeId: 'node_x' });

    expect(payload.metadata_verified).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it('verifies nested metadata even when the platform re-serializes keys in a different order', async () => {
    // `metadata` accepts nested objects (z.record(z.string(), z.unknown())),
    // and the platform is free to re-serialize a stored record with keys in a
    // different order than the caller sent them — JSON round-tripping makes
    // no ordering guarantee. A comparison via JSON.stringify would treat this
    // as a mismatch and report `metadata_verified: false` on a registration
    // that actually succeeded: a verifier failing on success, the exact
    // defect class it exists to catch. This test fails against that
    // implementation and passes against an order-insensitive one.
    const supplied = {
      context: { role: 'lead', team: 'delegation-governance' },
    };
    const storedWithDifferentKeyOrder = {
      fleet: { nodeId: 'node_x' },
      context: { team: 'delegation-governance', role: 'lead' },
    };
    const relay = {
      agents: {
        registerOrRotate: vi.fn(async (input: any) => ({
          id: 'agent_123',
          name: input.name,
          token: 'at_live_rotated',
          status: 'online',
        })),
        list: vi.fn(async () => [{ name: 'WorkerA', metadata: storedWithDifferentKeyOrder }]),
      },
    };

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      metadata: supplied,
      verifyMetadata: true,
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(payload.metadata_verified).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it('still catches a genuine nested mismatch under the order-insensitive comparison', async () => {
    // The order-insensitive switch (isDeepStrictEqual) must not become a
    // rubber stamp: same shape, a value that is actually different rather
    // than reordered, must still fail verification. Proving the positive arm
    // (reordered-but-equal passes) discriminates says nothing about whether
    // this control arm (genuinely different still fails) does too — an
    // overly lenient comparison could pass both by accident.
    const supplied = {
      context: { role: 'lead', team: 'delegation-governance' },
    };
    const storedWithDifferentValue = {
      fleet: { nodeId: 'node_x' },
      context: { role: 'worker', team: 'delegation-governance' },
    };
    const relay = {
      agents: {
        registerOrRotate: vi.fn(async (input: any) => ({
          id: 'agent_123',
          name: input.name,
          token: 'at_live_rotated',
          status: 'online',
        })),
        list: vi.fn(async () => [{ name: 'WorkerA', metadata: storedWithDifferentValue }]),
      },
    };

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      metadata: supplied,
      verifyMetadata: true,
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(payload.metadata_verified).toBe(false);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toContain('context');
  });

  it('says so loudly when the platform accepts metadata and does not persist it', async () => {
    // This is the exact defect being fixed, reproduced: the write is accepted,
    // the response looks like success, and the record is untouched. A
    // passthrough that fails this way is worse than none, because it looks
    // like it worked. It must never again be reported as a clean success.
    const relay = fakeRelay({ persists: false });

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      metadata: IDENTITY,
      verifyMetadata: true,
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(payload.metadata_verified).toBe(false);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toContain('was not persisted');
    expect(payload.warnings[0]).toContain('organization');
    expect(payload.warnings[0]).toContain('Treat this registration as unattributed');
  });

  it('reports unverified rather than throwing when the record cannot be read back', async () => {
    // The registration itself succeeded; claiming it failed would be its own
    // kind of lie. But it must not be reported as verified either.
    const relay = fakeRelay();
    relay.agents.list = vi.fn(async () => {
      throw new Error('workspace unreachable');
    }) as never;

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      metadata: IDENTITY,
      verifyMetadata: true,
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(payload.token).toBe('at_live_rotated');
    expect(payload.metadata_verified).toBe(false);
    expect(payload.warnings[0]).toContain('could not read the record back');
    expect(payload.warnings[0]).toContain('workspace unreachable');
  });

  it('writes a supplied persona through, and claims no metadata verification', async () => {
    const relay = fakeRelay();

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      persona: 'Accountable lead for chief-delegation-governance',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(relay.agents.registerOrRotate).toHaveBeenCalledOnce();
    // No metadata was supplied, so there is nothing to verify and no read-back
    // cost is paid.
    expect(relay.agents.list).not.toHaveBeenCalled();
    expect(payload.metadata_verified).toBeUndefined();
  });

  it("reports 'unchecked' rather than success when nobody verified the write", async () => {
    // Verification costs a workspace listing, so the per-spawn `{model}` hint
    // does not pay for it. But "nobody looked" must not be reported as "it is
    // there" — collapsing those two is the same error as the silent discard.
    const relay = fakeRelay({ persists: false });

    const payload = await registerAgentWithRebind({
      session: strictSession(),
      setSession: vi.fn(),
      getRelay: () => relay as never,
      name: 'WorkerA',
      metadata: { model: 'gpt-5' },
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(payload.metadata_verified).toBe('unchecked');
    expect(relay.agents.list).not.toHaveBeenCalled();
    // Not a warning: nothing is known to be wrong. The claim is simply scoped.
    expect(payload.warnings).toEqual([]);
  });

  it('still short-circuits when the caller only wants a token', async () => {
    // The original behaviour has to survive: a bare re-registration with no
    // write to make should not rotate the token for nothing.
    const registerOrRotate = vi.fn();

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: 'at_live_existing',
        agentName: 'WorkerA',
        agents: new Map([['WorkerA', { agentName: 'WorkerA', agentToken: 'at_live_existing' }]]),
      },
      setSession: vi.fn(),
      getRelay: () => ({ agents: { registerOrRotate } }) as never,
      name: 'WorkerA',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ token: 'at_live_existing' });
  });

  it('re-registers when the strict-named identity was dropped from the agents map', async () => {
    // After an `agent_token_invalid` recovery, the active token is null and
    // the identity is missing from session.agents. The short-circuit must
    // fall through to registerOrRotate instead of handing back the dead token.
    const setSession = vi.fn();
    const registerOrRotate = vi.fn().mockResolvedValue({
      id: 'agent_456',
      name: 'WorkerA',
      token: 'at_live_fresh',
      status: 'online',
    });

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: null,
        agentName: 'WorkerA',
        agents: new Map(),
      },
      setSession,
      getRelay: () =>
        ({
          agents: { registerOrRotate },
        }) as never,
      name: 'WorkerA',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ token: 'at_live_fresh', registered_name: 'WorkerA' });
  });

  it('re-registers when the agents map exists but the strict name is absent', async () => {
    // Edge case: token is still set but the identity was evicted. The session
    // is in an inconsistent state, so a fresh registration is the safe path.
    const setSession = vi.fn();
    const registerOrRotate = vi.fn().mockResolvedValue({
      id: 'agent_789',
      name: 'WorkerA',
      token: 'at_live_rotated',
      status: 'online',
    });

    await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: 'at_live_dead',
        agentName: null,
        agents: new Map(),
      },
      setSession,
      getRelay: () =>
        ({
          agents: { registerOrRotate },
        }) as never,
      name: 'WorkerA',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).toHaveBeenCalledOnce();
  });

  it('prefers the per-identity token from the agents map when available', async () => {
    const setSession = vi.fn();
    const registerOrRotate = vi.fn();

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: 'at_live_stale_active',
        agentName: 'WorkerA',
        agents: new Map([['WorkerA', { agentName: 'WorkerA', agentToken: 'at_live_per_identity' }]]),
      },
      setSession,
      getRelay: () =>
        ({
          agents: { registerOrRotate },
        }) as never,
      name: 'WorkerA',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ token: 'at_live_per_identity' });
  });

  it('registers or rotates and updates the bound session token', async () => {
    const setSession = vi.fn();
    const registerOrRotate = vi.fn().mockResolvedValue({
      id: 'agent_123',
      name: 'WorkerA',
      token: 'at_live_rotated',
      status: 'online',
    });

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: null,
        agentName: null,
      },
      setSession,
      getRelay: () =>
        ({
          agents: {
            registerOrRotate,
          },
        }) as never,
      name: 'WorkerA',
      type: 'agent',
      persona: 'Test worker',
      metadata: { model: 'gpt-5' },
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).toHaveBeenCalledWith({
      name: 'WorkerA',
      type: 'agent',
      persona: 'Test worker',
      metadata: { model: 'gpt-5' },
    });
    expect(setSession).toHaveBeenCalledWith({
      agentToken: 'at_live_rotated',
      agentName: 'WorkerA',
    });
    expect(payload).toMatchObject({
      id: 'agent_123',
      name: 'WorkerA',
      token: 'at_live_rotated',
      registered_name: 'WorkerA',
      warnings: [],
    });
  });

  it('returns promptly with the real recovery path when rotation hangs', async () => {
    const never = new Promise<never>(() => undefined);

    await expect(
      registerAgentWithRebind({
        session: {
          workspaceKey: 'rk_live_test',
          agentToken: null,
          agentName: 'chief',
          agents: new Map(),
        },
        setSession: vi.fn(),
        getRelay: () =>
          ({
            agents: { registerOrRotate: vi.fn(() => never) },
          }) as never,
        name: 'chief',
        strictAgentName: true,
        preferredAgentName: 'chief',
        registrationTimeoutMs: 10,
      })
    ).rejects.toThrow(/did not complete within 10ms.*agent rotate.*agent remove/s);
  });
});

describe('optionsFromEnv', () => {
  it('auto-selects an orchestrator identity when a workspace key is configured', () => {
    const previous = {
      workspaceKey: process.env.RELAY_WORKSPACE_KEY,
      apiKey: process.env.RELAY_API_KEY,
      agentName: process.env.RELAY_AGENT_NAME,
      clawName: process.env.RELAY_CLAW_NAME,
    };
    process.env.RELAY_WORKSPACE_KEY = 'rk_live_test';
    delete process.env.RELAY_API_KEY;
    delete process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_CLAW_NAME;

    try {
      expect(optionsFromEnv()).toMatchObject({
        workspaceKey: 'rk_live_test',
        agentName: 'orchestrator',
      });
    } finally {
      if (previous.workspaceKey === undefined) delete process.env.RELAY_WORKSPACE_KEY;
      else process.env.RELAY_WORKSPACE_KEY = previous.workspaceKey;
      if (previous.apiKey === undefined) delete process.env.RELAY_API_KEY;
      else process.env.RELAY_API_KEY = previous.apiKey;
      if (previous.agentName === undefined) delete process.env.RELAY_AGENT_NAME;
      else process.env.RELAY_AGENT_NAME = previous.agentName;
      if (previous.clawName === undefined) delete process.env.RELAY_CLAW_NAME;
      else process.env.RELAY_CLAW_NAME = previous.clawName;
    }
  });

  it('ignores unresolved template environment placeholders', () => {
    const previous = {
      workspaceKey: process.env.RELAY_WORKSPACE_KEY,
      agentRelayWorkspaceKey: process.env.AGENT_RELAY_WORKSPACE_KEY,
      apiKey: process.env.RELAY_API_KEY,
      agentName: process.env.RELAY_AGENT_NAME,
      clawName: process.env.RELAY_CLAW_NAME,
      agentToken: process.env.RELAY_AGENT_TOKEN,
    };
    process.env.RELAY_WORKSPACE_KEY = '${RELAY_WORKSPACE_KEY}';
    delete process.env.AGENT_RELAY_WORKSPACE_KEY;
    delete process.env.RELAY_API_KEY;
    process.env.RELAY_AGENT_NAME = '${RELAY_AGENT_NAME}';
    process.env.RELAY_CLAW_NAME = 'ClawFallback';
    process.env.RELAY_AGENT_TOKEN = '${RELAY_AGENT_TOKEN}';

    try {
      expect(optionsFromEnv()).toMatchObject({
        workspaceKey: undefined,
        agentName: 'ClawFallback',
        agentToken: undefined,
      });
    } finally {
      if (previous.workspaceKey === undefined) delete process.env.RELAY_WORKSPACE_KEY;
      else process.env.RELAY_WORKSPACE_KEY = previous.workspaceKey;
      if (previous.agentRelayWorkspaceKey === undefined) {
        delete process.env.AGENT_RELAY_WORKSPACE_KEY;
      } else {
        process.env.AGENT_RELAY_WORKSPACE_KEY = previous.agentRelayWorkspaceKey;
      }
      if (previous.apiKey === undefined) delete process.env.RELAY_API_KEY;
      else process.env.RELAY_API_KEY = previous.apiKey;
      if (previous.agentName === undefined) delete process.env.RELAY_AGENT_NAME;
      else process.env.RELAY_AGENT_NAME = previous.agentName;
      if (previous.clawName === undefined) delete process.env.RELAY_CLAW_NAME;
      else process.env.RELAY_CLAW_NAME = previous.clawName;
      if (previous.agentToken === undefined) delete process.env.RELAY_AGENT_TOKEN;
      else process.env.RELAY_AGENT_TOKEN = previous.agentToken;
    }
  });
});
