/**
 * Tests for deterministic and worktree step support in WorkflowBuilder.
 *
 * Run:
 *   npm run build -w packages/sdk && node --test dist/__tests__/builder-deterministic.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { workflow } from '../workflows/builder.js';

test('deterministic step emits correct config', () => {
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
  assert.equal(steps.length, 2);

  // Deterministic step
  assert.equal(steps[0].name, 'read-files');
  assert.equal(steps[0].type, 'deterministic');
  assert.equal(steps[0].command, 'cat src/index.ts');
  assert.equal(steps[0].agent, undefined);
  assert.equal(steps[0].task, undefined);
  assert.deepEqual(steps[0].verification, { type: 'exit_code', value: '0' });

  // Agent step
  assert.equal(steps[1].name, 'build');
  assert.equal(steps[1].agent, 'worker');
  assert.equal(steps[1].task, 'Build the project');
  assert.equal(steps[1].type, undefined);
});

test('deterministic step with all options', () => {
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
  assert.equal(step.captureOutput, true);
  assert.equal(step.failOnError, false);
  assert.deepEqual(step.dependsOn, ['build']);
  assert.equal(step.timeoutMs, 30000);
});

test('worktree step emits correct config', () => {
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
  assert.equal(step.type, 'worktree');
  assert.equal(step.branch, 'feature/new');
  assert.equal(step.baseBranch, 'main');
  assert.equal(step.path, '.worktrees/feature-new');
  assert.equal(step.createBranch, true);
  assert.equal(step.agent, undefined);
  assert.equal(step.command, undefined);
});

test('deterministic-only workflow does not require agents', () => {
  const config = workflow('infra')
    .step('lint', { type: 'deterministic', command: 'npm run lint' })
    .step('test', {
      type: 'deterministic',
      command: 'npm test',
      dependsOn: ['lint'],
    })
    .toConfig();

  assert.equal(config.agents.length, 0);
  assert.equal(config.workflows![0].steps.length, 2);
});

test('deterministic step without command throws', () => {
  assert.throws(
    () => {
      workflow('test')
        .step('bad', { type: 'deterministic' } as any);
    },
    { message: 'deterministic steps must have a command' },
  );
});

test('deterministic step with agent throws', () => {
  assert.throws(
    () => {
      workflow('test')
        .step('bad', { type: 'deterministic', command: 'ls', agent: 'x', task: 'y' } as any);
    },
    { message: 'deterministic steps must not have agent or task' },
  );
});

test('agent step without agent/task throws', () => {
  assert.throws(
    () => {
      workflow('test')
        .step('bad', {} as any);
    },
    { message: 'Agent steps must have both agent and task' },
  );
});

test('agent steps without any agent definition throws', () => {
  assert.throws(
    () => {
      workflow('test')
        .step('work', { agent: 'worker', task: 'Do work' })
        .toConfig();
    },
    { message: 'Workflow must have at least one agent when using agent steps' },
  );
});

test('toYaml includes deterministic steps', () => {
  const yamlStr = workflow('test')
    .step('check', { type: 'deterministic', command: 'echo hello' })
    .toYaml();

  assert.ok(yamlStr.includes('type: deterministic'));
  assert.ok(yamlStr.includes('command: echo hello'));
});
