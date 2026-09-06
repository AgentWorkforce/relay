import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels } from '@agent-relay/sdk';

await workflow('workflow-hardening-investigation')
  .description('Diagnose and harden workflow execution issues across planning, checkout scoping, environment drift, and validation/build observability.')
  .pattern('dag')
  .channel('wf-workflow-hardening')
  .maxConcurrency(3)
  .timeout(3600000)

  .agent('planner', {
    cli: 'claude',
    preset: 'lead',
    role: 'Workflow planning and failure-analysis researcher',
    model: ClaudeModels.SONNET,
    retries: 2,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Workflow hardening implementer',
    retries: 2,
  })
  .agent('reviewer', {
    cli: 'codex',
    preset: 'reviewer',
    role: 'Workflow hardening reviewer',
    retries: 1,
  })

  .step('capture-env', {
    type: 'deterministic',
    command: `
      set -e
      echo 'PWD='$PWD
      echo 'PATH='$PATH
      echo 'agent-relay versions:'
      which -a agent-relay || true
      agent-relay --version || true
      echo 'git branch:'
      git rev-parse --abbrev-ref HEAD
      echo 'dirty:'
      git status --short || true
      echo 'has .agent-relay?'
      [ -d .agent-relay ] && echo yes || echo no
      echo 'has .trajectories?'
      [ -d .trajectories ] && echo yes || echo no
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('read-plan-doc', {
    type: 'deterministic',
    command: 'cat workflows/PLAN-workflow-hardening.md',
    captureOutput: true,
    failOnError: true,
  })

  .step('plan', {
    agent: 'planner',
    dependsOn: ['capture-env', 'read-plan-doc'],
    task: `Create a concise workflow-hardening plan for this repo.

Plan doc:
{{steps.read-plan-doc.output}}

Current environment:
{{steps.capture-env.output}}

Return sections:
1. WORKFLOW_FLAWS
2. ENVIRONMENT_SPECIFIC_ISSUES
3. REPO_TOOLING_ISSUES
4. IMPLEMENTATION_PLAN
5. VALIDATION_PLAN

End with PLAN_COMPLETE.`,
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    retries: 2,
  })

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['plan'],
    task: `Implement the workflow hardening plan in the current checkout/worktree.

Plan:
{{steps.plan.output}}

Requirements:
- keep edits focused on workflow reliability, diagnostics, and validation clarity
- prefer current-checkout semantics over hard-coded paths
- add/adjust files needed to make workflow runs easier to debug and more deterministic
- write code/files to disk
- end by printing CHANGES_COMPLETE`,
    verification: { type: 'exit_code' },
    retries: 2,
  })

  .step('verify-diff', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `
      set -e
      if git diff --quiet; then
        echo NO_CHANGES_DETECTED
        exit 1
      fi
      git diff --stat
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['plan', 'verify-diff'],
    task: `Review the workflow hardening changes.

Plan:
{{steps.plan.output}}

Diff summary:
{{steps.verify-diff.output}}

Return:
- PASS_FAIL
- what workflow flaws were addressed
- what environment-specific issues remain out of scope
- what repo/tooling follow-ups still remain

End with REVIEW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    retries: 1,
  })

  .run({ cwd: process.cwd() });
