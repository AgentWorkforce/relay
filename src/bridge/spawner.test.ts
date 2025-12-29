/**
 * Unit tests for AgentSpawner (node-pty based)
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import { AgentSpawner, readWorkersMetadata, getWorkerLogsDir } from './spawner.js';

const PROJECT_ROOT = '/project/root';

// Mock PtyWrapper
const mockPtyWrapper = {
  start: vi.fn(),
  stop: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
  getOutput: vi.fn(() => []),
  getRawOutput: vi.fn(() => ''),
  isRunning: true,
  pid: 12345,
  logPath: '/team/worker-logs/test.log',
  name: 'TestWorker',
};

vi.mock('../wrapper/pty-wrapper.js', () => {
  return {
    PtyWrapper: vi.fn().mockImplementation(() => mockPtyWrapper),
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

const existsSyncMock = vi.spyOn(fs, 'existsSync');
const readFileSyncMock = vi.spyOn(fs, 'readFileSync');
const writeFileSyncMock = vi.spyOn(fs, 'writeFileSync');
const mkdirSyncMock = vi.spyOn(fs, 'mkdirSync');
let waitForAgentRegistrationMock: ReturnType<typeof vi.spyOn>;

describe('AgentSpawner', () => {
  const projectRoot = PROJECT_ROOT;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ agents: [] }));
    writeFileSyncMock.mockImplementation(() => {});
    mkdirSyncMock.mockImplementation(() => undefined);
    mockPtyWrapper.start.mockResolvedValue(undefined);
    mockPtyWrapper.isRunning = true;
    mockPtyWrapper.pid = 12345;
    waitForAgentRegistrationMock = vi
      .spyOn(AgentSpawner.prototype as any, 'waitForAgentRegistration')
      .mockResolvedValue(true);
  });

  it('spawns a worker and tracks it with PID', async () => {
    const spawner = new AgentSpawner(projectRoot);
    const result = await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'Finish the report',
      requestedBy: 'Lead',
    });

    expect(result).toMatchObject({
      success: true,
      name: 'Dev1',
      pid: 12345,
    });
    expect(spawner.hasWorker('Dev1')).toBe(true);
    expect(mockPtyWrapper.start).toHaveBeenCalled();
    expect(mockPtyWrapper.write).toHaveBeenCalledWith('Finish the report\r');
  });

  it('adds --dangerously-skip-permissions for Claude variants', async () => {
    const { PtyWrapper } = await import('../wrapper/pty-wrapper.js');
    const PtyWrapperMock = PtyWrapper as Mock;

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Opus1',
      cli: 'claude:opus',
      task: '',
      requestedBy: 'Lead',
    });

    // Check the PtyWrapper was constructed with --dangerously-skip-permissions
    const constructorCall = PtyWrapperMock.mock.calls[0][0];
    expect(constructorCall.command).toBe('claude:opus');
    expect(constructorCall.args).toContain('--dangerously-skip-permissions');
  });

  it('does NOT add --dangerously-skip-permissions for non-Claude CLIs', async () => {
    const { PtyWrapper } = await import('../wrapper/pty-wrapper.js');
    const PtyWrapperMock = PtyWrapper as Mock;

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Codex1',
      cli: 'codex',
      task: '',
      requestedBy: 'Lead',
    });

    // Check the PtyWrapper was constructed without --dangerously-skip-permissions
    const constructorCall = PtyWrapperMock.mock.calls[0][0];
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
      requestedBy: 'Lead',
    });

    // Second spawn with same name should fail
    const result = await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'New task',
      requestedBy: 'Lead',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('returns failure when PtyWrapper.start() throws', async () => {
    mockPtyWrapper.start.mockRejectedValueOnce(new Error('PTY spawn failed'));

    const spawner = new AgentSpawner(projectRoot);
    const result = await spawner.spawn({
      name: 'Dev2',
      cli: 'claude',
      task: 'Task',
      requestedBy: 'Lead',
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
      requestedBy: 'Lead',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed to register');
    expect(mockPtyWrapper.kill).toHaveBeenCalled();
    expect(spawner.hasWorker('Late')).toBe(false);
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
      requestedBy: 'Lead',
    });

    mockPtyWrapper.isRunning = false; // Simulate graceful stop

    const result = await spawner.release('Worker');

    expect(result).toBe(true);
    expect(spawner.hasWorker('Worker')).toBe(false);
    expect(mockPtyWrapper.stop).toHaveBeenCalled();
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
      requestedBy: 'Lead',
    });

    mockPtyWrapper.isRunning = true; // Still running after stop

    const result = await spawner.release('Stubborn');

    expect(result).toBe(true);
    expect(mockPtyWrapper.stop).toHaveBeenCalled();
    expect(mockPtyWrapper.kill).toHaveBeenCalled();
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

    mockPtyWrapper.isRunning = false;

    await spawner.releaseAll();

    expect(spawner.getActiveWorkers()).toHaveLength(0);
  });

  it('saves workers metadata to disk', async () => {
    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({
      name: 'Worker1',
      cli: 'claude',
      task: 'Task',
      requestedBy: 'Lead',
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
    mockPtyWrapper.getOutput.mockReturnValue(['line1', 'line2', 'line3']);

    const spawner = new AgentSpawner(projectRoot);
    await spawner.spawn({ name: 'Dev', cli: 'claude', task: '', requestedBy: 'Lead' });

    const output = spawner.getWorkerOutput('Dev', 2);

    expect(output).toEqual(['line1', 'line2', 'line3']);
    expect(mockPtyWrapper.getOutput).toHaveBeenCalledWith(2);
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
