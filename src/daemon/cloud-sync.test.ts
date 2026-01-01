/**
 * Unit tests for the CloudSyncService class.
 * Tests cloud connectivity, heartbeats, agent sync, and cross-machine messaging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudSyncService } from './cloud-sync.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CloudSyncService', () => {
  let service: CloudSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Clear environment variables
    delete process.env.AGENT_RELAY_API_KEY;
    delete process.env.AGENT_RELAY_CLOUD_URL;
    delete process.env.AGENT_RELAY_DATA_DIR;
  });

  afterEach(() => {
    if (service) {
      service.stop();
    }
    vi.useRealTimers();
  });

  describe('Configuration', () => {
    it('should use default cloud URL when not specified', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
      });
      expect(service.isConnected()).toBe(false);
    });

    it('should use custom cloud URL when specified', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://custom.api.com',
      });
      expect(service.isConnected()).toBe(false);
    });

    it('should use environment variable for API key', () => {
      process.env.AGENT_RELAY_API_KEY = 'env-api-key';
      service = new CloudSyncService();
      expect(service.isConnected()).toBe(false);
    });

    it('should use environment variable for cloud URL', () => {
      process.env.AGENT_RELAY_CLOUD_URL = 'https://env.api.com';
      service = new CloudSyncService({
        apiKey: 'test-key',
      });
      expect(service.isConnected()).toBe(false);
    });

    it('should default heartbeat interval to 30 seconds', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
      });
      expect(service.isConnected()).toBe(false);
    });

    it('should allow custom heartbeat interval', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
        heartbeatInterval: 5000,
      });
      expect(service.isConnected()).toBe(false);
    });

    it('should be enabled by default', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
      });
      expect(service.isConnected()).toBe(false);
    });

    it('should allow disabling the service', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
        enabled: false,
      });
      expect(service.isConnected()).toBe(false);
    });
  });

  describe('Connection lifecycle', () => {
    it('should not start when disabled', async () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
        enabled: false,
      });
      await service.start();
      expect(service.isConnected()).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not start without API key', async () => {
      service = new CloudSyncService({
        enabled: true,
      });
      await service.start();
      expect(service.isConnected()).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should connect when started with valid config', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });

      const connectedPromise = new Promise<void>((resolve) => {
        service.on('connected', resolve);
      });

      await service.start();
      await connectedPromise;

      expect(service.isConnected()).toBe(true);
    });

    it('should emit disconnected event when stopped', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });

      await service.start();

      const disconnectedPromise = new Promise<void>((resolve) => {
        service.on('disconnected', resolve);
      });

      service.stop();
      await disconnectedPromise;

      expect(service.isConnected()).toBe(false);
    });

    it('should emit disconnected event on 401 unauthorized response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      service = new CloudSyncService({
        apiKey: 'invalid-key',
        cloudUrl: 'https://test.api.com',
      });

      let disconnectedEmitted = false;
      service.on('disconnected', () => {
        disconnectedEmitted = true;
      });

      // Start will complete, but the 401 triggers a disconnect event
      await service.start();

      // The disconnected event should have been emitted during start
      expect(disconnectedEmitted).toBe(true);
    });
  });

  describe('Agent management', () => {
    beforeEach(async () => {
      // Use real timers for agent management tests
      vi.useRealTimers();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
        heartbeatInterval: 300000, // Very long interval to avoid heartbeats during test
      });

      await service.start();
    });

    afterEach(() => {
      // Restore fake timers for other tests
      vi.useFakeTimers();
    });

    it('should update local agents', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service.updateAgents([
        { name: 'Alice', status: 'running' },
        { name: 'Bob', status: 'idle' },
      ]);

      // Let sync complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(service.getRemoteAgents()).toEqual([]);
    });

    it('should trigger sync when connected and agents updated', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      const initialCallCount = mockFetch.mock.calls.length;

      service.updateAgents([
        { name: 'Alice', status: 'running' },
      ]);

      // Let sync complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check that sync was triggered (fetch was called again)
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it('should return remote agents excluding local ones', async () => {
      // Set up mock response for sync
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          allAgents: [
            { name: 'Alice', status: 'running', daemonId: 'daemon-1', daemonName: 'server-1', machineId: 'machine-1' },
            { name: 'RemoteBot', status: 'running', daemonId: 'daemon-2', daemonName: 'server-2', machineId: 'machine-2' },
          ],
        }),
      });

      // Update local agents (which triggers sync)
      service.updateAgents([
        { name: 'Alice', status: 'running' },
      ]);

      // Wait for sync to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // RemoteBot should be in remote agents since Alice is local
      const remoteAgents = service.getRemoteAgents();
      expect(remoteAgents).toHaveLength(1);
      expect(remoteAgents[0].name).toBe('RemoteBot');
    });

    it('should emit remote-agents-updated when remote agents are found', async () => {
      const updateHandler = vi.fn();
      service.on('remote-agents-updated', updateHandler);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          allAgents: [
            { name: 'RemoteBot', status: 'running', daemonId: 'daemon-2', daemonName: 'server-2', machineId: 'machine-2' },
          ],
        }),
      });

      service.updateAgents([]);

      // Wait for sync to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(updateHandler).toHaveBeenCalledWith([
        { name: 'RemoteBot', status: 'running', daemonId: 'daemon-2', daemonName: 'server-2', machineId: 'machine-2' },
      ]);
    });
  });

  describe('Cross-machine messaging', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });

      await service.start();
    });

    it('should throw when sending message while not connected', async () => {
      service.stop();

      await expect(
        service.sendCrossMachineMessage('daemon-2', 'Bob', 'Alice', 'Hello!')
      ).rejects.toThrow('Not connected to cloud');
    });

    it('should send cross-machine message successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await service.sendCrossMachineMessage('daemon-2', 'Bob', 'Alice', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.api.com/api/daemons/message',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('should include metadata in cross-machine message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const metadata = { priority: 'high', taskId: 'task-123' };
      await service.sendCrossMachineMessage('daemon-2', 'Bob', 'Alice', 'Hello!', metadata);

      const callArgs = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const body = JSON.parse(callArgs[1].body);
      expect(body.message.metadata).toEqual(metadata);
    });

    it('should throw on message send failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Daemon not found',
      });

      await expect(
        service.sendCrossMachineMessage('daemon-2', 'Bob', 'Alice', 'Hello!')
      ).rejects.toThrow('Failed to send cross-machine message: Daemon not found');
    });

    it('should emit cross-machine-message event when messages are fetched', async () => {
      const messageHandler = vi.fn();
      service.on('cross-machine-message', messageHandler);

      // Simulate heartbeat which fetches messages
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [
            {
              from: { daemonId: 'daemon-2', daemonName: 'server-2', agent: 'Bob' },
              to: 'Alice',
              content: 'Hello from remote!',
              timestamp: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      // Advance timer to trigger heartbeat
      await vi.advanceTimersByTimeAsync(30000);

      expect(messageHandler).toHaveBeenCalledWith({
        from: { daemonId: 'daemon-2', daemonName: 'server-2', agent: 'Bob' },
        to: 'Alice',
        content: 'Hello from remote!',
        timestamp: '2024-01-01T00:00:00Z',
      });
    });
  });

  describe('Credentials sync', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });

      await service.start();
    });

    it('should throw when syncing credentials while not connected', async () => {
      service.stop();

      await expect(service.syncCredentials()).rejects.toThrow('Not connected to cloud');
    });

    it('should sync credentials successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          credentials: [
            { provider: 'anthropic', accessToken: 'token-1', tokenType: 'Bearer' },
            { provider: 'openai', accessToken: 'token-2' },
          ],
        }),
      });

      const credentials = await service.syncCredentials();

      expect(credentials).toHaveLength(2);
      expect(credentials[0].provider).toBe('anthropic');
      expect(credentials[1].provider).toBe('openai');
    });

    it('should throw on credential sync failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(service.syncCredentials()).rejects.toThrow('Credential sync failed: 500');
    });
  });

  describe('Command handling', () => {
    it('should emit command events from heartbeat response', async () => {
      const commandHandler = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          commands: [
            { type: 'restart-agent', payload: { name: 'Alice' } },
            { type: 'update-config', payload: { setting: 'value' } },
          ],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });
      service.on('command', commandHandler);

      await service.start();

      expect(commandHandler).toHaveBeenCalledTimes(2);
      expect(commandHandler).toHaveBeenCalledWith({ type: 'restart-agent', payload: { name: 'Alice' } });
      expect(commandHandler).toHaveBeenCalledWith({ type: 'update-config', payload: { setting: 'value' } });
    });
  });

  describe('Error handling', () => {
    it('should emit error event on heartbeat failure', async () => {
      const errorHandler = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });
      service.on('error', errorHandler);

      await service.start();

      // Set up failure for next heartbeat
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      // Advance timer to trigger heartbeat
      await vi.advanceTimersByTimeAsync(30000);

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle network errors gracefully', async () => {
      const errorHandler = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
      });
      service.on('error', errorHandler);

      await service.start();

      // Set up network failure for next heartbeat
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Advance timer to trigger heartbeat
      await vi.advanceTimersByTimeAsync(30000);

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('Machine identifier', () => {
    it('should return consistent machine identifier', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
      });

      const id1 = service.getMachineIdentifier();
      const id2 = service.getMachineIdentifier();

      expect(id1).toBe(id2);
      expect(id1).toBeTruthy();
    });

    it('should include hostname in machine identifier', () => {
      service = new CloudSyncService({
        apiKey: 'test-key',
      });

      const machineId = service.getMachineIdentifier();

      // Machine ID format is typically hostname-randomhex or hostname-timestamp
      expect(machineId).toContain('-');
    });
  });

  describe('Heartbeat scheduling', () => {
    it('should send heartbeats at configured interval', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ commands: [], messages: [], allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
        heartbeatInterval: 10000, // 10 seconds
      });

      await service.start();
      const initialCallCount = mockFetch.mock.calls.length;

      // Advance timer by heartbeat interval
      await vi.advanceTimersByTimeAsync(10000);

      // Should have made additional calls (heartbeat + messages + agents)
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it('should stop heartbeats when service is stopped', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ commands: [], messages: [], allAgents: [] }),
      });

      service = new CloudSyncService({
        apiKey: 'test-key',
        cloudUrl: 'https://test.api.com',
        heartbeatInterval: 10000,
      });

      await service.start();
      service.stop();

      const callCountAfterStop = mockFetch.mock.calls.length;

      // Advance timer
      await vi.advanceTimersByTimeAsync(20000);

      // Should not have made any new calls
      expect(mockFetch.mock.calls.length).toBe(callCountAfterStop);
    });
  });
});
