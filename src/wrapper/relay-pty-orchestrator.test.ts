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
import { createHash } from 'node:crypto';

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
import { RelayPtyOrchestrator } from './relay-pty-orchestrator.js';

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

  // Save original WORKSPACE_ID to restore after each test
  let originalWorkspaceId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    // Save and clear WORKSPACE_ID to test legacy paths by default
    // Tests that need workspace namespacing can set it explicitly
    originalWorkspaceId = process.env.WORKSPACE_ID;
    delete process.env.WORKSPACE_ID;

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

    // Restore original WORKSPACE_ID
    if (originalWorkspaceId !== undefined) {
      process.env.WORKSPACE_ID = originalWorkspaceId;
    } else {
      delete process.env.WORKSPACE_ID;
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

    it('uses workspace-namespaced paths when WORKSPACE_ID is in config.env', () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
        env: { WORKSPACE_ID: 'ws-12345' },
      });

      expect(orchestrator.getSocketPath()).toBe('/tmp/relay/ws-12345/sockets/TestAgent.sock');
      expect(orchestrator.outboxPath).toBe('/tmp/relay/ws-12345/outbox/TestAgent');
    });

    it('hashes workspace id when socket path is too long', () => {
      const longWorkspaceId = `ws-${'a'.repeat(140)}`;
      const hashedWorkspaceId = createHash('sha256').update(longWorkspaceId).digest('hex').slice(0, 12);

      orchestrator = new RelayPtyOrchestrator({
        name: 'LongAgent',
        command: 'claude',
        env: { WORKSPACE_ID: longWorkspaceId },
      });

      expect(orchestrator.getSocketPath()).toBe(`/tmp/relay/${hashedWorkspaceId}/sockets/LongAgent.sock`);
      expect(orchestrator.outboxPath).toBe(`/tmp/relay/${hashedWorkspaceId}/outbox/LongAgent`);
    });

    it('uses workspace-namespaced paths when WORKSPACE_ID is in process.env', () => {
      const originalEnv = process.env.WORKSPACE_ID;
      process.env.WORKSPACE_ID = 'ws-cloud-99';

      try {
        orchestrator = new RelayPtyOrchestrator({
          name: 'CloudAgent',
          command: 'claude',
        });

        expect(orchestrator.getSocketPath()).toBe('/tmp/relay/ws-cloud-99/sockets/CloudAgent.sock');
        expect(orchestrator.outboxPath).toBe('/tmp/relay/ws-cloud-99/outbox/CloudAgent');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.WORKSPACE_ID;
        } else {
          process.env.WORKSPACE_ID = originalEnv;
        }
      }
    });

    it('uses legacy paths when WORKSPACE_ID is not set', () => {
      // beforeEach already clears WORKSPACE_ID
      orchestrator = new RelayPtyOrchestrator({
        name: 'LocalAgent',
        command: 'claude',
      });

      expect(orchestrator.getSocketPath()).toBe('/tmp/relay-pty-LocalAgent.sock');
      expect(orchestrator.outboxPath).toBe('/tmp/relay-outbox/LocalAgent');
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

      // Simulate output containing the injected message pattern
      // This is needed because handleInjectResult now verifies the message appeared in output
      mockProcess.stdout?.emit('data', Buffer.from(
        'Relay message from Sender [msg-456]: Test message\n'
      ));

      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate successful delivery response
      mockSocket.emit('data', Buffer.from(JSON.stringify({
        type: 'inject_result',
        id: 'msg-456',
        status: 'delivered',
        timestamp: Date.now(),
      }) + '\n'));

      // Allow time for async verification (verifyInjection polls for up to 2 seconds)
      await new Promise(resolve => setTimeout(resolve, 200));

      // Check metrics
      const metrics = orchestrator.getInjectionMetrics();
      expect(metrics.total).toBeGreaterThan(0);
      expect(metrics.successFirstTry).toBeGreaterThan(0);
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

  describe('spawn with auto-send task', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('calls spawn API when dashboard port is configured', async () => {
      // Mock successful spawn API response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      orchestrator = new RelayPtyOrchestrator({
        name: 'LeadAgent',
        command: 'claude',
        dashboardPort: 3000,
      });

      await orchestrator.start();

      // Access the private method via prototype - simulate spawn command detection
      // We'll trigger it by emitting spawn command in output
      // Note: Use "DevWorker" instead of "Worker" since "worker" is a placeholder target
      mockProcess.stdout!.emit('data', Buffer.from(
        '->relay:spawn DevWorker claude "Implement feature X"\n'
      ));

      // Wait for async spawn processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify spawn API was called with task included
      // Note: The spawner (not orchestrator) sends the initial task after waitUntilCliReady()
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/spawn',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'DevWorker', cli: 'claude', task: 'Implement feature X' }),
        })
      );
    });

    it('calls onSpawn callback with task when no dashboard port', async () => {
      const onSpawnMock = vi.fn().mockResolvedValue(undefined);

      orchestrator = new RelayPtyOrchestrator({
        name: 'LeadAgent',
        command: 'claude',
        onSpawn: onSpawnMock,
      });

      await orchestrator.start();

      // Trigger spawn command
      // Note: Use "CodeDev" instead of "Developer" to avoid any potential placeholder filtering
      mockProcess.stdout!.emit('data', Buffer.from(
        '->relay:spawn CodeDev claude "Fix the bug"\n'
      ));

      // Wait for async spawn processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify onSpawn was called with task included
      // Note: The callback is responsible for sending the initial task
      expect(onSpawnMock).toHaveBeenCalledWith('CodeDev', 'claude', 'Fix the bug');
    });

    it('does not send task message when task is empty', async () => {
      const onSpawnMock = vi.fn().mockResolvedValue(undefined);

      orchestrator = new RelayPtyOrchestrator({
        name: 'LeadAgent',
        command: 'claude',
        onSpawn: onSpawnMock,
      });

      await orchestrator.start();

      // Clear any previous calls
      const { RelayClient } = await import('./client.js');
      const mockClientInstance = (RelayClient as any).mock.results[0].value;
      mockClientInstance.sendMessage.mockClear();

      // Trigger spawn command with empty task (using fenced format with whitespace only)
      // Note: Use "DevAgent" instead of "Worker" since "worker" is a placeholder target
      mockProcess.stdout!.emit('data', Buffer.from(
        '->relay:spawn DevAgent claude ""\n'
      ));

      // Wait for async spawn processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify no task message was sent (empty task)
      expect(mockClientInstance.sendMessage).not.toHaveBeenCalled();
    });

    it('deduplicates spawn commands (only spawns once)', async () => {
      const onSpawnMock = vi.fn().mockResolvedValue(undefined);

      orchestrator = new RelayPtyOrchestrator({
        name: 'LeadAgent',
        command: 'claude',
        onSpawn: onSpawnMock,
      });

      await orchestrator.start();

      // Trigger same spawn command twice
      // Note: Use "TaskAgent" instead of "Worker" since "worker" is a placeholder target
      mockProcess.stdout!.emit('data', Buffer.from(
        '->relay:spawn TaskAgent claude "Task A"\n'
      ));
      mockProcess.stdout!.emit('data', Buffer.from(
        '->relay:spawn TaskAgent claude "Task A"\n'
      ));

      // Wait for async spawn processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // onSpawn should only be called once (deduplication)
      expect(onSpawnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('queue monitor', () => {
    it('starts queue monitor on start()', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      // Spy on setInterval
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      await orchestrator.start();

      // Queue monitor should be started (30 second interval)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);

      setIntervalSpy.mockRestore();
    });

    it('stops queue monitor on stop()', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      await orchestrator.start();
      await orchestrator.stop();

      // Queue monitor should be cleared
      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it('triggers processMessageQueue when queue has stuck messages and agent is idle', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Directly add a message to the queue (simulating a message that got stuck)
      (orchestrator as any).messageQueue.push({
        from: 'Alice',
        body: 'Test message',
        messageId: 'msg-123',
        kind: 'message',
      });

      // Verify message is in queue
      expect(orchestrator.pendingMessageCount).toBe(1);

      // Spy on processMessageQueue to verify it gets called
      const processQueueSpy = vi.spyOn(orchestrator as any, 'processMessageQueue');

      // Simulate time passing (agent becomes idle - need 2000ms silence for checkForStuckQueue)
      // Mock the idle detector to report idle
      const idleDetector = (orchestrator as any).idleDetector;
      vi.spyOn(idleDetector, 'checkIdle').mockReturnValue({
        isIdle: true,
        confidence: 0.9,
        signals: [{ source: 'output_silence', confidence: 0.9, timestamp: Date.now() }],
      });

      // Manually trigger the queue check (simulating timer firing)
      (orchestrator as any).checkForStuckQueue();

      // processMessageQueue should have been called
      expect(processQueueSpy).toHaveBeenCalled();

      processQueueSpy.mockRestore();
    });

    it('does not trigger processing when agent is busy', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Set isInjecting to true (agent is busy)
      (orchestrator as any).isInjecting = true;

      // Add a message to the queue directly
      (orchestrator as any).messageQueue.push({
        from: 'Bob',
        body: 'Test message 2',
        messageId: 'msg-456',
        kind: 'message',
      });

      // Mock idle detector to report idle (to isolate the isInjecting check)
      const idleDetector = (orchestrator as any).idleDetector;
      vi.spyOn(idleDetector, 'checkIdle').mockReturnValue({
        isIdle: true,
        confidence: 0.9,
        signals: [],
      });

      // Spy on processMessageQueue
      const processQueueSpy = vi.spyOn(orchestrator as any, 'processMessageQueue');

      // Trigger queue check while busy
      (orchestrator as any).checkForStuckQueue();

      // processMessageQueue should NOT be called because isInjecting=true
      expect(processQueueSpy).not.toHaveBeenCalled();

      // Reset
      (orchestrator as any).isInjecting = false;
      processQueueSpy.mockRestore();
    });

    it('does not trigger processing when backpressure is active', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Simulate backpressure
      mockSocket.emit('data', Buffer.from(JSON.stringify({
        type: 'backpressure',
        accept: false,
        queue_length: 50,
      }) + '\n'));

      expect(orchestrator.isBackpressureActive()).toBe(true);

      // Add a message to the queue
      (orchestrator as any).messageQueue.push({
        from: 'Carol',
        body: 'Test message 3',
        messageId: 'msg-789',
        kind: 'message',
      });

      // Mock idle detector to report idle (to isolate the backpressure check)
      const idleDetector = (orchestrator as any).idleDetector;
      vi.spyOn(idleDetector, 'checkIdle').mockReturnValue({
        isIdle: true,
        confidence: 0.9,
        signals: [],
      });

      // Spy on processMessageQueue
      const processQueueSpy = vi.spyOn(orchestrator as any, 'processMessageQueue');

      // Trigger queue check with backpressure active
      (orchestrator as any).checkForStuckQueue();

      // processMessageQueue should NOT be called because backpressure is active
      expect(processQueueSpy).not.toHaveBeenCalled();

      processQueueSpy.mockRestore();
    });

    it('does not trigger processing when queue is empty', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Queue should be empty
      expect(orchestrator.pendingMessageCount).toBe(0);

      // Spy on processMessageQueue
      const processQueueSpy = vi.spyOn(orchestrator as any, 'processMessageQueue');

      // Trigger queue check with empty queue
      (orchestrator as any).checkForStuckQueue();

      // processMessageQueue should not be called
      expect(processQueueSpy).not.toHaveBeenCalled();

      processQueueSpy.mockRestore();
    });

    it('does not trigger processing when agent is not idle', async () => {
      orchestrator = new RelayPtyOrchestrator({
        name: 'TestAgent',
        command: 'claude',
      });

      await orchestrator.start();

      // Add a message to the queue
      (orchestrator as any).messageQueue.push({
        from: 'Dave',
        body: 'Test message 4',
        messageId: 'msg-999',
        kind: 'message',
      });

      // Mock idle detector to report NOT idle (agent is still working)
      const idleDetector = (orchestrator as any).idleDetector;
      vi.spyOn(idleDetector, 'checkIdle').mockReturnValue({
        isIdle: false,
        confidence: 0.3,
        signals: [],
      });

      // Spy on processMessageQueue
      const processQueueSpy = vi.spyOn(orchestrator as any, 'processMessageQueue');

      // Trigger queue check while agent is active
      (orchestrator as any).checkForStuckQueue();

      // processMessageQueue should NOT be called because agent is not idle
      expect(processQueueSpy).not.toHaveBeenCalled();

      processQueueSpy.mockRestore();
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
