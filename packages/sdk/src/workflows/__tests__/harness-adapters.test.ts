import { afterEach, describe, expect, it } from 'vitest';

import {
  buildModelArgs,
  registerHarnessAdapter,
  restoreHarnessAdapters,
  snapshotHarnessAdapters,
} from '../../cli-registry.js';
import { WorkflowBuilder } from '../builder.js';
import { buildCommand } from '../process-spawner.js';
import { WorkflowRunner } from '../runner.js';

const registrySnapshot = snapshotHarnessAdapters();

describe('workflow harness adapters', () => {
  afterEach(() => {
    restoreHarnessAdapters(registrySnapshot);
  });

  it('builds built-in commands from declarative harness config', () => {
    expect(buildCommand('codex', [], 'do the work')).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      'do the work',
    ]);
  });

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

  it('keeps harnesses declared in parsed YAML scoped to workflow execution', () => {
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

    expect(buildModelArgs('unit-harness-c', 'model-c')).toEqual(['--model', 'model-c']);
    expect(() => buildCommand('unit-harness-c', [], 'do it')).toThrow(
      'Unknown or non-executable CLI: unit-harness-c'
    );
  });

  it('lets binary override inherited adapter binaries', () => {
    registerHarnessAdapter('company-codex-wrapper', {
      adapter: 'codex',
      binary: 'company-codex',
      searchPaths: ['~/company/bin'],
    });

    expect(buildCommand('company-codex-wrapper', [], 'do the work')).toEqual([
      'company-codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      'do the work',
    ]);
  });

  it('rejects empty base harness keys after model suffix normalization', () => {
    expect(() =>
      registerHarnessAdapter(':bad', {
        binary: 'bad',
      })
    ).toThrow('Harness name must be a non-empty string');
  });
});
