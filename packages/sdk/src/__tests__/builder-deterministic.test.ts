/**
 * Tests for deterministic and worktree step support in WorkflowBuilder.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { workflow } from '../workflows/builder.js';

describe('deterministic/worktree steps in builder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deterministic step emits correct config', () => {
    const config = workflow('test')
      .agent('worker', { cli: 'claude' })
      .step('read-files', {
        type: 'deterministic',
        command: 'cat src/index.ts',
        verification: { type: 'exit_code', value: '0' },
      })
      .step('build', { agent: 'worker', task: 'Build the project' })
      .toConfig();

    const steps = config.workflows![0].steps;
    expect(steps).toHaveLength(2);

    // Deterministic step
    expect(steps[0].name).toBe('read-files');
    expect(steps[0].type).toBe('deterministic');
    expect(steps[0].command).toBe('cat src/index.ts');
    expect(steps[0].agent).toBeUndefined();
    expect(steps[0].task).toBeUndefined();
    expect(steps[0].verification).toEqual({ type: 'exit_code', value: '0' });

    // Agent step
    expect(steps[1].name).toBe('build');
    expect(steps[1].agent).toBe('worker');
    expect(steps[1].task).toBe('Build the project');
    expect(steps[1].type).toBeUndefined();
  });

  it('deterministic step with all options', () => {
    const config = workflow('test')
      .agent('worker', { cli: 'claude' })
      .step('run-cmd', {
        type: 'deterministic',
        command: 'npm test',
        captureOutput: true,
        failOnError: false,
        dependsOn: ['build'],
        timeoutMs: 30000,
      })
      .step('final', { agent: 'worker', task: 'Finalize' })
      .toConfig();

    const step = config.workflows![0].steps[0];
    expect(step.captureOutput).toBe(true);
    expect(step.failOnError).toBe(false);
    expect(step.dependsOn).toEqual(['build']);
    expect(step.timeoutMs).toBe(30000);
  });

  it('worktree step emits correct config', () => {
    const config = workflow('test')
      .agent('worker', { cli: 'claude' })
      .step('setup-worktree', {
        type: 'worktree',
        branch: 'feature/new',
        baseBranch: 'main',
        path: '.worktrees/feature-new',
        createBranch: true,
      })
      .step('work', { agent: 'worker', task: 'Do work', dependsOn: ['setup-worktree'] })
      .toConfig();

    const step = config.workflows![0].steps[0];
    expect(step.type).toBe('worktree');
    expect(step.branch).toBe('feature/new');
    expect(step.baseBranch).toBe('main');
    expect(step.path).toBe('.worktrees/feature-new');
    expect(step.createBranch).toBe(true);
    expect(step.agent).toBeUndefined();
    expect(step.command).toBeUndefined();
  });

  it('deterministic-only workflow does not require agents', () => {
    const config = workflow('infra')
      .step('lint', { type: 'deterministic', command: 'npm run lint' })
      .step('test', {
        type: 'deterministic',
        command: 'npm test',
        dependsOn: ['lint'],
      })
      .toConfig();

    expect(config.agents).toHaveLength(0);
    expect(config.workflows![0].steps).toHaveLength(2);
  });

  it('deterministic step without command throws', () => {
    expect(() => {
      workflow('test').step('bad', { type: 'deterministic' } as any);
    }).toThrow('deterministic steps must have a command');
  });

  it('deterministic step with agent throws', () => {
    expect(() => {
      workflow('test').step('bad', { type: 'deterministic', command: 'ls', agent: 'x', task: 'y' } as any);
    }).toThrow('deterministic steps must not have agent or task');
  });

  it('agent step without agent/task throws', () => {
    expect(() => {
      workflow('test').step('bad', {} as any);
    }).toThrow('Agent steps must have both agent and task');
  });

  it('agent steps without any agent definition throws', () => {
    expect(() => {
      workflow('test').step('work', { agent: 'worker', task: 'Do work' }).toConfig();
    }).toThrow('Workflow must have at least one agent when using agent steps');
  });

  it('toYaml includes deterministic steps', () => {
    const yamlStr = workflow('test').step('check', { type: 'deterministic', command: 'echo hello' }).toYaml();

    expect(yamlStr).toContain('type: deterministic');
    expect(yamlStr).toContain('command: echo hello');
  });

  it('preserves diagnosticAgent in agent step verification', () => {
    const config = workflow('traceback')
      .agent('generator', { cli: 'claude' })
      .agent('reviewer', { cli: 'claude' })
      .step('generate', {
        agent: 'generator',
        task: 'Implement the change',
        verification: {
          type: 'custom',
          value: 'npx nango compile',
          diagnosticAgent: 'reviewer',
        },
        retries: 2,
      })
      .toConfig();

    expect(config.workflows?.[0].steps[0].verification).toEqual({
      type: 'custom',
      value: 'npx nango compile',
      diagnosticAgent: 'reviewer',
    });
  });

  it('throws when diagnosticAgent is not in the agents list', () => {
    expect(() => {
      workflow('traceback')
        .agent('generator', { cli: 'claude' })
        .step('generate', {
          agent: 'generator',
          task: 'Implement the change',
          verification: {
            type: 'custom',
            value: 'npx nango compile',
            diagnosticAgent: 'reviewer',
          },
          retries: 2,
        })
        .toConfig();
    }).toThrow('Step "generate" references unknown diagnosticAgent "reviewer"');
  });

  it('warns when diagnosticAgent is configured without step retries', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    workflow('traceback')
      .agent('generator', { cli: 'claude' })
      .agent('reviewer', { cli: 'claude' })
      .step('generate', {
        agent: 'generator',
        task: 'Implement the change',
        verification: {
          type: 'custom',
          value: 'npx nango compile',
          diagnosticAgent: 'reviewer',
        },
      })
      .toConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      'Step "generate": diagnosticAgent configured but no retries — diagnostic will never run'
    );
  });
});
