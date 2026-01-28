import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRelayClient } from '../src/client.js';
import { createConnection } from 'node:net';

// Mock node:net - this needs to be applied before any module imports it
// Using automock: false ensures we can control the mock behavior
vi.mock('node:net', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('node:net')>()),
    createConnection: vi.fn(),
  };
});

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

/**
 * Generate a test ID for responses
 */
function generateId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

  it('sends message with thread', async () => {
    await client.send('Worker', 'Continue', { thread: 'task-123' });

    const writeCall = mockSocket.write.mock.calls[0][0];
    const req = decodeFrame(writeCall);
    expect(req.payload).toEqual({
      kind: 'message',
      body: 'Continue',
      thread: 'task-123',
    });
  });

  it('spawns worker with all options', async () => {
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);
          const response = {
            type: 'SPAWN_RESULT',
            id: generateId(),
            payload: {
              replyTo: req.id,
              success: true,
              name: 'TestWorker',
              pid: 12345,
            },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const result = await client.spawn({
      name: 'TestWorker',
      cli: 'claude',
      task: 'Test task',
      model: 'claude-3-opus',
      cwd: '/tmp/project',
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe('TestWorker');
    expect(result.pid).toBe(12345);

    const writeCall = mockSocket.write.mock.calls[0][0];
    const req = decodeFrame(writeCall);
    expect(req.type).toBe('SPAWN');
    expect(req.payload).toMatchObject({
      name: 'TestWorker',
      cli: 'claude',
      task: 'Test task',
      model: 'claude-3-opus',
      cwd: '/tmp/project',
      spawnerName: 'test-agent',
    });
  });

  it('lists agents', async () => {
    const mockAgents = [
      { name: 'Orchestrator', cli: 'sdk', idle: false },
      { name: 'Worker1', cli: 'claude', idle: false, parent: 'Orchestrator' },
      { name: 'Worker2', cli: 'claude', idle: true, parent: 'Orchestrator' },
    ];

    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);
          const response = {
            id: req.id,
            payload: { agents: mockAgents },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const agents = await client.listAgents({ include_idle: true });

    expect(agents).toHaveLength(3);
    expect(agents[0].name).toBe('Orchestrator');
    expect(agents[1].parent).toBe('Orchestrator');
    expect(agents[2].idle).toBe(true);

    const req = decodeFrame(mockSocket.write.mock.calls[0][0]);
    expect(req.type).toBe('LIST_AGENTS');
    expect(req.payload).toMatchObject({ includeIdle: true });
  });

  it('releases worker', async () => {
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);
          const response = {
            id: req.id,
            payload: { success: true },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const result = await client.release('Worker1', 'task completed');

    expect(result.success).toBe(true);

    const req = decodeFrame(mockSocket.write.mock.calls[0][0]);
    expect(req.type).toBe('RELEASE');
    expect(req.payload).toMatchObject({
      name: 'Worker1',
      reason: 'task completed',
    });
  });

  it('handles release of non-existent worker', async () => {
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);
          const response = {
            id: req.id,
            payload: { success: false, error: 'Agent not found' },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const result = await client.release('NonExistent');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent not found');
  });

  it('gets status', async () => {
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);
          const response = {
            id: req.id,
            payload: { version: '1.0.0', uptime: 3600000 },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const status = await client.getStatus();

    expect(status.connected).toBe(true);
    expect(status.agentName).toBe('test-agent');
    expect(status.daemonVersion).toBe('1.0.0');
    expect(status.uptime).toBe('3600s');
  });

  it('handles ENOENT error (socket not found)', async () => {
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'error') {
        setTimeout(() => {
          const err = new Error('Socket not found') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
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

// ============================================================================
// Multi-Agent Client Scenarios (SDK parity)
// ============================================================================

describe('RelayClient multi-agent scenarios', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.mocked(createConnection).mockReturnValue(mockSocket);

    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') {
        setTimeout(cb, 0);
      }
      return mockSocket;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns multiple workers from same orchestrator', async () => {
    const client = createRelayClient({
      agentName: 'orchestrator',
      socketPath: '/tmp/test.sock',
    });

    let callCount = 0;
    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[callCount][0];
          const req = decodeFrame(writeCall);
          const response = {
            type: 'SPAWN_RESULT',
            id: generateId(),
            payload: {
              replyTo: req.id,
              success: true,
              name: (req.payload as any).name,
              pid: 10000 + callCount,
            },
          };
          callCount++;
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    // Spawn Worker1
    await client.spawn({ name: 'Worker1', cli: 'claude', task: 'Task 1' });

    // Spawn Worker2
    await client.spawn({ name: 'Worker2', cli: 'claude', task: 'Task 2' });

    // Spawn Worker3
    await client.spawn({ name: 'Worker3', cli: 'codex', task: 'Task 3' });

    expect(mockSocket.write).toHaveBeenCalledTimes(3);

    // Verify each spawn has correct spawnerName
    for (let i = 0; i < 3; i++) {
      const req = decodeFrame(mockSocket.write.mock.calls[i][0]);
      expect(req.type).toBe('SPAWN');
      expect((req.payload as any).spawnerName).toBe('orchestrator');
    }
  });

  it('sends messages to multiple agents', async () => {
    const client = createRelayClient({
      agentName: 'coordinator',
      socketPath: '/tmp/test.sock',
    });

    const targets = ['Alice', 'Bob', 'Charlie'];
    for (const target of targets) {
      await client.send(target, `Hello ${target}`);
    }

    expect(mockSocket.write).toHaveBeenCalledTimes(3);

    // Verify each message has correct target
    const reqs = mockSocket.write.mock.calls.map((call: any) => decodeFrame(call[0]));
    expect(reqs[0].to).toBe('Alice');
    expect(reqs[1].to).toBe('Bob');
    expect(reqs[2].to).toBe('Charlie');
  });

  it('handles inbox with multiple senders', async () => {
    const mockMessages = [
      { id: '1', from: 'Alice', body: 'Hello from Alice' },
      { id: '2', from: 'Bob', body: 'Hello from Bob' },
      { id: '3', from: 'Charlie', body: 'Hello from Charlie' },
    ];

    mockSocket.on.mockImplementation((event: string, cb: any) => {
      if (event === 'connect') cb();
      if (event === 'data') {
        setTimeout(() => {
          const writeCall = mockSocket.write.mock.calls[0][0];
          const req = decodeFrame(writeCall);
          const response = {
            id: req.id,
            payload: { messages: mockMessages },
          };
          cb(encodeFrame(response));
        }, 10);
      }
      return mockSocket;
    });

    const client = createRelayClient({
      agentName: 'coordinator',
      socketPath: '/tmp/test.sock',
    });

    const inbox = await client.getInbox();

    expect(inbox).toHaveLength(3);
    expect(inbox.map(m => m.from)).toEqual(['Alice', 'Bob', 'Charlie']);
  });
});
