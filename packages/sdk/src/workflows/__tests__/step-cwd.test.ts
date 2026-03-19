import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn(),
}));

const { WorkflowRunner } = await import('../runner.js');

describe('WorkflowRunner step cwd resolution', () => {
  it('prefers step.cwd over agent.cwd and runner cwd', () => {
    const runnerRoot = '/runner-root';
    const runner = new WorkflowRunner({ cwd: runnerRoot });

    const resolved = (runner as any).resolveEffectiveCwd(
      { name: 'generate', agent: 'worker', task: 'Generate', cwd: 'steps/generate' },
      { name: 'worker', cli: 'claude', cwd: 'agents/worker' },
    );

    expect(resolved).toBe(path.resolve(runnerRoot, 'steps/generate'));
  });

  it('respects step.cwd for deterministic steps', () => {
    const runnerRoot = '/runner-root';
    const runner = new WorkflowRunner({ cwd: runnerRoot });

    const resolved = (runner as any).resolveEffectiveCwd({
      name: 'scaffold',
      type: 'deterministic',
      command: 'mkdir -p out',
      cwd: 'deterministic/setup',
    });

    expect(resolved).toBe(path.resolve(runnerRoot, 'deterministic/setup'));
  });

  it('falls back through step.cwd to step.workdir to agent.cwd to runner.cwd', () => {
    const runnerRoot = '/runner-root';
    const namedPath = '/named/workdir';
    const runner = new WorkflowRunner({ cwd: runnerRoot });
    (runner as any).resolvedPaths.set('generated', namedPath);

    const agentDef = { name: 'worker', cli: 'claude', cwd: 'agents/worker' } as const;

    expect(
      (runner as any).resolveEffectiveCwd(
        { name: 's1', agent: 'worker', task: 'Do work', cwd: 'steps/explicit', workdir: 'generated' },
        agentDef,
      ),
    ).toBe(path.resolve(runnerRoot, 'steps/explicit'));

    expect(
      (runner as any).resolveEffectiveCwd(
        { name: 's2', agent: 'worker', task: 'Do work', workdir: 'generated' },
        agentDef,
      ),
    ).toBe(namedPath);

    expect(
      (runner as any).resolveEffectiveCwd({ name: 's3', agent: 'worker', task: 'Do work' }, agentDef),
    ).toBe(path.resolve(runnerRoot, 'agents/worker'));

    expect(
      (runner as any).resolveEffectiveCwd({ name: 's4', type: 'deterministic', command: 'pwd' }),
    ).toBe(runnerRoot);
  });
});
