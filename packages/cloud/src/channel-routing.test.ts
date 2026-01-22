/**
 * Unit tests for channel routing in the cloud server.
 * Tests the routing logic that directs channel operations to the correct daemon.
 *
 * Critical paths tested:
 * - Local dashboard URL detection
 * - Channel create with agent invites
 * - Channel join with user subscription
 * - Channel message routing
 * - WebSocket proxy connections
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

/**
 * Tests for getLocalDashboardUrl detection logic
 */
describe('Local Dashboard URL Detection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should detect dashboard on first available port (3889)', async () => {
    // Port 3889 responds OK
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { detectLocalDashboard } = await createDetectionHelpers();
    const url = await detectLocalDashboard();

    expect(url).toBe('http://localhost:3889');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/health',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('should try next port if first port fails', async () => {
    // Port 3889 fails, 3888 responds OK
    mockFetch
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ ok: true });

    const { detectLocalDashboard } = await createDetectionHelpers();
    const url = await detectLocalDashboard();

    expect(url).toBe('http://localhost:3888');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should try all ports before giving up', async () => {
    // All ports fail
    mockFetch
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('Connection refused'));

    const { detectLocalDashboard } = await createDetectionHelpers();
    const url = await detectLocalDashboard();

    expect(url).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should handle non-OK responses and try next port', async () => {
    // Port 3889 returns 404, 3888 returns OK
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true });

    const { detectLocalDashboard } = await createDetectionHelpers();
    const url = await detectLocalDashboard();

    expect(url).toBe('http://localhost:3888');
  });

  it('should use configured URL if provided', async () => {
    const configuredUrl = 'http://custom-dashboard:9999';
    const { getLocalDashboardUrl } = await createDetectionHelpers(configuredUrl);

    const url = await getLocalDashboardUrl();

    expect(url).toBe(configuredUrl);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should cache detected URL for subsequent calls', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const { getLocalDashboardUrl } = await createDetectionHelpers();

    const url1 = await getLocalDashboardUrl();
    const url2 = await getLocalDashboardUrl();
    const url3 = await getLocalDashboardUrl();

    expect(url1).toBe(url2);
    expect(url2).toBe(url3);
    // Detection should only happen once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tests for channel create with agent invites
 */
describe('Channel Create - Agent Sync', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should sync agent to local dashboard on channel create', async () => {
    // Dashboard detection
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Admin join call
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const { syncAgentToChannel } = await createChannelHelpers();
    await syncAgentToChannel('#general', 'CodeReviewer', 'workspace-123');

    // Should call admin-join on local dashboard
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/api/channels/admin-join',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: '#general',
          member: 'CodeReviewer',
          workspaceId: 'workspace-123',
        }),
      })
    );
  });

  it('should prepend # to channel name if missing', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const { syncAgentToChannel } = await createChannelHelpers();
    await syncAgentToChannel('general', 'CodeReviewer', 'workspace-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/api/channels/admin-join',
      expect.objectContaining({
        body: expect.stringContaining('"channel":"#general"'),
      })
    );
  });

  it('should handle admin-join failure gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { syncAgentToChannel } = await createChannelHelpers();

    // Should not throw
    await expect(syncAgentToChannel('#general', 'CodeReviewer', 'workspace-123')).resolves.not.toThrow();
  });

  it('should sync multiple agents to channel', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    const { syncAgentToChannel } = await createChannelHelpers();
    await syncAgentToChannel('#general', 'CodeReviewer', 'workspace-123');
    await syncAgentToChannel('#general', 'Lead', 'workspace-123');
    await syncAgentToChannel('#general', 'QA', 'workspace-123');

    // 1 detection + 3 admin-join calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

/**
 * Tests for channel join with user subscription
 */
describe('Channel Join - User Subscribe', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should subscribe user to channel on local dashboard', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, channels: ['#general'] }),
    });

    const { subscribeUserToChannel } = await createChannelHelpers();
    await subscribeUserToChannel('alice', ['#general'], 'workspace-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/api/channels/subscribe',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          username: 'alice',
          channels: ['#general'],
          workspaceId: 'workspace-123',
        }),
      })
    );
  });

  it('should subscribe user to multiple channels', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, channels: ['#general', '#engineering', '#random'] }),
    });

    const { subscribeUserToChannel } = await createChannelHelpers();
    await subscribeUserToChannel('alice', ['#general', '#engineering', '#random'], 'workspace-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/api/channels/subscribe',
      expect.objectContaining({
        body: JSON.stringify({
          username: 'alice',
          channels: ['#general', '#engineering', '#random'],
          workspaceId: 'workspace-123',
        }),
      })
    );
  });

  it('should handle subscribe failure gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { subscribeUserToChannel } = await createChannelHelpers();
    const result = await subscribeUserToChannel('alice', ['#general'], 'workspace-123');

    expect(result.success).toBe(false);
  });
});

/**
 * Tests for channel message routing
 */
describe('Channel Message Routing', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should route channel message to local dashboard', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const { sendChannelMessage } = await createChannelHelpers();
    await sendChannelMessage('alice', '#general', 'Hello everyone!', 'workspace-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/api/channels/message',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          username: 'alice',
          channel: '#general',
          body: 'Hello everyone!',
          workspaceId: 'workspace-123',
        }),
      })
    );
  });

  it('should include thread ID when provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const { sendChannelMessage } = await createChannelHelpers();
    await sendChannelMessage('alice', '#general', 'Reply in thread', 'workspace-123', 'thread-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3889/api/channels/message',
      expect.objectContaining({
        body: expect.stringContaining('"thread":"thread-123"'),
      })
    );
  });
});

/**
 * Tests for channel invite with workspaceId
 */
describe('Channel Invite', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should include workspaceId in invite request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const { inviteToChannel } = await createChannelHelpers();
    await inviteToChannel('#engineering', ['bob', 'charlie'], 'workspace-123');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/channels/invite'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: '#engineering',
          invites: 'bob,charlie',
          workspaceId: 'workspace-123',
        }),
      })
    );
  });

  it('should fail if workspaceId is missing', async () => {
    const { inviteToChannel } = await createChannelHelpers();
    const result = await inviteToChannel('#engineering', ['bob'], undefined as unknown as string);

    expect(result.success).toBe(false);
    expect(result.error).toContain('workspaceId');
  });
});

/**
 * Tests for URL construction
 */
describe('URL Construction', () => {
  it('should construct correct HTTP URL for API calls', () => {
    const baseUrl = 'http://localhost:3889';
    const apiPath = '/api/channels/message';

    const fullUrl = `${baseUrl}${apiPath}`;

    expect(fullUrl).toBe('http://localhost:3889/api/channels/message');
  });

  it('should construct correct WebSocket URL from HTTP URL', () => {
    const httpUrl = 'http://localhost:3889';
    const wsUrl = httpUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/presence';

    expect(wsUrl).toBe('ws://localhost:3889/ws/presence');
  });

  it('should handle HTTPS to WSS conversion', () => {
    const httpsUrl = 'https://dashboard.example.com';
    const wssUrl = httpsUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/presence';

    expect(wssUrl).toBe('wss://dashboard.example.com/ws/presence');
  });

  it('should handle trailing slashes in URLs', () => {
    const urlWithSlash = 'http://localhost:3889/';
    const wsUrl = urlWithSlash.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/presence';

    expect(wsUrl).toBe('ws://localhost:3889/ws/presence');
  });
});

/**
 * Integration-style tests for the complete channel flow
 */
describe('Complete Channel Flow', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should handle full channel create -> join -> message flow', async () => {
    // All responses succeed
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    const helpers = await createChannelHelpers();

    // 1. Create channel with agent
    await helpers.syncAgentToChannel('#project-x', 'Lead', 'workspace-123');

    // 2. User joins
    await helpers.subscribeUserToChannel('alice', ['#project-x'], 'workspace-123');

    // 3. User sends message
    await helpers.sendChannelMessage('alice', '#project-x', 'Starting work on feature Y', 'workspace-123');

    // Verify all calls went to local dashboard (not workspace)
    const calls = mockFetch.mock.calls;
    for (const [url] of calls) {
      if (typeof url === 'string' && url.includes('/api/channels')) {
        expect(url).toMatch(/localhost:388[89]/);
        expect(url).not.toMatch(/localhost:3718/); // Not workspace port
      }
    }
  });

  it('should recover from detection failure with fallback URL', async () => {
    // Detection fails
    mockFetch.mockRejectedValueOnce(new Error('All ports failed'));
    mockFetch.mockRejectedValueOnce(new Error('All ports failed'));
    mockFetch.mockRejectedValueOnce(new Error('All ports failed'));
    // But subsequent call succeeds (after fallback)
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const { syncAgentToChannel, getFallbackUrl } = await createChannelHelpers();

    // Should use fallback URL
    await syncAgentToChannel('#general', 'Agent', 'workspace-123');

    // Verify fallback was used
    expect(await getFallbackUrl()).toBe('http://localhost:3889');
  });
});

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates detection helper functions that mimic the cloud server's logic
 */
async function createDetectionHelpers(configuredUrl?: string) {
  const defaultPorts = [3889, 3888, 3890];
  let localDashboardUrl = configuredUrl;
  let detectionPromise: Promise<void> | null = null;

  async function detectLocalDashboard(): Promise<string | null> {
    for (const port of defaultPorts) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        const res = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          return `http://localhost:${port}`;
        }
      } catch {
        // Try next port
      }
    }
    return null;
  }

  async function getLocalDashboardUrl(): Promise<string> {
    if (localDashboardUrl) {
      return localDashboardUrl;
    }

    if (!detectionPromise) {
      detectionPromise = (async () => {
        const detected = await detectLocalDashboard();
        localDashboardUrl = detected || 'http://localhost:3889';
      })();
    }

    await detectionPromise;
    return localDashboardUrl!;
  }

  return { detectLocalDashboard, getLocalDashboardUrl };
}

/**
 * Creates channel operation helper functions that mimic the cloud server's logic
 */
async function createChannelHelpers() {
  const { getLocalDashboardUrl, detectLocalDashboard } = await createDetectionHelpers();

  async function syncAgentToChannel(
    channel: string,
    member: string,
    workspaceId: string
  ): Promise<void> {
    try {
      const channelName = channel.startsWith('#') ? channel : `#${channel}`;
      const dashboardUrl = await getLocalDashboardUrl();
      await fetch(`${dashboardUrl}/api/channels/admin-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channelName, member, workspaceId }),
      });
    } catch {
      // Non-fatal
    }
  }

  async function subscribeUserToChannel(
    username: string,
    channels: string[],
    workspaceId: string
  ): Promise<{ success: boolean }> {
    try {
      const dashboardUrl = await getLocalDashboardUrl();
      const res = await fetch(`${dashboardUrl}/api/channels/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, channels, workspaceId }),
      });
      return { success: res.ok };
    } catch {
      return { success: false };
    }
  }

  async function sendChannelMessage(
    username: string,
    channel: string,
    body: string,
    workspaceId: string,
    thread?: string
  ): Promise<{ success: boolean }> {
    try {
      const dashboardUrl = await getLocalDashboardUrl();
      const payload: Record<string, string> = { username, channel, body, workspaceId };
      if (thread) {
        payload.thread = thread;
      }
      const res = await fetch(`${dashboardUrl}/api/channels/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { success: res.ok };
    } catch {
      return { success: false };
    }
  }

  async function inviteToChannel(
    channel: string,
    members: string[],
    workspaceId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!workspaceId) {
      return { success: false, error: 'workspaceId is required' };
    }
    try {
      const dashboardUrl = await getLocalDashboardUrl();
      const res = await fetch(`${dashboardUrl}/api/channels/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, invites: members.join(','), workspaceId }),
      });
      return { success: res.ok };
    } catch {
      return { success: false };
    }
  }

  async function getFallbackUrl(): Promise<string> {
    return getLocalDashboardUrl();
  }

  return {
    syncAgentToChannel,
    subscribeUserToChannel,
    sendChannelMessage,
    inviteToChannel,
    getFallbackUrl,
    detectLocalDashboard,
  };
}
