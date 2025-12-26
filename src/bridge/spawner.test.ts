/**
 * Unit tests for AgentSpawner
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { AgentSpawner } from './spawner.js';
import { execAsync, sleep, escapeForTmux } from './utils.js';

const PROJECT_ROOT = '/project/root';

vi.mock('./utils.js', () => {
  const execAsync = vi.fn();
  const sleep = vi.fn();
  const escapeForTmux = vi.fn((str: string) => `escaped:${str}`);
  return {
    execAsync,
    sleep,
    escapeForTmux,
  };
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

const execAsyncMock = vi.mocked(execAsync);
const sleepMock = vi.mocked(sleep);
const escapeForTmuxMock = vi.mocked(escapeForTmux);
const existsSyncMock = vi.spyOn(fs, 'existsSync');
const readFileSyncMock = vi.spyOn(fs, 'readFileSync');
let waitForAgentRegistrationMock: vi.SpyInstance;

describe('AgentSpawner', () => {
  const projectRoot = PROJECT_ROOT;
  const session = 'relay-workers';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    execAsyncMock.mockReset();
    sleepMock.mockReset();
    escapeForTmuxMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ agents: [] }));
    escapeForTmuxMock.mockImplementation((str: string) => `escaped:${str}`);
    waitForAgentRegistrationMock = vi
      .spyOn(AgentSpawner.prototype as any, 'waitForAgentRegistration')
      .mockResolvedValue(true);
  });

  it('creates tmux session when missing', async () => {
    execAsyncMock.mockRejectedValueOnce(new Error('missing'));
    execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const spawner = new AgentSpawner(projectRoot, session);
    await spawner.ensureSession();

    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect(execAsyncMock.mock.calls[0][0]).toBe(`tmux has-session -t ${session} 2>/dev/null`);
    expect(execAsyncMock.mock.calls[1][0]).toBe(`tmux new-session -d -s ${session} -c "${projectRoot}"`);
  });

  it('does nothing when tmux session already exists', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

    const spawner = new AgentSpawner(projectRoot, session);
    await spawner.ensureSession();

    expect(execAsyncMock).toHaveBeenCalledTimes(1);
    expect(execAsyncMock).toHaveBeenCalledWith(`tmux has-session -t ${session} 2>/dev/null`);
  });

  it('spawns a worker and tracks it', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '/usr/local/bin/agent-relay', stderr: '' });
    sleepMock.mockResolvedValue();
    waitForAgentRegistrationMock.mockResolvedValue(true);

    const spawner = new AgentSpawner(projectRoot, session);
    const result = await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'Finish the report',
      requestedBy: 'Lead',
    });

    expect(result).toMatchObject({
      success: true,
      name: 'Dev1',
      window: `${session}:Dev1`,
    });
    expect(spawner.hasWorker('Dev1')).toBe(true);
    expect(execAsyncMock).toHaveBeenNthCalledWith(1, `tmux has-session -t ${session} 2>/dev/null`);
    expect(execAsyncMock).toHaveBeenNthCalledWith(2, `tmux new-window -t ${session} -n Dev1 -c "${projectRoot}"`);
    expect(execAsyncMock).toHaveBeenNthCalledWith(3, 'which agent-relay'); // Find full path
    expect(execAsyncMock).toHaveBeenNthCalledWith(4, `tmux send-keys -t ${session}:Dev1 'unset TMUX && /usr/local/bin/agent-relay -n Dev1 -- claude --dangerously-skip-permissions' Enter`);
    expect(execAsyncMock).toHaveBeenNthCalledWith(5, `tmux send-keys -t ${session}:Dev1 -l "escaped:Finish the report"`);
    expect(execAsyncMock).toHaveBeenNthCalledWith(6, `tmux send-keys -t ${session}:Dev1 Enter`);
    expect(sleepMock).toHaveBeenCalledWith(100);
  });

  it('adds --dangerously-skip-permissions for Claude variants', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '/usr/local/bin/agent-relay', stderr: '' });
    sleepMock.mockResolvedValue();
    waitForAgentRegistrationMock.mockResolvedValue(true);

    const spawner = new AgentSpawner(projectRoot, session);
    await spawner.spawn({
      name: 'Opus1',
      cli: 'claude:opus',
      task: '',
      requestedBy: 'Lead',
    });

    // Check that the command includes --dangerously-skip-permissions for claude:opus
    expect(execAsyncMock).toHaveBeenNthCalledWith(
      4,
      `tmux send-keys -t ${session}:Opus1 'unset TMUX && /usr/local/bin/agent-relay -n Opus1 -- claude:opus --dangerously-skip-permissions' Enter`
    );
  });

  it('does NOT add --dangerously-skip-permissions for non-Claude CLIs', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '/usr/local/bin/agent-relay', stderr: '' });
    sleepMock.mockResolvedValue();
    waitForAgentRegistrationMock.mockResolvedValue(true);

    const spawner = new AgentSpawner(projectRoot, session);
    await spawner.spawn({
      name: 'Codex1',
      cli: 'codex',
      task: '',
      requestedBy: 'Lead',
    });

    // Check that the command does NOT include --dangerously-skip-permissions for codex
    expect(execAsyncMock).toHaveBeenNthCalledWith(
      4,
      `tmux send-keys -t ${session}:Codex1 'unset TMUX && /usr/local/bin/agent-relay -n Codex1 -- codex' Enter`
    );
  });

  it('refuses to spawn a duplicate worker', async () => {
    const spawner = new AgentSpawner(projectRoot, session);
    spawner['activeWorkers'].set('Dev1', {
      name: 'Dev1',
      cli: 'claude',
      task: 'Existing task',
      spawnedBy: 'Lead',
      spawnedAt: Date.now(),
      window: `${session}:Dev1`,
    });

    const result = await spawner.spawn({
      name: 'Dev1',
      cli: 'claude',
      task: 'New task',
      requestedBy: 'Lead',
    });

    expect(result.success).toBe(false);
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it('returns failure when spawn command errors', async () => {
    execAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // has-session
      .mockRejectedValueOnce(new Error('tmux new-window failed')); // new-window fails

    const spawner = new AgentSpawner(projectRoot, session);
    const result = await spawner.spawn({
      name: 'Dev2',
      cli: 'claude',
      task: 'Task',
      requestedBy: 'Lead',
    });

    expect(result.success).toBe(false);
    expect(spawner.hasWorker('Dev2')).toBe(false);
  });

  it('cleans up when agent does not register', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '/usr/local/bin/agent-relay', stderr: '' });
    waitForAgentRegistrationMock.mockResolvedValue(false);

    const spawner = new AgentSpawner(projectRoot, session);
    const result = await spawner.spawn({
      name: 'Late',
      cli: 'claude',
      task: 'Task',
      requestedBy: 'Lead',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed to register');
    expect(execAsyncMock).toHaveBeenCalledWith(`tmux kill-window -t ${session}:Late`);
    expect(spawner.hasWorker('Late')).toBe(false);
  });

  it('releases a worker and removes tracking', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
    sleepMock.mockResolvedValue();

    const spawner = new AgentSpawner(projectRoot, session);
    spawner['activeWorkers'].set('Worker', {
      name: 'Worker',
      cli: 'claude',
      task: 'Task',
      spawnedBy: 'Lead',
      spawnedAt: Date.now(),
      window: `${session}:Worker`,
    });

    const result = await spawner.release('Worker');

    expect(result).toBe(true);
    expect(spawner.hasWorker('Worker')).toBe(false);
    expect(execAsyncMock).toHaveBeenNthCalledWith(1, `tmux send-keys -t ${session}:Worker '/exit' Enter`);
    expect(execAsyncMock).toHaveBeenNthCalledWith(2, `tmux kill-window -t ${session}:Worker`);
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it('returns false when releasing a missing worker', async () => {
    const spawner = new AgentSpawner(projectRoot, session);

    const result = await spawner.release('Missing');

    expect(result).toBe(false);
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it('clears worker even when release fails', async () => {
    execAsyncMock.mockRejectedValue(new Error('tmux error'));
    sleepMock.mockResolvedValue();

    const spawner = new AgentSpawner(projectRoot, session);
    spawner['activeWorkers'].set('Failing', {
      name: 'Failing',
      cli: 'claude',
      task: 'Task',
      spawnedBy: 'Lead',
      spawnedAt: Date.now(),
      window: `${session}:Failing`,
    });

    const result = await spawner.release('Failing');

    expect(result).toBe(true);
    expect(spawner.hasWorker('Failing')).toBe(false);
    expect(execAsyncMock).toHaveBeenCalledTimes(2);
    expect(execAsyncMock.mock.calls[0][0]).toBe(`tmux send-keys -t ${session}:Failing '/exit' Enter`);
    expect(execAsyncMock.mock.calls[1][0]).toBe(`tmux kill-window -t ${session}:Failing`);
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it('releases all workers', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
    sleepMock.mockResolvedValue();

    const spawner = new AgentSpawner(projectRoot, session);
    spawner['activeWorkers'].set('A', {
      name: 'A',
      cli: 'claude',
      task: 'Task A',
      spawnedBy: 'Lead',
      spawnedAt: Date.now(),
      window: `${session}:A`,
    });
    spawner['activeWorkers'].set('B', {
      name: 'B',
      cli: 'claude',
      task: 'Task B',
      spawnedBy: 'Lead',
      spawnedAt: Date.now(),
      window: `${session}:B`,
    });

    await spawner.releaseAll();

    expect(spawner.getActiveWorkers()).toHaveLength(0);
    expect(execAsyncMock).toHaveBeenCalledTimes(4); // two send-keys and two kill-window
  });
});
