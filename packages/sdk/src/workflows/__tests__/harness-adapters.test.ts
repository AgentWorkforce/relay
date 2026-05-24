import { describe, expect, it } from 'vitest';

import { buildModelArgs, registerHarnessAdapter } from '../../cli-registry.js';
import { WorkflowBuilder } from '../builder.js';
import { buildCommand } from '../process-spawner.js';
import { WorkflowRunner } from '../runner.js';

describe('workflow harness adapters', () => {
  it('lets SDK callers register a harness command adapter', () => {
    registerHarnessAdapter('unit-harness-a', {
      binaries: ['unit-agent'],
      nonInteractiveArgs: ['run', '--prompt', '{task}', '{args}'],
      modelArgs: ['-m', '{model}'],
    });

    const modelArgs = buildModelArgs('unit-harness-a', 'model-1');
    expect(modelArgs).toEqual(['-m', 'model-1']);
    expect(buildCommand('unit-harness-a', modelArgs, 'do the work')).toEqual([
      'unit-agent',
      'run',
      '--prompt',
      'do the work',
      '-m',
      'model-1',
    ]);
  });

  it('serializes workflow-local harnesses from the TypeScript builder', () => {
    const config = new WorkflowBuilder('custom-harness')
      .harness('unit-harness-b', {
        binary: 'unit-b',
        nonInteractiveArgs: ['--task', '{{task}}', '{{args}}'],
        modelArgs: ['--model-id', '{{model}}'],
      })
      .agent('worker', { cli: 'unit-harness-b', interactive: false, model: 'model-b' })
      .step('work', { agent: 'worker', task: 'ship it' })
      .toConfig();

    expect(config.harnesses?.['unit-harness-b']).toEqual({
      binary: 'unit-b',
      nonInteractiveArgs: ['--task', '{{task}}', '{{args}}'],
      modelArgs: ['--model-id', '{{model}}'],
    });
  });

  it('registers harnesses declared in parsed YAML', () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    runner.parseYamlString(`
version: "1.0"
name: yaml-harness
swarm:
  pattern: dag
harnesses:
  unit-harness-c:
    binary: unit-c
    nonInteractiveArgs: ["exec", "{task}", "{args}"]
    modelArgs: ["--m", "{model}"]
agents:
  - name: worker
    cli: unit-harness-c
    interactive: false
workflows:
  - name: main
    steps:
      - name: work
        agent: worker
        task: do it
`);

    expect(buildCommand('unit-harness-c', buildModelArgs('unit-harness-c', 'model-c'), 'do it')).toEqual([
      'unit-c',
      'exec',
      'do it',
      '--m',
      'model-c',
    ]);
  });
});
