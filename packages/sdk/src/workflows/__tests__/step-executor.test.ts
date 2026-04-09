import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  StepExecutor,
  resolveStepMaxRetries,
  type StepExecutorDeps,
  type StepResult,
} from '../step-executor.js';
import type { ProcessSpawner } from '../process-spawner.js';
import { createProcessSpawner } from '../process-spawner.js';
import type { WorkflowStep, AgentDefinition, WorkflowStepStatus } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'step-1',
    type: 'deterministic',
    command: 'echo hello',
    ...overrides,
  } as WorkflowStep;
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'worker-1',
    cli: 'claude',
    role: 'specialist',
    ...overrides,
  } as AgentDefinition;
}

function mockSpawner(overrides: Partial<ProcessSpawner> = {}): ProcessSpawner {
  return {
    spawnShell: vi.fn(async () => ({ output: 'hello\n', exitCode: 0 })),
    spawnAgent: vi.fn(async () => ({ output: 'done', exitCode: 0 })),
    spawnInteractive: vi.fn(async () => ({ output: 'completed', exitCode: 0 })),
    buildCommand: vi.fn(() => ({ bin: 'claude', args: ['--task', 'x'] })),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StepExecutorDeps> = {}): StepExecutorDeps {
  return {
    cwd: '/tmp/test-project',
    runId: 'run-001',
    postToChannel: vi.fn(),
    persistStepRow: vi.fn(),
    persistStepOutput: vi.fn(),
    resolveTemplate: vi.fn((s: string) => s),
    getStepOutput: vi.fn(() => ''),
    checkAborted: vi.fn(),
    waitIfPaused: vi.fn(async () => {}),
    log: vi.fn(),
    processSpawner: mockSpawner(),
    ...overrides,
  };
}

function createExecutor(overrides: Partial<StepExecutorDeps> = {}): StepExecutor {
  return new StepExecutor(makeDeps(overrides));
}

// ── 1. Deterministic step execution ──────────────────────────────────────────

describe('StepExecutor — deterministic steps', () => {
  it('runs a shell command and captures stdout', async () => {
    const executor = createExecutor();
    const step = makeStep({ command: 'echo hello' });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('completed');
    expect(result.output).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('marks step failed on non-zero exit code', async () => {
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => ({ output: 'err', exitCode: 1 })),
      }),
    });
    const step = makeStep({ command: 'false' });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('succeeds with non-zero exit when failOnError is false', async () => {
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => ({ output: 'warn', exitCode: 1 })),
      }),
    });
    const step = makeStep({ command: 'maybe-fail', failOnError: false });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('completed');
  });
});

// ── 2. Non-interactive agent step ────────────────────────────────────────────

describe('StepExecutor — non-interactive agent steps', () => {
  it('spawns a codex worker and captures output', async () => {
    const spawner = mockSpawner();
    const executor = createExecutor({ processSpawner: spawner });
    const agent = makeAgent({ cli: 'codex', name: 'codex-worker', interactive: false });
    const step = makeStep({
      name: 'codex-step',
      type: 'agent',
      agent: 'codex-worker',
      task: 'Fix the bug',
      command: undefined,
    });
    const agentMap = new Map([['codex-worker', agent]]);

    const result = await executor.executeOne(step, agentMap);
    expect(spawner.spawnAgent).toHaveBeenCalledWith(
      agent,
      'Fix the bug',
      expect.objectContaining({ cwd: '/tmp/test-project' })
    );
    expect(result.status).toBe('completed');
  });

  it('fails when agent is not found in agentMap', async () => {
    const executor = createExecutor();
    const step = makeStep({
      name: 'orphan',
      type: 'agent',
      agent: 'missing-agent',
      task: 'Do stuff',
      command: undefined,
    });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not found');
  });
});

// ── 3. Interactive agent step ────────────────────────────────────────────────

describe('StepExecutor — interactive agent steps', () => {
  it('spawns a claude lead via spawnInteractive', async () => {
    const spawner = mockSpawner();
    const executor = createExecutor({ processSpawner: spawner });
    const agent = makeAgent({ cli: 'claude', name: 'lead-agent' });
    const step = makeStep({
      name: 'lead-step',
      type: 'agent',
      agent: 'lead-agent',
      task: 'Coordinate work',
      command: undefined,
    });
    const agentMap = new Map([['lead-agent', agent]]);

    const result = await executor.executeOne(step, agentMap);
    expect(spawner.spawnInteractive).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('defaults interactive agent steps without retries to one retry', () => {
    const step = makeStep({
      name: 'lead-step',
      type: 'agent',
      agent: 'lead-agent',
      task: 'Coordinate work',
      command: undefined,
    });
    const agent = makeAgent({ cli: 'claude', name: 'lead-agent' });

    expect(resolveStepMaxRetries(step, undefined, agent)).toBe(1);
  });

  it('respects explicit retries: 0 on interactive agent steps', () => {
    const step = makeStep({
      name: 'lead-step',
      type: 'agent',
      agent: 'lead-agent',
      task: 'Coordinate work',
      command: undefined,
      retries: 0,
    });
    const agent = makeAgent({ cli: 'claude', name: 'lead-agent' });

    expect(resolveStepMaxRetries(step, undefined, agent)).toBe(0);
  });
});

// ── 4. Step timeout handling ─────────────────────────────────────────────────

describe('StepExecutor — timeout handling', () => {
  it('passes timeoutMs through to process spawner', async () => {
    const spawner = mockSpawner();
    const executor = createExecutor({ processSpawner: spawner });
    const step = makeStep({ command: 'sleep 60', timeoutMs: 5000 });

    await executor.executeOne(step, new Map());
    expect(spawner.spawnShell).toHaveBeenCalledWith('sleep 60', expect.objectContaining({ timeoutMs: 5000 }));
  });

  it('fails step when spawn rejects due to timeout', async () => {
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => {
          throw new Error('Process timed out');
        }),
      }),
    });
    const step = makeStep({ command: 'sleep 60', timeoutMs: 100 });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
  });
});

// ── 5. Step dependency resolution (dependsOn) ────────────────────────────────

describe('StepExecutor — dependency resolution', () => {
  it('returns only steps whose deps are all completed', () => {
    const executor = createExecutor();
    const steps = [
      makeStep({ name: 'a' }),
      makeStep({ name: 'b', dependsOn: ['a'] }),
      makeStep({ name: 'c', dependsOn: ['a', 'b'] }),
    ];
    const statuses = new Map<string, WorkflowStepStatus>([
      ['a', 'completed'],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
    const ready = executor.findReady(steps, statuses);
    expect(ready.map((s) => s.name)).toEqual(['b']);
  });

  it('treats skipped deps as satisfied', () => {
    const executor = createExecutor();
    const steps = [makeStep({ name: 'a' }), makeStep({ name: 'b', dependsOn: ['a'] })];
    const statuses = new Map<string, WorkflowStepStatus>([
      ['a', 'skipped'],
      ['b', 'pending'],
    ]);
    const ready = executor.findReady(steps, statuses);
    expect(ready.map((s) => s.name)).toEqual(['b']);
  });

  it('returns steps with no deps when all are pending', () => {
    const executor = createExecutor();
    const steps = [makeStep({ name: 'a' }), makeStep({ name: 'b', dependsOn: ['a'] })];
    const statuses = new Map<string, WorkflowStepStatus>([
      ['a', 'pending'],
      ['b', 'pending'],
    ]);
    const ready = executor.findReady(steps, statuses);
    expect(ready.map((s) => s.name)).toEqual(['a']);
  });

  it('returns nothing when all deps are failed', () => {
    const executor = createExecutor();
    const steps = [makeStep({ name: 'a' }), makeStep({ name: 'b', dependsOn: ['a'] })];
    const statuses = new Map<string, WorkflowStepStatus>([
      ['a', 'failed'],
      ['b', 'pending'],
    ]);
    const ready = executor.findReady(steps, statuses);
    expect(ready.map((s) => s.name)).toEqual([]);
  });
});

// ── 6. Step output capture and storage ───────────────────────────────────────

describe('StepExecutor — output capture', () => {
  it('persists step output after successful completion', async () => {
    const deps = makeDeps();
    const executor = new StepExecutor(deps);
    const step = makeStep({ command: 'echo result-data' });

    await executor.executeOne(step, new Map());
    expect(deps.persistStepOutput).toHaveBeenCalledWith(
      'run-001',
      'step-1',
      expect.stringContaining('hello')
    );
  });

  it('persists step row status on completion', async () => {
    const deps = makeDeps();
    const executor = new StepExecutor(deps);
    const step = makeStep({ command: 'echo ok' });

    await executor.executeOne(step, new Map());
    expect(deps.persistStepRow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'completed' })
    );
  });

  it('captures output on failure', async () => {
    const deps = makeDeps({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => ({ output: 'error: not found', exitCode: 1 })),
      }),
    });
    const executor = new StepExecutor(deps);
    const step = makeStep({ command: 'bad-command' });
    const result = await executor.executeOne(step, new Map());
    expect(result.output).toContain('error: not found');
  });

  it('suppresses output when captureOutput is false', async () => {
    const executor = createExecutor();
    const step = makeStep({ command: 'echo secret', captureOutput: false });
    const result = await executor.executeOne(step, new Map());
    expect(result.output).toContain('Command completed');
    expect(result.output).not.toContain('hello');
  });
});

// ── 7. Step retry on failure ─────────────────────────────────────────────────

describe('StepExecutor — retry logic', () => {
  // Note: monitorStep retries on thrown errors (spawn failures), not on non-zero exit codes.
  // Non-zero exit codes are handled by toCompletionResult and produce immediate failure.

  it('retries when spawn throws an error', async () => {
    let attempt = 0;
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => {
          attempt++;
          if (attempt < 3) throw new Error('connection refused');
          return { output: 'ok', exitCode: 0 };
        }),
      }),
    });
    const step = makeStep({ command: 'flaky', retries: 3 });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('completed');
    expect(result.retries).toBe(2);
  });

  it('fails after exhausting retries on thrown errors', async () => {
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => {
          throw new Error('always fails');
        }),
      }),
    });
    const step = makeStep({ command: 'always-fail', retries: 2 });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('failed');
    expect(result.retries).toBe(2);
    expect(result.error).toContain('always fails');
  });

  it('does not retry on non-zero exit code (immediate failure)', async () => {
    const spawnShell = vi.fn(async () => ({ output: 'fail', exitCode: 1 }));
    const executor = createExecutor({
      processSpawner: mockSpawner({ spawnShell }),
    });
    const step = makeStep({ command: 'bad', retries: 3 });
    const result = await executor.executeOne(step, new Map());
    expect(result.status).toBe('failed');
    // Called only once — no retries for clean non-zero exits
    expect(spawnShell).toHaveBeenCalledTimes(1);
  });

  it('calls onStepRetried callback on each retry', async () => {
    const onStepRetried = vi.fn();
    let attempt = 0;
    const executor = createExecutor({
      onStepRetried,
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => {
          attempt++;
          if (attempt < 2) throw new Error('transient');
          return { output: 'ok', exitCode: 0 };
        }),
      }),
    });
    const step = makeStep({ command: 'flaky', retries: 2 });
    await executor.executeOne(step, new Map());
    expect(onStepRetried).toHaveBeenCalledTimes(1);
  });
});

// ── 8. Process spawner — command building ────────────────────────────────────

describe('ProcessSpawner — buildCommand', () => {
  it('builds claude CLI command', () => {
    const spawner = createProcessSpawner({ cwd: '/tmp' });
    const agent = makeAgent({ cli: 'claude', name: 'claude-worker' });
    const cmd = spawner.buildCommand(agent, 'Do the task');
    expect(cmd.bin).toBe('claude');
    expect(cmd.args).toContain('Do the task');
  });

  it('builds codex CLI command', () => {
    const spawner = createProcessSpawner({ cwd: '/tmp' });
    const agent = makeAgent({ cli: 'codex', name: 'codex-worker' });
    const cmd = spawner.buildCommand(agent, 'Fix bug');
    expect(cmd.bin).toBe('codex');
    expect(cmd.args).toContain('Fix bug');
  });

  it('builds aider CLI command', () => {
    const spawner = createProcessSpawner({ cwd: '/tmp' });
    const agent = makeAgent({ cli: 'aider', name: 'aider-worker' });
    const cmd = spawner.buildCommand(agent, 'Refactor');
    expect(cmd.bin).toBe('aider');
    expect(cmd.args).toContain('Refactor');
  });

  it('builds gemini CLI command', () => {
    const spawner = createProcessSpawner({ cwd: '/tmp' });
    const agent = makeAgent({ cli: 'gemini', name: 'gemini-worker' });
    const cmd = spawner.buildCommand(agent, 'Analyze');
    expect(cmd.bin).toBe('gemini');
    expect(cmd.args).toContain('Analyze');
  });
});

// ── 9. executeAll — DAG orchestration ────────────────────────────────────────

describe('StepExecutor — executeAll', () => {
  it('executes steps in dependency order', async () => {
    const order: string[] = [];
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => {
          return { output: 'ok', exitCode: 0 };
        }),
      }),
      onStepStarted: vi.fn((step) => {
        order.push(step.name);
      }),
    });
    const steps = [
      makeStep({ name: 'a', command: 'echo a' }),
      makeStep({ name: 'b', command: 'echo b', dependsOn: ['a'] }),
    ];

    const results = await executor.executeAll(steps, new Map());
    expect(results.size).toBe(2);
    expect(order).toEqual(['a', 'b']);
    expect(results.get('a')?.status).toBe('completed');
    expect(results.get('b')?.status).toBe('completed');
  });

  it('skips downstream steps on fail-fast', async () => {
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => ({ output: 'err', exitCode: 1 })),
      }),
      markDownstreamSkipped: vi.fn(),
    });
    const steps = [
      makeStep({ name: 'a', command: 'fail' }),
      makeStep({ name: 'b', command: 'echo b', dependsOn: ['a'] }),
    ];

    await expect(executor.executeAll(steps, new Map(), { strategy: 'fail-fast' })).rejects.toThrow(
      'Step "a" failed'
    );
  });

  it('continues past failures with continue strategy', async () => {
    let callCount = 0;
    const executor = createExecutor({
      processSpawner: mockSpawner({
        spawnShell: vi.fn(async () => {
          callCount++;
          if (callCount === 1) return { output: 'err', exitCode: 1 };
          return { output: 'ok', exitCode: 0 };
        }),
      }),
      markDownstreamSkipped: vi.fn(),
    });
    const steps = [
      makeStep({ name: 'a', command: 'fail' }),
      makeStep({ name: 'c', command: 'echo c' }), // no dependency on a
    ];

    const results = await executor.executeAll(steps, new Map(), { strategy: 'continue' });
    expect(results.get('a')?.status).toBe('failed');
    expect(results.get('c')?.status).toBe('completed');
  });
});
