import { workflow } from '@agent-relay/sdk/workflows';

await workflow('relay-long-term-sdk-build-fix')
  .description('Diagnose and implement the long-term repo-level fix for SDK build/tool resolution in clean checkouts.')
  .pattern('dag')
  .channel('wf-relay-long-term-sdk-build-fix')
  .maxConcurrency(2)
  .timeout(3600000)
  .agent('impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Repo build-system implementer',
    retries: 2,
  })
  .agent('reviewer', {
    cli: 'codex',
    preset: 'reviewer',
    role: 'Build-system reviewer',
    retries: 1,
  })
  .step('read-plan', {
    type: 'deterministic',
    command: 'cat workflows/PLAN-long-term-sdk-build-fix.md',
    captureOutput: true,
    failOnError: true,
  })
  .step('implement', {
    agent: 'impl',
    dependsOn: ['read-plan'],
    task: `Implement the best long-term repo-level fix for SDK build/tool resolution in clean checkouts.\n\nPlan:\n{{steps.read-plan.output}}\n\nRequirements:\n- prefer a structural repo/package fix over workflow-only hacks\n- keep edits narrow and validate from a clean checkout perspective\n- write code to disk\n- end by printing CHANGES_COMPLETE`,
    verification: { type: 'exit_code' },
    retries: 2,
  })
  .step('review', {
    agent: 'reviewer',
    dependsOn: ['implement'],
    task: `Review the long-term SDK build fix. End with REVIEW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    retries: 1,
  })
  .run({ cwd: process.cwd() });
