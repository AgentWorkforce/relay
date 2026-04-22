import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

await workflow('design-relay-clean-room-e2e-validation')
  .description('Meta-workflow that designs the right clean-environment end-to-end validation workflow for agent-relay install/bootstrap/messaging fixes, choosing the proving environment and evidence plan before implementation.')
  .pattern('supervisor')
  .channel('wf-relay-e2e-meta')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'Lead workflow architect choosing the proving strategy and acceptance contract',
    model: ClaudeModels.OPUS,
    retries: 2,
  })
  .agent('research-a', {
    cli: 'codex',
    preset: 'analyst',
    role: 'Research clean-environment options and relay install/runtime failure modes',
    model: CodexModels.GPT_5_4,
    retries: 2,
  })
  .agent('research-b', {
    cli: 'codex',
    preset: 'analyst',
    role: 'Research workflow pattern choice, validation phases, and evidence design',
    model: CodexModels.GPT_5_4,
    retries: 2,
  })
  .agent('author', {
    cli: 'claude',
    preset: 'worker',
    role: 'Workflow author for the final clean-room end-to-end validation workflow',
    model: ClaudeModels.SONNET,
    retries: 2,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Reviewer verifying that the authored workflow really proves the original problem is fixed',
    model: ClaudeModels.SONNET,
    retries: 2,
  })

  .step('capture-current-context', {
    type: 'deterministic',
    command: `
      set -e
      cd ~/Projects/AgentWorkforce/relay
      echo '## Relevant existing workflows'
      find workflows -maxdepth 1 -type f | sort | sed 's#^#- #' || true
      echo '\n## Existing fix workflow'
      sed -n '1,260p' /Users/khaliqgant/.openclaw/workspace/relay-fix-workflow.ts
      echo '\n## Running-headless-orchestrator skill excerpt'
      sed -n '1,220p' /Users/khaliqgant/.openclaw/workspace/skills/running-headless-orchestrator/SKILL.md
      echo '\n## Writer skill excerpt'
      sed -n '1,260p' /tmp/skills-review/skills/writing-agent-relay-workflows/SKILL.md
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('research-environment-options', {
    agent: 'research-a',
    dependsOn: ['capture-current-context'],
    task: `Analyze the current relay workflow context and choose the best proving environment for full end-to-end validation of install/bootstrap/messaging fixes.

Context:
{{steps.capture-current-context.output}}

Compare at least these options:
- Docker / container
- cloud-provisioned sandbox / workspace
- fresh local shell with isolated paths

Output sections:
1. ORIGINAL_PROBLEM_CLASS
2. PROVING_ENV_OPTIONS
3. RECOMMENDED_ENV
4. WHY_NOT_THE_OTHERS
5. ACCEPTANCE_SIGNALS

End with ENV_ANALYSIS_COMPLETE.`,
    verification: { type: 'output_contains', value: 'ENV_ANALYSIS_COMPLETE' },
    retries: 2,
  })

  .step('research-workflow-shape', {
    agent: 'research-b',
    dependsOn: ['capture-current-context'],
    task: `Determine the right workflow/swarm shape for a clean-room validation workflow.

Context:
{{steps.capture-current-context.output}}

Requirements:
- do not assume DAG by default
- consider whether a meta-workflow + generated workflow pair is best
- define the required phases to prove the original user-visible bug is actually fixed
- explicitly define what evidence artifacts must be captured

Output sections:
1. PATTERN_DECISION
2. REQUIRED_PHASES
3. EVIDENCE_ARTIFACTS
4. FAILURE_MODES_TO_REPRODUCE
5. REVIEW_CRITERIA

End with SHAPE_ANALYSIS_COMPLETE.`,
    verification: { type: 'output_contains', value: 'SHAPE_ANALYSIS_COMPLETE' },
    retries: 2,
  })

  .step('decide-validation-strategy', {
    agent: 'lead',
    dependsOn: ['research-environment-options', 'research-workflow-shape'],
    task: `Make the final design decision for the clean-room end-to-end validation workflow.

Environment analysis:
{{steps.research-environment-options.output}}

Workflow-shape analysis:
{{steps.research-workflow-shape.output}}

Produce a final design doc with these exact sections:
1. ACCEPTANCE_CONTRACT
2. CHOSEN_PROVING_ENVIRONMENT
3. CHOSEN_PATTERN
4. EXECUTION_PHASES
5. REQUIRED_ARTIFACTS
6. OUTPUT_FILES_TO_AUTHOR

The design must be concrete enough for another agent to author the final workflow file without guessing.
End with DESIGN_COMPLETE.`,
    verification: { type: 'output_contains', value: 'DESIGN_COMPLETE' },
    retries: 2,
  })

  .step('author-final-validation-workflow', {
    agent: 'author',
    dependsOn: ['decide-validation-strategy'],
    task: `Write the final clean-room end-to-end validation workflow into ~/Projects/AgentWorkforce/relay/workflows/relay-clean-room-e2e-validation.ts.

Design:
{{steps.decide-validation-strategy.output}}

Requirements:
- the workflow must explicitly reproduce/capture the original failure class first
- it must validate the fix in a clean environment, not just the current shell
- it must define deterministic artifact capture and a reviewer verdict
- it should use the chosen workflow/swarm pattern from the design
- write only the workflow file to disk

End by printing WORKFLOW_AUTHORED.`,
    verification: { type: 'exit_code' },
    retries: 2,
  })

  .step('verify-authored-workflow', {
    type: 'deterministic',
    dependsOn: ['author-final-validation-workflow'],
    command: `
      set -e
      cd ~/Projects/AgentWorkforce/relay
      test -f workflows/relay-clean-room-e2e-validation.ts
      sed -n '1,260p' workflows/relay-clean-room-e2e-validation.ts
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('review-authored-workflow', {
    agent: 'reviewer',
    dependsOn: ['decide-validation-strategy', 'verify-authored-workflow'],
    task: `Review the authored workflow against the design.

Design:
{{steps.decide-validation-strategy.output}}

Authored workflow:
{{steps.verify-authored-workflow.output}}

Answer with these exact sections:
1. PASS_FAIL
2. WHAT_PROBLEM_IT_PROVES
3. WHAT_EVIDENCE_IT_COLLECTS
4. WHAT_STILL_NEEDS_HUMAN_DECISION

End with REVIEW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    retries: 2,
  })

  .run({ cwd: process.cwd() });
