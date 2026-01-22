import { describe, it, expect, vi } from 'vitest';
import {
  getAgentsResource,
  getInboxResource,
  getProjectResource,
} from '../src/resources/index.js';

describe('Resources', () => {
  const mockClient = {
    listAgents: vi.fn(),
    getInbox: vi.fn(),
    getStatus: vi.fn(),
  };

  it('getAgentsResource returns formatted JSON', async () => {
    const mockAgents = [{ name: 'Alice', cli: 'claude' }];
    mockClient.listAgents.mockResolvedValue(mockAgents);

    const result = await getAgentsResource(mockClient as any);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(mockAgents);
    expect(mockClient.listAgents).toHaveBeenCalledWith({ include_idle: true });
  });

  it('getInboxResource returns formatted JSON', async () => {
    const mockMessages = [{ id: '1', content: 'hello' }];
    mockClient.getInbox.mockResolvedValue(mockMessages);

    const result = await getInboxResource(mockClient as any);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(mockMessages);
    expect(mockClient.getInbox).toHaveBeenCalledWith({ unread_only: true, limit: 50 });
  });

  it('getProjectResource returns formatted JSON', async () => {
    mockClient.getStatus.mockResolvedValue({
      project: 'test-proj',
      socketPath: '/tmp/sock',
      daemonVersion: '0.1.0',
    });

    const result = await getProjectResource(mockClient as any);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      project: 'test-proj',
      socketPath: '/tmp/sock',
      daemonVersion: '0.1.0',
    });
  });
});
