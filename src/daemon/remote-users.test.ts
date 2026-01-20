/**
 * Tests for remote users functionality
 *
 * Remote users are humans connected via the cloud dashboard.
 * The daemon writes them to remote-users.json so the dashboard-server
 * can check if a user is online when routing DM messages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Daemon } from './server.js';

describe('Remote Users File', () => {
  let daemon: Daemon;
  let testTeamDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use actual temp directory for tests
    testTeamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-users-test-'));
    daemon = new Daemon({
      socketPath: path.join(testTeamDir, 'agent-relay-test.sock'),
      pidFilePath: path.join(testTeamDir, 'agent-relay-test.sock.pid'),
      teamDir: testTeamDir,
    });
  });

  afterEach(() => {
    daemon.stop();
    // Clean up temp directory
    try {
      fs.rmSync(testTeamDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('writeRemoteUsersFile', () => {
    it('should write remote users to remote-users.json', () => {
      const remoteUsers = [
        { name: 'alice', daemonId: 'cloud', status: 'online' },
        { name: 'bob', daemonId: 'cloud', status: 'online' },
      ];

      // Set remote users via the private property
      (daemon as any).remoteUsers = remoteUsers;

      // Call the private method
      (daemon as any).writeRemoteUsersFile();

      // Verify file was created
      const filePath = path.join(testTeamDir, 'remote-users.json');
      expect(fs.existsSync(filePath)).toBe(true);

      // Parse the written data
      const writtenData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(writtenData.users).toEqual(remoteUsers);
      expect(writtenData.updatedAt).toBeDefined();
      expect(typeof writtenData.updatedAt).toBe('number');
    });

    it('should include updatedAt timestamp for staleness check', () => {
      const before = Date.now();
      (daemon as any).remoteUsers = [];
      (daemon as any).writeRemoteUsersFile();
      const after = Date.now();

      const filePath = path.join(testTeamDir, 'remote-users.json');
      const writtenData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      expect(writtenData.updatedAt).toBeGreaterThanOrEqual(before);
      expect(writtenData.updatedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('isRemoteUser', () => {
    it('should return the user object for users in remoteUsers array', () => {
      const alice = { name: 'alice', daemonId: 'cloud', status: 'online' };
      const bob = { name: 'bob', daemonId: 'cloud', status: 'online' };
      (daemon as any).remoteUsers = [alice, bob];

      expect(daemon.isRemoteUser('alice')).toEqual(alice);
      expect(daemon.isRemoteUser('bob')).toEqual(bob);
    });

    it('should return undefined for users not in remoteUsers array', () => {
      (daemon as any).remoteUsers = [
        { name: 'alice', daemonId: 'cloud', status: 'online' },
      ];

      expect(daemon.isRemoteUser('charlie')).toBeUndefined();
      expect(daemon.isRemoteUser('unknown')).toBeUndefined();
    });

    it('should return undefined when remoteUsers is empty', () => {
      (daemon as any).remoteUsers = [];
      expect(daemon.isRemoteUser('anyone')).toBeUndefined();
    });
  });
});

describe('Remote Users Integration with CloudSync', () => {
  it('should emit remote-users-updated with user list', async () => {
    // This tests that the CloudSync service emits the correct event
    // which triggers writeRemoteUsersFile in the daemon
    const { CloudSyncService } = await import('./cloud-sync.js');

    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Mock successful connection and sync response with users
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
      json: async () => ({
        allAgents: [],
        allUsers: [
          { name: 'human-user-1', daemonId: 'cloud', status: 'online' },
          { name: 'human-user-2', daemonId: 'cloud', status: 'online' },
        ],
      }),
    });

    const service = new CloudSyncService({
      apiKey: 'test-key',
      cloudUrl: 'https://test.api.com',
    });

    const usersUpdatedHandler = vi.fn();
    service.on('remote-users-updated', usersUpdatedHandler);

    await service.start();

    // Wait for sync to process
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify the event was emitted with user data
    expect(usersUpdatedHandler).toHaveBeenCalled();
    const emittedUsers = usersUpdatedHandler.mock.calls[0][0];
    expect(emittedUsers).toHaveLength(2);
    expect(emittedUsers[0].name).toBe('human-user-1');
    expect(emittedUsers[1].name).toBe('human-user-2');

    service.stop();
  });
});
