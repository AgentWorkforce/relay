import { workflow, createWorkflowRenderer } from '@agent-relay/sdk/workflows';

/**
 * Minimal smoke test for the listr2 + chalk workflow output.
 * Runs fast deterministic steps plus one quick agent step so you can
 * see spinners, completions, and the final summary table in action.
 */

const renderer = createWorkflowRenderer();

const [result] = await Promise.all([
  workflow('test-output')
  .description('Smoke test for polished workflow output (listr2 + chalk)')
  .pattern('dag')
  .channel('wf-test-output')
  .maxConcurrency(4)
  .timeout(300000)

  .agent('verifier', { cli: 'claude', preset: 'worker', role: 'Confirms env details look healthy.' })

  // Fast parallel deterministic steps — exercises concurrent spinner rendering
  .step('check-node', {
    type: 'deterministic',
    command: 'node --version',
    captureOutput: true,
  })
  .step('check-git', {
    type: 'deterministic',
    command: 'git branch --show-current',
    captureOutput: true,
  })
  .step('check-sdk', {
    type: 'deterministic',
    command: 'node -p "JSON.parse(require(\'fs\').readFileSync(\'packages/sdk/package.json\',\'utf8\')).version"',
    captureOutput: true,
  })

  // One agent step — exercises the spinner + owner-assigned rendering
  .step('verify', {
    agent: 'verifier',
    dependsOn: ['check-node', 'check-git', 'check-sdk'],
    task: `Confirm the following environment details look healthy and print a one-line summary.

Node version: {{steps.check-node.output}}
Current branch: {{steps.check-git.output}}
SDK version: {{steps.check-sdk.output}}`,
    verification: { type: 'exit_code' },
  })

  .run({ onEvent: renderer.onEvent }),
  renderer.start(),
]);
renderer.unmount();

console.log('Result:', result.status);
