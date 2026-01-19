/**
 * Unit tests for AgentSpawner (node-pty based)
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import { AgentSpawner, readWorkersMetadata, getWorkerLogsDir } from './spawner.js';

const PROJECT_ROOT = '/project/root';

// Mock RelayPtyOrchestrator
const mockPtyOrchestrator = {
  start: vi.fn(),
  stop: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
  getOutput: vi.fn(() => []),
  getRawOutput: vi.fn(() => ''),
  on: vi.fn(), // EventEmitter method used by spawner for output events
  off: vi.fn(), // EventEmitter method used by spawner for cleanup
  isRunning: true,
  pid: 12345,
  logPath: '/team/worker-logs/test.log',
  name: 'TestWorker',
  getAgentId: vi.fn(() => 'agent-id-123'),
};

vi.mock('../wrapper/relay-pty-orchestrator.js', () => {
  return {
    RelayPtyOrchestrator: vi.fn().mockImplementation(() => mockPtyOrchestrator),
  };
});

vi.mock('./utils.js', () => {
  const sleep = vi.fn();
  return { sleep };
});

vi.mock('../utils/project-namespace.js', () => {
  return {
    getProjectPaths: vi.fn(() => ({
      dataDir: '/data',
      teamDir: '/team',
      dbPath: '/db',
      socketPath: '/socket',
      projectRoot: PROJECT_ROOT,
      projectId: 'project-id',
    })),
  };
});

// Mock command resolver to return original command (skip path resolution in tests)
vi.mock('../utils/command-resolver.js', () => {
  return {
    resolveCommand: vi.fn((cmd: string) => cmd),
    commandExists: vi.fn(() => true),
  };
});

const existsSyncMock = vi.spyOn(fs, 'existsSync');
const readFileSyncMock = vi.spyOn(fs, 'readFileSync');
const writeFileSyncMock = vi.spyOn(fs, 'writeFileSync');
const mkdirSyncMock = vi.spyOn(fs, 'mkdirSync');
let waitForAgentRegistrationMock: ReturnType<typeof vi.spyOn>;
let originalEnv: Record<string, string | undefined>;

describe('AgentSpawner', () => {
  const projectRoot = PROJECT_ROOT;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = {
      GH_TOKEN: process.env.GH_TOKEN,
      CLOUD_API_URL: process.env.CLOUD_API_URL,
      AGENT_RELAY_CLOUD_URL: process.env.AGENT_RELAY_CLOUD_URL,
      WORKSPACE_ID: process.env.WORKSPACE_ID,
      WORKSPACE_TOKEN: process.env.WORKSPACE_TOKEN,
    };
    delete process.env.GH_TOKEN;
    delete process.env.CLOUD_API_URL;
    delete process.env.AGENT_RELAY_CLOUD_URL;
    delete process.env.WORKSPACE_ID;
    delete process.env.WORKSPACE_TOKEN;
    // Mock file system calls with path-aware responses
    existsSyncMock.mockImplementation((filePath: string) => {
      // Snippet files don't exist in test environment
      if (filePath.includes('agent-relay-snippet') || filePath.includes('agent-relay-protocol')) {
        return false;
      }
      return true;
    });
    readFileSyncMock.mockImplementation((filePath: string) => {
      // Return agents.json content for registry files
      if (typeof filePath === 'string' && filePath.includes('agents.json')) {
        return JSON.stringify({ agents: [] });
      }
      // Return empty for other files
      return '';
    });
    writeFileSyncMock.mockImplementation(() => {});
    mkdirSyncMock.mockImplementation(() => undefined);
    mockPtyOrchestrator.start.mockResolvedValue(undefined);
    mockPtyOrchestrator.isRunning = true;
    mockPtyOrchestrator.pid = 12345;
    waitForAgentRegistrationMock = vi
      .spyOn(AgentSpawner.prototype as any, 'waitForAgentRegistration')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('spawns a worker and tracks it with PID', async () => {
    const spawner = new AgentSpawner(projectRoot);
    const result = await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'Finish the report',
      // team is optional - agents are flat by default
    });

    expect(result).toMatchObject({
      success: true,
      name: 'Dev1',
      pid: 12345,
    });
    expect(spawner.hasWorker('Dev1')).toBe(true);
    expect(mockPtyOrchestrator.start).toHaveBeenCalled();
    // Note: Task is no longer written directly to PTY by spawner.
    // The spawning wrapper waits for the agent to come online and sends it via relay.
    // This test just verifies the spawn itself works.
  });

  it('adds --dangerously-skip-permissions for Claude variants', async () => {
    const { RelayPtyOrchestrator } = await import('../wrapper/relay-pty-orchestrator.js');
    const RelayPtyOrchestratorMock = RelayPtyOrchestrator as Mock;

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Opus1',
      cli: 'claude:opus',
      task: '',
      // team is optional - agents are flat by default
    });

    // Check the RelayPtyOrchestrator was constructed with --dangerously-skip-permissions
    const constructorCall = RelayPtyOrchestratorMock.mock.calls[0][0];
    expect(constructorCall.command).toBe('claude:opus');
    expect(constructorCall.args).toContain('--dangerously-skip-permissions');
  });

  it('does NOT add --dangerously-skip-permissions for non-Claude CLIs', async () => {
    const { RelayPtyOrchestrator } = await import('../wrapper/relay-pty-orchestrator.js');
    const RelayPtyOrchestratorMock = RelayPtyOrchestrator as Mock;

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Codex1',
      cli: 'codex',
      task: '',
      // team is optional - agents are flat by default
    });

    // Check the RelayPtyOrchestrator was constructed without --dangerously-skip-permissions
    const constructorCall = RelayPtyOrchestratorMock.mock.calls[0][0];
    expect(constructorCall.command).toBe('codex');
    expect(constructorCall.args).not.toContain('--dangerously-skip-permissions');
  });

  it('refuses to spawn a duplicate worker', async () => {
    const spawner = new AgentSpawner(projectRoot);
    // First spawn succeeds
    await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'First task',
      // team is optional - agents are flat by default
    });

    // Second spawn with same name should fail
    const result = await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'New task',
      // team is optional - agents are flat by default
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('returns failure when PtyWrapper.start() throws', async () => {
    mockPtyOrchestrator.start.mockRejectedValueOnce(new Error('PTY spawn failed'));

    const spawner = new AgentSpawner(projectRoot);
    const result = await spawner.spawn({
      name: 'Dev2',
      cli: 'claude',
      task: 'Task',
      // team is optional - agents are flat by default
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('PTY spawn failed');
    expect(spawner.hasWorker('Dev2')).toBe(false);
  });

  it('cleans up when agent does not register', async () => {
    waitForAgentRegistrationMock.mockResolvedValue(false);

    const spawner = new AgentSpawner(projectRoot);
    const result = await spawner.spawn({
      name: 'Late',
      cli: 'claude',
      task: 'Task',
      // team is optional - agents are flat by default
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed to register');
    expect(mockPtyOrchestrator.kill).toHaveBeenCalled();
    expect(spawner.hasWorker('Late')).toBe(false);
  });

  it('passes GH_TOKEN from parent env to spawned agent', async () => {
    process.env.GH_TOKEN = 'gh-token-123';
    const { RelayPtyOrchestrator } = await import('../wrapper/relay-pty-orchestrator.js');
    const RelayPtyOrchestratorMock = RelayPtyOrchestrator as Mock;

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'TokenAgent',
      cli: 'claude',
      task: '',
    });

    const constructorCall = RelayPtyOrchestratorMock.mock.calls[RelayPtyOrchestratorMock.mock.calls.length - 1][0];
    expect(constructorCall.env?.GH_TOKEN).toBe('gh-token-123');
  });

  it('releases a worker and removes tracking', async () => {
    const { sleep } = await import('./utils.js');
    const sleepMock = sleep as Mock;
    sleepMock.mockResolvedValue(undefined);

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Worker',
      cli: 'claude',
      task: 'Task',
      // team is optional - agents are flat by default
    });

    mockPtyOrchestrator.isRunning = false; // Simulate graceful stop

    const result = await spawner.release('Worker');

    expect(result).toBe(true);
    expect(spawner.hasWorker('Worker')).toBe(false);
    expect(mockPtyOrchestrator.stop).toHaveBeenCalled();
  });

  it('force kills worker if still running after stop', async () => {
    const { sleep } = await import('./utils.js');
    const sleepMock = sleep as Mock;
    sleepMock.mockResolvedValue(undefined);

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Stubborn',
      cli: 'claude',
      task: 'Task',
      // team is optional - agents are flat by default
    });

    mockPtyOrchestrator.isRunning = true; // Still running after stop

    const result = await spawner.release('Stubborn');

    expect(result).toBe(true);
    expect(mockPtyOrchestrator.stop).toHaveBeenCalled();
    expect(mockPtyOrchestrator.kill).toHaveBeenCalled();
  });

  it('returns false when releasing a missing worker', async () => {
    const spawner = new AgentSpawner(projectRoot);

    const result = await spawner.release('Missing');

    expect(result).toBe(false);
  });

  it('releases all workers', async () => {
    const { sleep } = await import('./utils.js');
    const sleepMock = sleep as Mock;
    sleepMock.mockResolvedValue(undefined);

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({ name: 'A', cli: 'claude', task: 'Task A', requestedBy: 'Lead' });
    await spawner.spawn({ name: 'B', cli: 'claude', task: 'Task B', requestedBy: 'Lead' });

    mockPtyOrchestrator.isRunning = false;

    await spawner.releaseAll();

    expect(spawner.getActiveWorkers()).toHaveLength(0);
  });

  it('saves workers metadata to disk', async () => {
    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Worker1',
      cli: 'claude',
      task: 'Task',
      // team is optional - agents are flat by default
    });

    expect(writeFileSyncMock).toHaveBeenCalled();
    const [filePath, content] = writeFileSyncMock.mock.calls[0];
    expect(filePath).toBe('/team/workers.json');
    const parsed = JSON.parse(content as string);
    expect(parsed.workers).toHaveLength(1);
    expect(parsed.workers[0].name).toBe('Worker1');
    expect(parsed.workers[0].pid).toBe(12345);
  });

  it('getWorkerOutput returns output from PtyWrapper', async () => {
    mockPtyOrchestrator.getOutput.mockReturnValue(['line1', 'line2', 'line3']);

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({ name: 'Dev', cli: 'claude', task: '', requestedBy: 'Lead' });

    const output = spawner.getWorkerOutput('Dev', 2);

    expect(output).toEqual(['line1', 'line2', 'line3']);
    expect(mockPtyOrchestrator.getOutput).toHaveBeenCalledWith(2);
  });

  it('getWorkerOutput returns null for unknown worker', async () => {
    const spawner = new AgentSpawner(projectRoot);
    const output = spawner.getWorkerOutput('Unknown');
    expect(output).toBeNull();
  });
});

describe('readWorkersMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when file does not exist', () => {
    existsSyncMock.mockReturnValue(false);

    const workers = readWorkersMetadata(PROJECT_ROOT);

    expect(workers).toEqual([]);
  });

  it('returns workers from file', () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        workers: [
          { name: 'W1', cli: 'claude', pid: 123 },
          { name: 'W2', cli: 'codex', pid: 456 },
        ],
      })
    );

    const workers = readWorkersMetadata(PROJECT_ROOT);

    expect(workers).toHaveLength(2);
    expect(workers[0].name).toBe('W1');
    expect(workers[1].name).toBe('W2');
  });

  it('returns empty array on parse error', () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('invalid json');

    const workers = readWorkersMetadata(PROJECT_ROOT);

    expect(workers).toEqual([]);
  });
});

describe('getWorkerLogsDir', () => {
  it('returns correct logs directory path', () => {
    const logsDir = getWorkerLogsDir(PROJECT_ROOT);
    expect(logsDir).toBe('/team/worker-logs');
  });
});
