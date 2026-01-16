/**
 * Tests for RelayPtyOrchestrator
 *
 * Tests the TypeScript orchestrator that manages the relay-pty Rust binary.
 * Uses mocks for child process and socket communication.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';

// Mock modules before importing the class
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:net', () => ({
  createConnection: vi.fn(),
}));

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((path: string) => {
    // Simulate relay-pty binary exists at any relay-pty path
    return typeof path === 'string' && path.includes('relay-pty');
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    default: {
      ...actual,
      existsSync: mockExistsSync,
    },
  };
});

// Mock the client module
vi.mock('./client.js', () => ({
  RelayClient: vi.fn().mockImplementation((options: any) => ({
    name: options.agentName,
    state: 'READY' as string,
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockReturnValue(true),
    sendLog: vi.fn(),
    destroy: vi.fn(),
    onMessage: null,
    onChannelMessage: null,
  })),
}));

// Mock continuity
vi.mock('../continuity/index.js', () => ({
  getContinuityManager: vi.fn(() => null),
  parseContinuityCommand: vi.fn(),
  hasContinuityCommand: vi.fn(() => false),
}));

// Now import after mocks
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { RelayPtyOrchestrator, type RelayPtyOrchestratorConfig } from './relay-pty-orchestrator.js';

/**
 * Create a mock ChildProcess
 */
function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdin = { write: vi.fn() } as any;
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    setTimeout(() => proc.emit('exit', 0, null), 0);
    return true;
  });
  proc.exitCode = null;
  return proc;
}

/**
 * Create a mock Socket
 */
function createMockSocket(): Socket {
  const socket = new EventEmitter() as Socket;
  socket.write = vi.fn((data: any, cb?: any) => {
    if (typeof cb === 'function') cb();
    return true;
  });
  socket.destroy = vi.fn();
  (socket as any).destroyed = false;
  return socket;
}

describe('RelayPtyOrchestrator', () => {
  let orchestrator: RelayPtyOrchestrator;
  let mockProcess: ChildProcess;
  let mockSocket: Socket;
  const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
  const mockCreateConnection = createConnection as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset existsSync mock to default implementation
    mockExistsSync.mockImplementation((path: string) => {
      return typeof path === 'string' && path.includes('relay-pty');
    });

    // Set up mock process
    mockProcess = createMockProcess();
    mockSpawn.mockReturnValue(mockProcess);

    // Set up mock socket
    mockSocket = createMockSocket();
    mockCreateConnection.mockImplementation((_path: string, callback: () => void) => {
      setTimeout(() => callback(), 10);
      return mockSocket;
    });
  });

  afterEach(async () => {
    if (orchestrator?.isRunning) {
      await orchestrator.stop();
    }
  });

  describe('constructor', () => {
    it('sets socket path based on agent name', () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      expect(orchestrator.getSocketPath()).toBe('/tmp/relay-pty-TestAgent.sock');
    });
  });

  describe('binary detection', () => {
    it('finds binary at release path', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      expect(mockSpawn).toHaveBeenCalled();
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[0]).toContain('relay-pty');
    });

    it('uses custom binary path if provided', async () => {
      // Update mock to accept custom path
      mockExistsSync.mockImplementation((path: string) => {
        return path === '/custom/path/relay-pty' || (typeof path === 'string' && path.includes('relay-pty'));
      });

      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
        relayPtyPath: '/custom/path/relay-pty',
      });

      await orchestrator.start();

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[0]).toBe('/custom/path/relay-pty');

      // Reset mock
      mockExistsSync.mockImplementation((path: string) => {
        return typeof path === 'string' && path.includes('relay-pty');
      });
    });
  });

  describe('process management', () => {
    it('spawns relay-pty with correct arguments', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
        args: ['--model', 'opus'],
        idleBeforeInjectMs: 1000,
      });

      await orchestrator.start();

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args).toContain('--name');
      expect(args).toContain('TestAgent');
      expect(args).toContain('--socket');
      expect(args).toContain('/tmp/relay-pty-TestAgent.sock');
      expect(args).toContain('--idle-timeout');
      expect(args).toContain('1000');
      expect(args).toContain('--');
      expect(args).toContain('claude');
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('sets environment variables', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
        env: { CUSTOM_VAR: 'value' },
      });

      await orchestrator.start();

      const spawnCall = mockSpawn.mock.calls[0];
      const options = spawnCall[2];

      expect(options.env.AGENT_RELAY_NAME).toBe('TestAgent');
      expect(options.env.TERM).toBe('xterm-256color');
      expect(options.env.CUSTOM_VAR).toBe('value');
    });

    it('emits exit event when process exits', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      const exitHandler = vi.fn();
      orchestrator.on('exit', exitHandler);

      await orchestrator.start();

      // Simulate process exit
      mockProcess.emit('exit', 0, null);

      expect(exitHandler).toHaveBeenCalledWith(0);
    });

    it('calls onExit callback', async () => {
      const onExit = vi.fn();
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
        onExit,
      });

      await orchestrator.start();
      mockProcess.emit('exit', 1, null);

      expect(onExit).toHaveBeenCalledWith(1);
    });
  });

  describe('socket communication', () => {
    it('connects to socket after spawn', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      expect(mockCreateConnection).toHaveBeenCalledWith(
        '/tmp/relay-pty-TestAgent.sock',
        expect.any(Function)
      );
    });

    it('retries socket connection on failure', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
        socketConnectTimeoutMs: 100,
        socketReconnectAttempts: 3,
      });

      // First two attempts fail, third succeeds
      let attempts = 0;
      mockCreateConnection.mockImplementation((_path: string, callback: () => void) => {
        const sock = createMockSocket();
        attempts++;
        if (attempts < 3) {
          setTimeout(() => sock.emit('error', new Error('Connection refused')), 10);
        } else {
          setTimeout(() => callback(), 10);
        }
        return sock;
      });

      await orchestrator.start();

      expect(mockCreateConnection).toHaveBeenCalledTimes(3);
    });

    it('handles socket close', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();
      mockSocket.emit('close');

      // Socket should be marked as disconnected
      // (Internal state, verified by inability to inject)
    });
  });

  describe('output handling', () => {
    it('emits output event for stdout data', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      const outputHandler = vi.fn();
      orchestrator.on('output', outputHandler);

      await orchestrator.start();
      mockProcess.stdout!.emit('data', Buffer.from('Hello from agent'));

      expect(outputHandler).toHaveBeenCalledWith('Hello from agent');
    });

    it('accumulates raw output buffer', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();
      mockProcess.stdout!.emit('data', Buffer.from('Line 1\n'));
      mockProcess.stdout!.emit('data', Buffer.from('Line 2\n'));

      expect(orchestrator.getRawOutput()).toContain('Line 1');
      expect(orchestrator.getRawOutput()).toContain('Line 2');
    });

    it('parses relay commands from output', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Access the client mock to verify sendMessage calls
      const client = (orchestrator as any).client;

      // Emit output containing a relay command
      mockProcess.stdout!.emit('data', Buffer.from('->relay:Bob Hello Bob!\n'));

      // Allow async parsing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(client.sendMessage).toHaveBeenCalled();
    });
  });

  describe('message injection', () => {
    it('processes queued messages when ready', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Trigger message handler (normally done by RelayClient)
      const handler = (orchestrator as any).handleIncomingMessage.bind(orchestrator);
      handler('Sender', { body: 'Test message', kind: 'message' }, 'msg-123');

      // Allow async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify socket write was called with inject request
      expect(mockSocket.write).toHaveBeenCalled();
      const writeCall = (mockSocket.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(writeCall).toContain('"type":"inject"');
      expect(writeCall).toContain('msg-123');
    });

    it('handles inject_result responses', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Trigger a message to inject
      const handler = (orchestrator as any).handleIncomingMessage.bind(orchestrator);
      handler('Sender', { body: 'Test message', kind: 'message' }, 'msg-456');

      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate successful delivery response
      mockSocket.emit('data', Buffer.from(JSON.stringify({
        type: 'inject_result',
        id: 'msg-456',
        status: 'delivered',
        timestamp: Date.now(),
      }) + '\n'));

      await new Promise(resolve => setTimeout(resolve, 50));

      // Check metrics
      const metrics = orchestrator.getInjectionMetrics();
      expect(metrics.total).toBeGreaterThan(0);
    });

    it('handles backpressure', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      const backpressureHandler = vi.fn();
      orchestrator.on('backpressure', backpressureHandler);

      await orchestrator.start();

      // Simulate backpressure response
      mockSocket.emit('data', Buffer.from(JSON.stringify({
        type: 'backpressure',
        queue_length: 50,
        accept: false,
      }) + '\n'));

      expect(backpressureHandler).toHaveBeenCalledWith({
        queueLength: 50,
        accept: false,
      });
      expect(orchestrator.isBackpressureActive()).toBe(true);

      // Clear backpressure
      mockSocket.emit('data', Buffer.from(JSON.stringify({
        type: 'backpressure',
        queue_length: 5,
        accept: true,
      }) + '\n'));

      expect(orchestrator.isBackpressureActive()).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('tracks running state', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      expect(orchestrator.isRunning).toBe(false);

      await orchestrator.start();
      expect(orchestrator.isRunning).toBe(true);

      await orchestrator.stop();
      expect(orchestrator.isRunning).toBe(false);
    });

    it('sends shutdown command on stop', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();
      await orchestrator.stop();

      // Verify shutdown request was sent
      const writeCalls = (mockSocket.write as ReturnType<typeof vi.fn>).mock.calls;
      const shutdownCall = writeCalls.find((call: any[]) =>
        call[0].includes('"type":"shutdown"')
      );
      expect(shutdownCall).toBeDefined();
    });

    it('kills process on stop', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Simulate process not exiting gracefully
      const stopPromise = orchestrator.stop();

      // Emit exit after kill
      setTimeout(() => mockProcess.emit('exit', 0, null), 100);

      await stopPromise;

      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('returns PID', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      expect(orchestrator.pid).toBe(12345);
    });
  });

  describe('summary and session end detection', () => {
    it('emits summary event', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      const summaryHandler = vi.fn();
      orchestrator.on('summary', summaryHandler);

      await orchestrator.start();

      // Emit output with summary block
      mockProcess.stdout!.emit('data', Buffer.from(
        '[[SUMMARY]]{"currentTask": "Test task", "completedTasks": ["Task 1"]}[[/SUMMARY]]'
      ));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(summaryHandler).toHaveBeenCalled();
      expect(summaryHandler.mock.calls[0][0].agentName).toBe('TestAgent');
    });

    it('emits session-end event', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      const sessionEndHandler = vi.fn();
      orchestrator.on('session-end', sessionEndHandler);

      await orchestrator.start();

      // Emit output with session end
      mockProcess.stdout!.emit('data', Buffer.from(
        '[[SESSION_END]]Work complete.[[/SESSION_END]]'
      ));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(sessionEndHandler).toHaveBeenCalled();
      expect(sessionEndHandler.mock.calls[0][0].agentName).toBe('TestAgent');
    });
  });
});

describe('RelayPtyOrchestrator integration', () => {
  // Integration tests would require the actual relay-pty binary
  // These are placeholder tests that would be run with:
  // npm test -- --testNamePattern="integration" --runInBand

  it.skip('spawns real relay-pty with echo', async () => {
    // This test requires the relay-pty binary to be built
    const orchestrator = new RelayPtyOrchestrator({
      name: 'IntegrationTest',
      command: 'cat', // Simple command that echoes input
    });

    await orchestrator.start();

    // Inject a message
    // ... verify it appears in output

    await orchestrator.stop();
  });
});
