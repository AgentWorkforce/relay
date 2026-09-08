import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
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
  let handle: { waitForReady: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    handle = {
      waitForReady: vi.fn(async () => ({ reason: 'ready', pid: 123 })),
      release: vi.fn(async () => {}),
    };
    client = {
      getSession: vi.fn(async () => ({ workspace_key: 'rk_live_explicit' })),
      listAgents: vi.fn(async () => []),
      spawnCli: vi.fn(async () => handle),
      disconnect: vi.fn(),
    };
    mocks.connect.mockReturnValue(client);
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('waits for a ready PID and passes only the explicit resource task', async () => {
    const launched = await launchSubscriptionRecipient(input);
    expect(handle.waitForReady).toHaveBeenCalledWith(90_000);
    expect(process.kill).toHaveBeenCalledWith(123, 0);
    expect(client.spawnCli).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fresh', channels: [], task: expect.stringContaining(input.resource) })
    );
    expect(handle.release).not.toHaveBeenCalled();
    await launched.rollback();
    launched.close();
    expect(handle.release).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it.each(['exited', 'timeout'])('cleans up a worker whose startup is %s', async (reason) => {
    handle.waitForReady.mockResolvedValue({ reason });
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow(reason);
    expect(handle.release).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it('rejects a nonexistent cwd before connecting or registering a worker', async () => {
    mocks.connect.mockClear();
    await expect(launchSubscriptionRecipient({ ...input, cwd: `/private/tmp/missing-github-demo-cwd-${process.pid}/child` })).rejects.toThrow('Invalid recipient cwd');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(client.spawnCli).not.toHaveBeenCalled();
  });
  it('rejects a mismatched workspace before spawning', async () => {
    client.getSession.mockResolvedValue({ workspace_key: 'rk_live_other' });
    await expect(launchSubscriptionRecipient(input)).rejects.toThrow('different workspace');
    expect(client.spawnCli).not.toHaveBeenCalled();
    expect(handle.release).not.toHaveBeenCalled();
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
});
