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

  .agent('lead', { cli: 'claude', role: 'Verifies the output looks good.' })

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
    command: 'node -e "import(\'./packages/sdk/package.json\', {assert:{type:\'json\'}}).then(m=>console.log(\'sdk v\'+m.default.version))"',
    captureOutput: true,
  })

  // One agent step — exercises the spinner + owner-assigned rendering
  .step('verify', {
    agent: 'lead',
    dependsOn: ['check-node', 'check-git', 'check-sdk'],
    task: `You are verifying the test run looks healthy.

Node version: {{steps.check-node.output}}
Current branch: {{steps.check-git.output}}
SDK version: {{steps.check-sdk.output}}

Confirm everything looks normal in one sentence.`,
  })

  .run({ onEvent: renderer.onEvent }),
  renderer.start(),
]);

console.log('Result:', result.status);
