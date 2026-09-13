import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), directConnect: vi.fn() }));
vi.mock('@agent-relay/harness-driver', () => ({ HarnessDriverClient: { connect: mocks.directConnect } }));
vi.mock('../lib/project-broker-client.js', () => ({ connectProjectBrokerClient: mocks.connect }));
import { launchSubscriptionRecipient, resolveSubscriptionAgentChannel } from './integration-recipient.js';

describe('subscription recipient launch', () => {
  const input = {
    name: 'fresh',
    cli: 'claude',
    provider: 'github',
    resource: '/github/repos/o/r/pulls/12/**',
    options: { workspaceKey: 'rk_live_explicit' },
  };
  let client: {
    getSession: ReturnType<typeof vi.fn>;
    listAgents: ReturnType<typeof vi.fn>;
    spawnCli: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let handle: {
    channels?: string[];
    waitForReady: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    handle = {
      channels: [],
      waitForReady: vi.fn(async () => ({ reason: 'ready', pid: 123 })),
      release: vi.fn(async () => {}),
    };
    client = {
      getSession: vi.fn(async () => ({
        workspace_key: 'rk_live_explicit',
        spawn_capabilities: { explicit_empty_channels: true, create_only_identity: true },
      })),
      listAgents: vi.fn(async () => []),
      spawnCli: vi.fn(async () => handle),
      disconnect: vi.fn(),
    };
    mocks.connect.mockReturnValue(client);
    mocks.directConnect.mockReturnValue(client);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { channels: [] } }), { status: 200 }))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('waits for a ready PID and passes only the explicit resource task', async () => {
    const launched = await launchSubscriptionRecipient({
      ...input,
      args: ['--disallowedTools', 'mcp__agent-relay__check_inbox'],
    });
    expect(handle.waitForReady).toHaveBeenCalledWith(90_000);
    expect(process.kill).toHaveBeenCalledWith(123, 0);
    expect(client.spawnCli).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'fresh',
        transport: 'pty',
        channels: [],
        args: ['--disallowedTools', 'mcp__agent-relay__check_inbox'],
        task: expect.stringContaining(input.resource),
      })
    );
    expect(handle.release).not.toHaveBeenCalled();
    await launched.rollback();
    launched.close();
    expect(handle.release).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it('spawns the recipient over pty so the confirmed local PID contract holds', async () => {
    const launched = await launchSubscriptionRecipient(input);
    expect(client.spawnCli).toHaveBeenCalledWith(expect.objectContaining({ transport: 'pty' }));
    await launched.rollback();
    launched.close();
  });
  it('rejects echoed empty channels when the live identity joined general', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { channels: [{ name: 'general' }] },
            }),
            { status: 200 }
          )
      )
    );
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow('live channel isolation');
    expect(handle.release).toHaveBeenCalledWith('subscription startup failed', { deleteIdentity: true });
  });
  it.each(['exited', 'timeout'])('cleans up a worker whose startup is %s', async (reason) => {
    handle.waitForReady.mockResolvedValue({ reason });
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow(reason);
    expect(handle.release).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it('refuses an older broker before it can join default channels or reuse an identity', async () => {
    client.getSession.mockResolvedValue({ workspace_key: 'rk_live_explicit' });
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow('isolated, create-only spawn support');
    expect(client.spawnCli).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();
  });
  it.each([undefined, ['general']])(
    'fails closed when channel isolation is not confirmed: %j',
    async (channels) => {
      handle.channels = channels;
      await expect(launchSubscriptionRecipient(input)).rejects.toThrow('channel isolation did not verify');
      expect(handle.waitForReady).not.toHaveBeenCalled();
      expect(handle.release).toHaveBeenCalledWith('subscription startup failed', { deleteIdentity: true });
    }
  );
  it.each([
    [401, 'unauthorized'],
    [409, 'channel_archived'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ])('reports routing HTTP %s without a misleading upgrade instruction', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code } }), { status: Number(status) }))
    );
    const failure = await resolveSubscriptionAgentChannel('fresh', input.options).catch((error) => error);
    expect(failure.message).toContain(`HTTP ${status} ${code}`);
    expect(failure.message).not.toMatch(/upgrade/i);
  });
  it.each([404, 405])('reports missing routing support for HTTP %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status }))
    );
    await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow(
      'relaycast PR #387'
    );
  });
  it('rejects a nonexistent cwd before connecting or registering a worker', async () => {
    mocks.connect.mockClear();
    await expect(
      launchSubscriptionRecipient({
        ...input,
        cwd: `/private/tmp/missing-github-demo-cwd-${process.pid}/child`,
      })
    ).rejects.toThrow('Invalid recipient cwd');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(client.spawnCli).not.toHaveBeenCalled();
  });
  it('rejects a mismatched workspace before spawning', async () => {
    client.getSession.mockResolvedValue({ workspace_key: 'rk_live_other' });
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow('different workspace');
    expect(client.spawnCli).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();
  });
  it('checks the workspace even when an explicit broker connection file is selected', async () => {
    client.getSession.mockResolvedValue({ workspace_key: 'rk_live_other' });
    await expect(
      launchSubscriptionRecipient({ ...input, brokerConnectionPath: '/tmp/owned-broker/connection.json' })
    ).rejects.toThrow('different workspace');
    expect(mocks.directConnect).toHaveBeenCalledWith({ connectionPath: '/tmp/owned-broker/connection.json' });
    expect(client.spawnCli).not.toHaveBeenCalled();
  });
  it('checks live isolation before reusing an existing ready worker', async () => {
    client.listAgents.mockResolvedValue([{ name: 'fresh', cli: 'claude', pid: 123, ready: true }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { channels: [{ name: 'general' }] } }), { status: 200 })
      )
    );
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow('live channel isolation');
    expect(client.spawnCli).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it('does not release an existing live worker on a later setup failure', async () => {
    client.listAgents.mockResolvedValue([{ name: 'fresh', cli: 'claude', pid: 123, ready: true }]);
    const launched = await launchSubscriptionRecipient(input);
    await launched.rollback();
    launched.close();
    expect(client.spawnCli).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();
  });
  it('does not treat an existing process without a ready handshake as launch confirmation', async () => {
    client.listAgents.mockResolvedValue([{ name: 'fresh', cli: 'claude', pid: 123, ready: false }]);
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow('not a confirmed live');
    expect(client.spawnCli).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();
  });
  it('retains both startup and cleanup errors', async () => {
    handle.waitForReady.mockResolvedValue({ reason: 'exited' });
    handle.release.mockRejectedValue(new Error('cleanup unavailable'));
    await expect(launchSubscriptionRecipient(input)).rejects.toMatchObject({
      errors: [expect.any(Error), expect.objectContaining({ message: 'cleanup unavailable' })],
    });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it('rejects unexpected members and never substitutes a same-named channel', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { name: 'agent-events-id', members: [{ agent_name: 'fresh' }, { agent_name: 'other' }] },
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow(
      'membership did not verify'
    );
    expect(fetcher.mock.calls[0][0].toString()).toBe(
      'https://cast.agentrelay.com/v1/agents/fresh/subscription-channel'
    );
  });

  describe('subscription-channel typed 429 retry', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const ok = () =>
      new Response(
        JSON.stringify({ data: { name: 'agent-events-id', members: [{ agent_name: 'fresh' }] } }),
        { status: 200 }
      );
    const busy = (retryAfter?: string) =>
      new Response(JSON.stringify({ error: { code: 'workspace_busy' } }), {
        status: 429,
        headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      });

    it('retries a typed 429 with Retry-After and verifies the exact membership on the fixed request', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(busy('2')).mockResolvedValueOnce(ok());
      vi.stubGlobal('fetch', fetcher);
      const pending = resolveSubscriptionAgentChannel('fresh', input.options);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBe('agent-events-id');
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [[firstUrl, firstInit], [secondUrl, secondInit]] = fetcher.mock.calls;
      expect(firstUrl.toString()).toBe('https://cast.agentrelay.com/v1/agents/fresh/subscription-channel');
      expect(secondUrl.toString()).toBe(firstUrl.toString());
      expect(secondInit.headers.authorization).toBe(firstInit.headers.authorization);
      expect(firstInit.headers.authorization).toBe('Bearer rk_live_explicit');
      expect(firstInit.method).toBe('POST');
    });

    it.each([undefined, 'soon'])(
      'retries with the bounded fallback when Retry-After is %s',
      async (retryAfter) => {
        const fetcher = vi
          .fn()
          .mockResolvedValueOnce(busy(retryAfter as string | undefined))
          .mockResolvedValueOnce(ok());
        vi.stubGlobal('fetch', fetcher);
        const pending = resolveSubscriptionAgentChannel('fresh', input.options);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toBe('agent-events-id');
        expect(fetcher).toHaveBeenCalledTimes(2);
      }
    );

    it('accepts an HTTP-date Retry-After', async () => {
      const retryAt = new Date(Date.now() + 1_500).toUTCString();
      const fetcher = vi.fn().mockResolvedValueOnce(busy(retryAt)).mockResolvedValueOnce(ok());
      vi.stubGlobal('fetch', fetcher);
      const pending = resolveSubscriptionAgentChannel('fresh', input.options);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBe('agent-events-id');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('bounds exhaustion at max attempts and banks the last 429/Retry-After evidence', async () => {
      const fetcher = vi.fn(async () => busy('1'));
      vi.stubGlobal('fetch', fetcher);
      const pending = resolveSubscriptionAgentChannel('fresh', input.options).catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain('HTTP 429 workspace_busy');
      expect(failure.message).toContain('Retry-After');
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('does not retry a typed 429 whose Retry-After exceeds the retry budget', async () => {
      const fetcher = vi.fn(async () => busy('60'));
      vi.stubGlobal('fetch', fetcher);
      const failure = await resolveSubscriptionAgentChannel('fresh', input.options).catch((error) => error);
      expect(failure.message).toContain('HTTP 429 workspace_busy');
      expect(failure.message).toContain('Retry-After');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 503])('does not retry HTTP %s', async (status) => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: Number(status) })
      );
      vi.stubGlobal('fetch', fetcher);
      await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow(`HTTP ${status}`);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not retry an unknown 429 code', async () => {
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 })
      );
      vi.stubGlobal('fetch', fetcher);
      await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow(
        'HTTP 429 rate_limited'
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not retry a network failure', async () => {
      const fetcher = vi.fn(async () => {
        throw new TypeError('network down');
      });
      vi.stubGlobal('fetch', fetcher);
      await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow('network down');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('still rejects invalid membership after a retry', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(busy('1'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: { name: 'agent-events-id', members: [{ agent_name: 'fresh' }, { agent_name: 'other' }] },
            }),
            { status: 200 }
          )
        );
      vi.stubGlobal('fetch', fetcher);
      const pending = resolveSubscriptionAgentChannel('fresh', input.options).catch((error) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      const failure = await pending;
      expect(failure.message).toContain('membership did not verify');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('clamps the per-attempt timeout to the remaining budget', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const fetcher = vi
        .fn()
        .mockImplementationOnce(async () => {
          // A slow first attempt consumes 20s of the 30s budget.
          vi.setSystemTime(Date.now() + 20_000);
          return busy('0');
        })
        .mockResolvedValueOnce(ok());
      vi.stubGlobal('fetch', fetcher);
      const pending = resolveSubscriptionAgentChannel('fresh', input.options);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe('agent-events-id');
      expect(fetcher).toHaveBeenCalledTimes(2);
      const timeouts = timeoutSpy.mock.calls.map((call) => call[0]);
      expect(timeouts[0]).toBe(15_000);
      expect(timeouts[1]).toBe(10_000); // min(15s, 30s - 20s)
      expect(timeouts[1]).toBeLessThanOrEqual(15_000);
    });

    it('does not start another attempt once a slow 429 has spent the budget, and preserves the prior 429 evidence', async () => {
      const fetcher = vi.fn().mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 30_000);
        return busy('1');
      });
      vi.stubGlobal('fetch', fetcher);
      const failure = await resolveSubscriptionAgentChannel('fresh', input.options).catch((error) => error);
      expect(failure.message).toContain('HTTP 429 workspace_busy');
      expect(failure.message).toContain('Retry-After');
      expect(failure.message).toContain('budget');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not fetch after the deadline when a retry sleep wakes late', async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(busy('1'));
      vi.stubGlobal('fetch', fetcher);
      const pending = resolveSubscriptionAgentChannel('fresh', input.options).catch((error) => error);
      await Promise.resolve(); // attempt 1 resolves and schedules the 1s sleep
      vi.setSystemTime(Date.now() + 31_000); // the wake-up lands past the deadline
      await vi.advanceTimersByTimeAsync(1_000);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain('HTTP 429 workspace_busy');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not follow or retry a 3xx response', async () => {
      const fetcher = vi.fn(
        async () =>
          new Response('', { status: 307, headers: { location: 'https://cast.agentrelay.com/unexpected' } })
      );
      vi.stubGlobal('fetch', fetcher);
      await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow('HTTP 307');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
    });
  });
});
