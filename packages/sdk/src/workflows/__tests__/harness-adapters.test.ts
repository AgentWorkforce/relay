import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  buildModelArgs,
  registerHarnessAdapter,
  restoreHarnessAdapters,
  snapshotHarnessAdapters,
} from '../../cli-registry.js';
import { WorkflowBuilder } from '../builder.js';
import { buildCommand } from '../process-spawner.js';
import { WorkflowRunner } from '../runner.js';
import type { HarnessRuntimeAdapter } from '../../harness-runtime.js';
import type { ProcessBackend } from '../types.js';
import type { CLIHarnessAdapter } from '../../cli-registry.js';

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

  it('types CLI adapters separately from runtime harness adapters', () => {
    const cliAdapter: CLIHarnessAdapter = {
      binary: 'unit-agent',
      nonInteractiveArgs: ['run', '{task}'],
    };
    const runtimeAdapter: HarnessRuntimeAdapter = {
      kind: 'http',
      initHarness: async () => ({ sessionId: 's1', pid: 123 }),
      receiveMessage: async () => undefined,
      sendMessage: async () => undefined,
    };

    expectTypeOf(cliAdapter).toMatchTypeOf<CLIHarnessAdapter>();
    expectTypeOf(runtimeAdapter).toMatchTypeOf<HarnessRuntimeAdapter>();
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

  it('uses workflow-scoped harnesses for process backend command resolution', async () => {
    const commands: string[] = [];
    const backend: ProcessBackend = {
      async createEnvironment(label) {
        return {
          id: label,
          homeDir: '/tmp',
          async exec(command) {
            commands.push(command);
            return { output: 'done', exitCode: 0 };
          },
          async uploadFile() {},
          async destroy() {},
        };
      },
    };
    const runner = new WorkflowRunner({ cwd: process.cwd(), processBackend: backend });
    const config = runner.parseYamlString(`
version: "1.0"
name: yaml-harness-run
trajectories: false
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
    constraints:
      model: model-c
workflows:
  - name: main
    steps:
      - name: work
        agent: worker
        task: do it
`);

    await runner.execute(config);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('unit-c exec');
    expect(commands[0]).toContain('--m model-c');
    expect(buildModelArgs('unit-harness-c', 'model-c')).toEqual(['--model', 'model-c']);
  });

  it('lets binary override inherited adapter binaries', () => {
    registerHarnessAdapter('company-cursor-wrapper', {
      adapter: 'cursor',
      binary: 'company-cursor',
      searchPaths: ['~/company/bin'],
    });

    expect(buildCommand('company-cursor-wrapper', [], 'do the work')).toEqual([
      'company-cursor',
      '--force',
      '-p',
      'do the work',
    ]);
  });

  it('ignores blank binary overrides when inheriting adapter binaries', () => {
    registerHarnessAdapter('company-cursor-wrapper', {
      adapter: 'cursor',
      binary: '   ',
    });

    expect(buildCommand('company-cursor-wrapper', [], 'do the work')).toEqual([
      'cursor-agent',
      '--force',
      '-p',
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
