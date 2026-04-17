import { describe, it, expect, vi } from 'vitest';

import { createProcessBackendExecutor } from '../process-backend-executor.js';
import type { ProcessBackend, ProcessEnvironment, WorkflowStep, AgentDefinition } from '../types.js';

function makeEnv(
  exec: ProcessEnvironment['exec'],
  destroy: ProcessEnvironment['destroy'] = vi.fn(async () => undefined)
): ProcessEnvironment {
  return {
    id: 'env-1',
    homeDir: '/home/runner',
    exec,
    uploadFile: vi.fn(async () => undefined),
    destroy,
  };
}

function makeBackend(env: ProcessEnvironment): ProcessBackend {
  return { createEnvironment: vi.fn(async () => env) };
}

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return { name: 'step-1', ...overrides } as WorkflowStep;
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: 'worker-1', cli: 'claude', ...overrides } as AgentDefinition;
}

describe('createProcessBackendExecutor', () => {
  it('creates an environment, runs the built command, and destroys the env', async () => {
    const destroy = vi.fn<ProcessEnvironment['destroy']>(async () => undefined);
    const exec = vi.fn<ProcessEnvironment['exec']>(async () => ({ output: 'hello\n', exitCode: 0 }));
    const env = makeEnv(exec, destroy);
    const backend = makeBackend(env);

    const executor = createProcessBackendExecutor(backend);
    const output = await executor.executeAgentStep(
      makeStep({ name: 'planner' }),
      makeAgent({ cli: 'claude' }),
      'do the thing',
      30_000
    );

    expect(backend.createEnvironment).toHaveBeenCalledWith('planner');
    expect(exec).toHaveBeenCalledTimes(1);
    const [command, opts] = exec.mock.calls[0]!;
    expect(typeof command).toBe('string');
    expect(command).toContain('claude');
    expect(opts?.timeoutSeconds).toBe(30);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(output).toBe('hello\n');
  });

  it('passes injected env and agent cwd through execOpts (not baked into the command)', async () => {
    const exec = vi.fn<ProcessEnvironment['exec']>(async () => ({ output: 'ok', exitCode: 0 }));
    const env = makeEnv(exec);
    const backend = makeBackend(env);

    const executor = createProcessBackendExecutor(backend, {
      env: { ANTHROPIC_API_KEY: 'sk-test', RELAY_WORKSPACE: 'ws_123' },
    });

    await executor.executeAgentStep(
      makeStep({ name: 'planner' }),
      makeAgent({ cli: 'claude', cwd: '/work/repo' }),
      'do the thing',
      5_000
    );

    const [command, opts] = exec.mock.calls[0]!;
    expect(command.startsWith('claude ') || command.startsWith("'claude'")).toBe(true);
    expect(command).not.toMatch(/ANTHROPIC_API_KEY=/);
    expect(opts?.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test', RELAY_WORKSPACE: 'ws_123' });
    expect(opts?.cwd).toBe('/work/repo');
    expect(opts?.timeoutSeconds).toBe(5);
  });

  it('throws when the remote command exits non-zero and still destroys', async () => {
    const destroy = vi.fn<ProcessEnvironment['destroy']>(async () => undefined);
    const exec = vi.fn<ProcessEnvironment['exec']>(async () => ({ output: 'boom', exitCode: 2 }));
    const env = makeEnv(exec, destroy);
    const backend = makeBackend(env);

    const executor = createProcessBackendExecutor(backend);

    await expect(executor.executeAgentStep(makeStep(), makeAgent(), 'task')).rejects.toThrow(
      /exited with code 2/
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects cli:"api" because it does not run as a subprocess', async () => {
    const env = makeEnv(vi.fn<ProcessEnvironment['exec']>());
    const backend = makeBackend(env);
    const executor = createProcessBackendExecutor(backend);

    await expect(executor.executeAgentStep(makeStep(), makeAgent({ cli: 'api' }), 'task')).rejects.toThrow(
      /cli "api"/
    );
  });

  it('passes injected env through to exec for deterministic steps', async () => {
    const exec = vi.fn<ProcessEnvironment['exec']>(async () => ({ output: 'ok', exitCode: 0 }));
    const env = makeEnv(exec);
    const backend = makeBackend(env);

    const executor = createProcessBackendExecutor(backend, {
      env: { RELAY_WORKSPACE: 'ws_123' },
    });

    const result = await executor.executeDeterministicStep!(
      makeStep({ type: 'deterministic', command: 'echo hi', timeoutMs: 5_000 }),
      'echo hi',
      '/work'
    );

    expect(result).toEqual({ output: 'ok', exitCode: 0 });
    const [, opts] = exec.mock.calls[0]!;
    expect(opts?.cwd).toBe('/work');
    expect(opts?.env).toEqual({ RELAY_WORKSPACE: 'ws_123' });
    expect(opts?.timeoutSeconds).toBe(5);
  });
});
