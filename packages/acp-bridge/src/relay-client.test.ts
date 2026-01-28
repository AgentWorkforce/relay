/**
 * Tests for RelayClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock net module
vi.mock('node:net', () => ({
  default: {
    createConnection: vi.fn(),
  },
}));

import net from 'node:net';
import { RelayClient } from './relay-client.js';

const PROTOCOL_VERSION = 1;

describe('RelayClient', () => {
  let mockSocket: EventEmitter & { write: ReturnType<typeof vi.fn>; destroyed: boolean; end: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSocket = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroyed: false,
      end: vi.fn(),
    });
    vi.mocked(net.createConnection).mockReturnValue(mockSocket as unknown as net.Socket);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a client with config', () => {
      const client = new RelayClient({
        agentName: 'test-agent',
        socketPath: '/tmp/test.sock',
      });
      expect(client).toBeInstanceOf(RelayClient);
    });
  });

  describe('connect', () => {
    it('should connect to the socket and send HELLO', async () => {
      const client = new RelayClient({
        agentName: 'test-agent',
        socketPath: '/tmp/test.sock',
      });

      // Start connection
      const connectPromise = client.connect();

      // Simulate socket connection
      mockSocket.emit('connect');

      // Check HELLO was sent
      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0] as Buffer;
      const length = sentData.readUInt32BE(0);
      const json = sentData.subarray(4, 4 + length).toString('utf8');
      const envelope = JSON.parse(json);

      expect(envelope.type).toBe('HELLO');
      expect(envelope.payload.agent).toBe('test-agent');
      expect(envelope.v).toBe(PROTOCOL_VERSION);

      // Simulate WELCOME response
      const welcomeEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'WELCOME',
        id: 'welcome-1',
        ts: Date.now(),
        payload: {
          session_id: 'session-123',
          server: {
            max_frame_bytes: 1048576,
            heartbeat_ms: 5000,
          },
        },
      };
      const welcomeJson = JSON.stringify(welcomeEnvelope);
      const welcomeFrame = Buffer.alloc(4 + welcomeJson.length);
      welcomeFrame.writeUInt32BE(welcomeJson.length, 0);
      welcomeFrame.write(welcomeJson, 4);

      mockSocket.emit('data', welcomeFrame);

      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });

    it('should reject on connection error', async () => {
      const client = new RelayClient({
        agentName: 'test-agent',
        socketPath: '/tmp/test.sock',
      });

      const connectPromise = client.connect();

      mockSocket.emit('error', new Error('Connection refused'));

      await expect(connectPromise).rejects.toThrow('Connection refused');
    });
  });

  describe('send', () => {
    it('should send a message to another agent', async () => {
      const client = new RelayClient({
        agentName: 'sender',
        socketPath: '/tmp/test.sock',
      });

      // Connect first
      const connectPromise = client.connect();
      mockSocket.emit('connect');

      // Clear HELLO call
      mockSocket.write.mockClear();

      // Send WELCOME
      const welcomeEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'WELCOME',
        id: 'welcome-1',
        ts: Date.now(),
        payload: { session_id: 'session-123', server: { max_frame_bytes: 1048576, heartbeat_ms: 5000 } },
      };
      const welcomeJson = JSON.stringify(welcomeEnvelope);
      const welcomeFrame = Buffer.alloc(4 + welcomeJson.length);
      welcomeFrame.writeUInt32BE(welcomeJson.length, 0);
      welcomeFrame.write(welcomeJson, 4);
      mockSocket.emit('data', welcomeFrame);

      await connectPromise;

      // Send a message
      const msgId = await client.send('receiver', 'Hello!');

      expect(msgId).toBeDefined();
      expect(mockSocket.write).toHaveBeenCalled();

      const sentData = mockSocket.write.mock.calls[0][0] as Buffer;
      const length = sentData.readUInt32BE(0);
      const json = sentData.subarray(4, 4 + length).toString('utf8');
      const envelope = JSON.parse(json);

      expect(envelope.type).toBe('SEND');
      expect(envelope.to).toBe('receiver');
      expect(envelope.payload.body).toBe('Hello!');
    });
  });

  describe('disconnect', () => {
    it('should send BYE and close socket', async () => {
      const client = new RelayClient({
        agentName: 'test-agent',
        socketPath: '/tmp/test.sock',
      });

      // Connect first
      const connectPromise = client.connect();
      mockSocket.emit('connect');

      const welcomeEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'WELCOME',
        id: 'welcome-1',
        ts: Date.now(),
        payload: { session_id: 'session-123', server: { max_frame_bytes: 1048576, heartbeat_ms: 5000 } },
      };
      const welcomeJson = JSON.stringify(welcomeEnvelope);
      const welcomeFrame = Buffer.alloc(4 + welcomeJson.length);
      welcomeFrame.writeUInt32BE(welcomeJson.length, 0);
      welcomeFrame.write(welcomeJson, 4);
      mockSocket.emit('data', welcomeFrame);

      await connectPromise;

      mockSocket.write.mockClear();
      client.disconnect();

      // Check BYE was sent
      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0] as Buffer;
      const length = sentData.readUInt32BE(0);
      const json = sentData.subarray(4, 4 + length).toString('utf8');
      const envelope = JSON.parse(json);

      expect(envelope.type).toBe('BYE');
      expect(mockSocket.end).toHaveBeenCalled();
    });
  });
});
