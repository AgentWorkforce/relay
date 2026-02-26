/**
 * Workflow model-flag integration tests.
 *
 * Verifies that constraints.model is forwarded to CLI invocations for
 * non-interactive workflow agents.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness, type WorkflowRunResult } from './utils/workflow-harness.js';
import { assertRunCompleted, assertStepCompleted } from './utils/workflow-assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function createWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-models-'));
}

function skipIfRateLimited(t: TestContext, result: WorkflowRunResult): boolean {
  const errors = [
    result.run.error ?? '',
    ...result.events
      .filter((event): event is typeof event & { error: string } => {
        return 'error' in event && typeof event.error === 'string';
      })
      .map((event) => event.error),
  ];
  const rateLimitError = errors.find((error) => /rate limit exceeded|too many requests|429/iu.test(error));
  if (!rateLimitError) return false;
  t.skip(`Relaycast API rate limit in test environment: ${rateLimitError}`);
  return true;
}

function installArgCaptureScript(
  harness: WorkflowRunnerHarness,
  cliName: 'claude' | 'codex',
  captureFile: string,
  output: string
): void {
  const fakeCliDir = harness.getRelayEnv().PATH?.split(path.delimiter)[0];
  assert.ok(fakeCliDir, 'Expected fake CLI directory in PATH');

  const script = `#!/usr/bin/env bash
CAPTURE_FILE=${JSON.stringify(captureFile)}
printf '%s\n' "$@" > "$CAPTURE_FILE"
echo ${JSON.stringify(output)}
`;

  fs.writeFileSync(path.join(fakeCliDir, cliName), script, { mode: 0o755 });
}

function makeConfig(cli: 'claude' | 'codex', model: string, output: string): RelayYamlConfig {
  return {
    version: '1',
    name: `test-workflow-models-${cli}`,
    description: 'Model forwarding integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli, interactive: false, constraints: { model } }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'step-model',
            agent: 'worker',
            task: 'Print DONE',
            verification: { type: 'output_contains', value: output },
          },
        ],
      },
    ],
  };
}

function assertModelFlag(captureFile: string, expectedModel: string): void {
  const args = fs
    .readFileSync(captureFile, 'utf8')
    .split('\n')
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);

  const modelFlagIndex = args.indexOf('--model');
  assert.notEqual(modelFlagIndex, -1, `Expected --model flag in args: ${JSON.stringify(args)}`);
  assert.equal(
    args[modelFlagIndex + 1],
    expectedModel,
    `Expected model value "${expectedModel}" after --model, got ${JSON.stringify(args)}`
  );
}

test('workflow-models: forwards constraints.model for claude', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const captureFile = path.join(cwd, 'claude-args.txt');
  const output = 'DONE_CLAUDE';
  const model = 'claude-sonnet-4-5';
  const harness = new WorkflowRunnerHarness();
  await harness.start();
  installArgCaptureScript(harness, 'claude', captureFile, output);

  try {
    const result = await harness.runWorkflow(makeConfig('claude', model, output), undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-model');
    assertModelFlag(captureFile, model);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-models: forwards constraints.model for codex', { timeout: 60_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const captureFile = path.join(cwd, 'codex-args.txt');
  const output = 'DONE_CODEX';
  const model = 'gpt-5-codex';
  const harness = new WorkflowRunnerHarness();
  await harness.start();
  installArgCaptureScript(harness, 'codex', captureFile, output);

  try {
    const result = await harness.runWorkflow(makeConfig('codex', model, output), undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-model');
    assertModelFlag(captureFile, model);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
