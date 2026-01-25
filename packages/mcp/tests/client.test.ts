import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRelayClient } from '../src/client.js';
import { createConnection } from 'node:net';

// Mock node:net
vi.mock('node:net', () => ({
  createConnection: vi.fn(),
}));

/**
 * Encode a response envelope into a length-prefixed frame (matches client protocol).
 * Format: 4-byte big-endian length + JSON payload
 */
function encodeFrame(envelope: Record<string, unknown>): Buffer {
  const json = JSON.stringify(envelope);
  const data = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, data]);
}

/**
 * Decode a length-prefixed frame buffer to extract the JSON envelope.
 */
function decodeFrame(buffer: Buffer): Record<string, unknown> {
  const frameLength = buffer.readUInt32BE(0);
  const payload = buffer.subarray(4, 4 + frameLength);
  return JSON.parse(payload.toString('utf-8'));
}

describe('RelayClient', () => {
  let mockSocket: any;
  let client: any;

  beforeEach(() => {
    mockSocket = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.mocked(createConnection).mockReturnValue(mockSocket);

    // Setup socket event handlers
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') {
        // Auto-connect for tests
        setTimeout(cb, 0);
      }
      return mockSocket;
    });

    client = createRelayClient({
      agentName: 'test-agent',
      socketPath: '/tmp/test.sock',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends a message', async () => {
    // send() uses fireAndForget - no response expected, just connect and write
    await client.send('Alice', 'Hello');

    expect(createConnection).toHaveBeenCalledWith('/tmp/test.sock');
    const writeCall = mockSocket.write.mock.calls[0][0];
    const req = decodeFrame(writeCall);
    expect(req.type).toBe('SEND');
    // from/to are at envelope level, kind/body in payload
    expect(req.from).toBe('test-agent');
    expect(req.to).toBe('Alice');
    expect(req.payload).toEqual({
      kind: 'message',
      body: 'Hello',
    });
  });

  it('gets inbox', async () => {
    const mockMessages = [
      { id: '1', from: 'Alice', body: 'Hi' }
    ];

    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);

          // Response payload has 'messages' array (as expected by client)
          const response = {
            id: req.id,
            payload: { messages: mockMessages },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const inbox = await client.getInbox();

    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual({
      id: '1',
      from: 'Alice',
      content: 'Hi',
    });

    const req = decodeFrame(mockSocket.write.mock.calls[0][0]);
    expect(req.type).toBe('INBOX');
  });

  it('handles spawn errors', async () => {
    // spawn() uses fireAndForget, so errors come from connection failures
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'error') {
        // Simulate connection refused error
        setTimeout(() => {
          const err = new Error('Connection refused') as NodeJS.ErrnoException;
          err.code = 'ECONNREFUSED';
          cb(err);
        }, 10);
      }
      return mockSocket;
    });

    const result = await client.spawn({
      name: 'Worker',
      cli: 'claude',
      task: 'task',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot connect to daemon');
  });
});
