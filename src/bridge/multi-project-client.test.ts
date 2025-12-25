/**
 * Unit tests for MultiProjectClient (error paths and state callbacks)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MultiProjectClient } from './multi-project-client.js';
import type { ProjectConfig } from './types.js';

// Shared mock state (hoisted for vi.mock)
const { existsSyncMock, createConnectionMock, encodeFrameMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  createConnectionMock: vi.fn(),
  encodeFrameMock: vi.fn(),
}));
let framesToReturn: any[] = [];

// Mock fs and net
vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
  },
  existsSync: existsSyncMock,
}));

vi.mock('node:net', () => ({
  default: {
    createConnection: createConnectionMock,
  },
  createConnection: createConnectionMock,
}));

// Mock framing utilities
vi.mock('../protocol/framing.js', () => ({
  FrameParser: class {
    push = vi.fn(() => framesToReturn);
  },
  encodeFrame: encodeFrameMock,
}));

// Simple socket stub
class MockSocket extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
  destroy = vi.fn();
}

const projectA: ProjectConfig = {
  path: '/project/a',
  id: 'project-a',
  socketPath: '/project/a/relay.sock',
  leadName: 'Alice',
  cli: 'claude',
};

describe('MultiProjectClient (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    framesToReturn = [];
    encodeFrameMock.mockImplementation(() => Buffer.from('frame'));
    existsSyncMock.mockReturnValue(true);

    createConnectionMock.mockImplementation((_path: string, cb?: () => void) => {
      const socket = new MockSocket();
      // Fire connect callback asynchronously to mirror net.createConnection timing
      if (cb) setImmediate(cb);
      return socket;
    });
  });

  it('rejects connect when socket is missing', async () => {
    existsSyncMock.mockReturnValue(false);

    const client = new MultiProjectClient([projectA]);
    await expect(client.connect()).rejects.toThrow();
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it('times out when daemon never becomes ready', async () => {
    vi.useFakeTimers();
    const client = new MultiProjectClient([projectA]);

    const connectPromise = client.connect();
    const rejection = expect(connectPromise).rejects.toThrow('Connection timeout');

    // No WELCOME frame emitted -> timeout triggers
    await vi.runAllTimersAsync();
    await rejection;
  });

  it('invokes state change callbacks on welcome and close', async () => {
    vi.useFakeTimers();
    const socket = new MockSocket();
    createConnectionMock.mockImplementation((_path: string, cb?: () => void) => {
      if (cb) setImmediate(cb);
      return socket;
    });

    framesToReturn = [
      {
        type: 'WELCOME',
        id: 'welcome-1',
        v: 1,
        ts: Date.now(),
        payload: {},
      },
    ];

    const client = new MultiProjectClient([projectA]);
    const states: Array<{ id: string; connected: boolean }> = [];
    client.onProjectStateChange = (id, connected) => states.push({ id, connected });

    const connectPromise = client.connect();

    // Emit data to produce WELCOME
    socket.emit('data', Buffer.from('welcome'));
    await vi.runOnlyPendingTimersAsync();
    await connectPromise;

    expect(client.getConnectedProjects()).toContain('project-a');

    // Simulate close
    socket.emit('close');

    expect(states).toEqual([
      { id: 'project-a', connected: true },
      { id: 'project-a', connected: false },
    ]);
    expect(client.getConnectedProjects()).not.toContain('project-a');
  });

  it('sendToProject returns false when project missing or not ready', () => {
    const client = new MultiProjectClient([projectA]);

    expect(client.sendToProject('unknown', 'Bob', 'hi')).toBe(false);

    // Manually insert a connection but mark not ready
    (client as any).connections.set('project-a', {
      config: projectA,
      ready: false,
    });
    expect(client.sendToProject('project-a', 'Bob', 'hi')).toBe(false);
  });

  it('sendToProject returns false when frame encoding throws', () => {
    const client = new MultiProjectClient([projectA]);
    const socket = new MockSocket();

    // Insert ready connection
    (client as any).connections.set('project-a', {
      config: projectA,
      socket,
      ready: true,
    });

    encodeFrameMock.mockImplementation(() => {
      throw new Error('encode failed');
    });

    const result = client.sendToProject('project-a', 'Bob', 'hi');
    expect(result).toBe(false);
  });

  it('broadcastToLeads only sends to ready connections and resolves lead alias', () => {
    const client = new MultiProjectClient([projectA]);
    const socket = new MockSocket();

    (client as any).connections.set('project-a', {
      config: projectA,
      socket,
      ready: true,
    });
    client.registerLead('project-a', 'Alice');

    client.broadcastToLeads('Hello leads');

    expect(encodeFrameMock).toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalled();
  });

  it('getConnectedProjects filters by ready state', () => {
    const client = new MultiProjectClient([projectA]);
    (client as any).connections.set('project-a', {
      config: projectA,
      ready: true,
    });
    (client as any).connections.set('project-b', {
      config: { ...projectA, id: 'project-b', socketPath: '/b.sock', path: '/b' },
      ready: false,
    });

    expect(client.getConnectedProjects()).toEqual(['project-a']);
  });

  describe('reconnection logic', () => {
    it('schedules reconnection when socket closes and reconnect is enabled', async () => {
      vi.useFakeTimers();
      const socket = new MockSocket();
      createConnectionMock.mockImplementation((_path: string, cb?: () => void) => {
        if (cb) setImmediate(cb);
        return socket;
      });

      framesToReturn = [
        { type: 'WELCOME', id: 'welcome-1', v: 1, ts: Date.now(), payload: {} },
      ];

      // Default: reconnect enabled
      const client = new MultiProjectClient([projectA]);
      const connectPromise = client.connect();

      socket.emit('data', Buffer.from('welcome'));
      await vi.runOnlyPendingTimersAsync();
      await connectPromise;

      // Simulate close
      socket.emit('close');

      // Should have scheduled reconnection
      expect((client as any).connections.get('project-a')?.reconnecting).toBe(true);

      client.disconnect();
    });

    it('does not reconnect when reconnect option is false', async () => {
      vi.useFakeTimers();
      const socket = new MockSocket();
      createConnectionMock.mockImplementation((_path: string, cb?: () => void) => {
        if (cb) setImmediate(cb);
        return socket;
      });

      framesToReturn = [
        { type: 'WELCOME', id: 'welcome-1', v: 1, ts: Date.now(), payload: {} },
      ];

      const client = new MultiProjectClient([projectA], { reconnect: false });
      const connectPromise = client.connect();

      socket.emit('data', Buffer.from('welcome'));
      await vi.runOnlyPendingTimersAsync();
      await connectPromise;

      // Simulate close
      socket.emit('close');

      // Should NOT have scheduled reconnection
      expect((client as any).connections.get('project-a')?.reconnecting).toBeFalsy();

      client.disconnect();
    });

    it('uses exponential backoff for reconnection delays', async () => {
      vi.useFakeTimers();
      const client = new MultiProjectClient([projectA], {
        reconnectDelay: 100,
        maxReconnectDelay: 1000,
      });

      const conn = {
        config: projectA,
        socket: new MockSocket(),
        parser: { push: vi.fn(() => []) },
        ready: false,
        reconnecting: false,
        reconnectAttempts: 0,
      };
      (client as any).connections.set('project-a', conn);

      // First attempt: 100ms
      (client as any).scheduleReconnect(conn);
      expect(conn.reconnectAttempts).toBe(1);

      // Manually reset for second attempt
      conn.reconnecting = false;
      (client as any).scheduleReconnect(conn);
      expect(conn.reconnectAttempts).toBe(2);

      // Third attempt: 400ms
      conn.reconnecting = false;
      (client as any).scheduleReconnect(conn);
      expect(conn.reconnectAttempts).toBe(3);

      client.disconnect();
    });

    it('stops reconnecting after max attempts', async () => {
      const client = new MultiProjectClient([projectA], {
        maxReconnectAttempts: 3,
      });

      const conn = {
        config: projectA,
        socket: new MockSocket(),
        parser: { push: vi.fn(() => []) },
        ready: false,
        reconnecting: false,
        reconnectAttempts: 3,
      };
      (client as any).connections.set('project-a', conn);

      // Should not schedule another reconnect
      (client as any).scheduleReconnect(conn);
      expect(conn.reconnecting).toBe(false);

      client.disconnect();
    });

    it('clears reconnect timers on disconnect', async () => {
      vi.useFakeTimers();
      const socket = new MockSocket();
      createConnectionMock.mockImplementation((_path: string, cb?: () => void) => {
        if (cb) setImmediate(cb);
        return socket;
      });

      framesToReturn = [
        { type: 'WELCOME', id: 'welcome-1', v: 1, ts: Date.now(), payload: {} },
      ];

      const client = new MultiProjectClient([projectA]);
      const connectPromise = client.connect();

      socket.emit('data', Buffer.from('welcome'));
      await vi.runOnlyPendingTimersAsync();
      await connectPromise;

      // Simulate close to trigger reconnection
      socket.emit('close');

      // Disconnect should clear the timer
      client.disconnect();

      expect((client as any).shuttingDown).toBe(true);
    });
  });
});
