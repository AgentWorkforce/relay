import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const sdkRoot = 'packages/sdk/src';

  const wf = workflow('cli-observability')
    .description('Add step-level cwd, CLI session collectors, and run summary table to the workflow SDK')
    .pattern('dag')
    .channel('wf-cli-observability')
    .maxConcurrency(4)
    .timeout(1_800_000);

  // ── Agents ──────────────────────────────────────────────────────────────

  wf.agent('architect', {
    cli: 'claude',
    role: 'SDK architect — designs interfaces and coordinates implementation',
    preset: 'lead',
    retries: 2,
  });

  wf.agent('sdk-worker', {
    cli: 'codex',
    role: 'TypeScript SDK developer',
    preset: 'worker',
    retries: 2,
  });

  wf.agent('test-writer', {
    cli: 'codex',
    role: 'Test engineer — writes unit and integration tests',
    preset: 'worker',
    retries: 2,
  });

  // ── Phase 1: Read current source & plan ─────────────────────────────────

  wf.step('read-types', {
    type: 'deterministic',
    command: `cat ${sdkRoot}/workflows/types.ts`,
  });

  wf.step('read-builder', {
    type: 'deterministic',
    command: `cat ${sdkRoot}/workflows/builder.ts`,
  });

  wf.step('read-runner', {
    type: 'deterministic',
    command: `cat ${sdkRoot}/workflows/runner.ts`,
  });

  wf.step('read-spec', {
    type: 'deterministic',
    command: 'cat workflows/specs/cli-observability.md',
  });

  wf.step('plan', {
    agent: 'architect',
    task: `
You are implementing the CLI Observability spec for @agent-relay/sdk.

Read the spec carefully:
{{steps.read-spec.output}}

Current SDK types:
{{steps.read-types.output}}

Current builder API:
{{steps.read-builder.output}}

Current runner API:
{{steps.read-runner.output}}

Produce an implementation plan that covers:
1. Exact files to create/modify in packages/sdk/src/workflows/
2. The CliSessionCollector interface and registry pattern
3. How step-level cwd integrates into the existing resolveAgentCwd / resolveStepWorkdir chain
4. The new step:agent-report event wiring
5. The run summary table formatting logic
6. Test file locations and fixture strategy

Output the plan as a numbered checklist. Do NOT write any code — just the plan.
    `.trim(),
    dependsOn: ['read-types', 'read-builder', 'read-runner', 'read-spec'],
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
  });

  // ── Phase 2: Parallel implementation ────────────────────────────────────

  // 2a. Step-level cwd — types + builder + runner
  wf.step('impl-step-cwd', {
    agent: 'sdk-worker',
    task: `
Implement step-level cwd support in @agent-relay/sdk.

Implementation plan:
{{steps.plan.output}}

Spec:
{{steps.read-spec.output}}

Changes needed:
1. In packages/sdk/src/workflows/types.ts:
   - Add optional \`cwd?: string\` to WorkflowStep type
2. In packages/sdk/src/workflows/builder.ts:
   - Add optional \`cwd?: string\` to AgentStepOptions and DeterministicStepOptions
   - Pass cwd through when constructing step config in the step() method
3. In packages/sdk/src/workflows/runner.ts:
   - In executeAgentStep: resolve effective cwd as step.cwd ?? resolveStepWorkdir(step) ?? resolveAgentCwd(agentDef) ?? this.cwd
   - In executeDeterministicStep: same resolution chain
   - In execNonInteractive: pass resolved cwd to spawn

Keep changes minimal. Do not refactor existing code beyond what is needed.
    `.trim(),
    dependsOn: ['plan'],
    verification: { type: 'exit_code' },
  });

  // 2b. CliSessionCollector interface + registry
  wf.step('impl-collector-interface', {
    agent: 'sdk-worker',
    task: `
Create the CliSessionCollector interface and collector registry.

Implementation plan:
{{steps.plan.output}}

Spec:
{{steps.read-spec.output}}

Create file: packages/sdk/src/workflows/cli-session-collector.ts

This file must export:
1. CliSessionReport interface (cli, sessionId, model, provider, durationMs, cost, tokens, turns, toolCalls, errors, finalStatus, summary)
2. CliSessionQuery interface (cli, cwd, startedAt, completedAt)
3. CliSessionCollector interface (canCollect, collect)
4. createCollector(cli: AgentCli): CliSessionCollector | null — factory that returns the right collector
5. collectCliSession(query: CliSessionQuery): Promise<CliSessionReport | null> — convenience wrapper

Also add the export to packages/sdk/src/workflows/index.ts.

Do NOT implement the individual collectors yet — just the interface, factory skeleton (returning null for now), and convenience wrapper.
    `.trim(),
    dependsOn: ['plan'],
    verification: { type: 'file_exists', value: 'packages/sdk/src/workflows/cli-session-collector.ts' },
  });

  // 2c. OpenCode collector
  wf.step('impl-opencode-collector', {
    agent: 'sdk-worker',
    task: `
Implement the OpenCode session collector.

Implementation plan:
{{steps.plan.output}}

Spec (see section 2b):
{{steps.read-spec.output}}

Collector interface (already created):
{{steps.impl-collector-interface.output}}

Create file: packages/sdk/src/workflows/collectors/opencode.ts

OpenCode stores data in ~/.local/share/opencode/opencode.db (SQLite).

Schema:
- session: id, directory, time_created
- message: id, session_id, time_created, data (JSON with role, modelID, providerID, cost, tokens{total,input,output,reasoning,cache{read,write}}, finish)
- part: id, message_id, session_id, time_created, data (JSON with type, text, name for tool calls)

Matching: Find session where directory = query.cwd AND time_created BETWEEN startedAt-5000 AND completedAt, ORDER BY time_created DESC LIMIT 1.

Use better-sqlite3 for sync reads (it's already a common transitive dep). If the DB doesn't exist or is locked, canCollect() returns false.

Aggregate tokens by summing across all messages. Extract tool calls from parts where data.type includes 'tool'. Extract errors by scanning text parts for lines matching /^Error|error:|Command failed|FAIL/.

Wire it into the factory in cli-session-collector.ts for cli === 'opencode'.
    `.trim(),
    dependsOn: ['impl-collector-interface'],
    verification: { type: 'file_exists', value: 'packages/sdk/src/workflows/collectors/opencode.ts' },
  });

  // 2d. Claude Code collector
  wf.step('impl-claude-collector', {
    agent: 'sdk-worker',
    task: `
Implement the Claude Code session collector.

Implementation plan:
{{steps.plan.output}}

Spec (see section 2c):
{{steps.read-spec.output}}

Collector interface:
{{steps.impl-collector-interface.output}}

Create file: packages/sdk/src/workflows/collectors/claude.ts

Claude Code stores:
1. ~/.claude/history.jsonl — one JSON per line: { display, timestamp (ms), project (abs path), sessionId }
2. ~/.claude/projects/{encoded-path}/{sessionId}.jsonl — full session log, one JSON per line

History matching: Read history.jsonl bottom-up, find entry where project matches query.cwd and timestamp is within [startedAt-5000, completedAt].

Session JSONL format: Each line has type (user, assistant, tool_use, tool_result, system, progress) plus content. Assistant messages may include usage metadata with token counts.

Encode project path the same way Claude Code does (replace / with --, strip leading -).

If files don't exist or aren't readable, canCollect() returns false. Use fs.createReadStream with readline for efficient bottom-up reading of large JSONL files.

Wire it into the factory in cli-session-collector.ts for cli === 'claude'.
    `.trim(),
    dependsOn: ['impl-collector-interface'],
    verification: { type: 'file_exists', value: 'packages/sdk/src/workflows/collectors/claude.ts' },
  });

  // 2e. Codex collector
  wf.step('impl-codex-collector', {
    agent: 'sdk-worker',
    task: `
Implement the Codex session collector.

Implementation plan:
{{steps.plan.output}}

Spec (see section 2d):
{{steps.read-spec.output}}

Collector interface:
{{steps.impl-collector-interface.output}}

Create file: packages/sdk/src/workflows/collectors/codex.ts

Codex stores:
1. ~/.codex/history.jsonl — one JSON per line: { session_id, ts (unix seconds, NOT ms), text }
2. ~/.codex/state_5.sqlite — SQLite with tables:
   - threads: id, cwd, model_provider, tokens_used, created_at, updated_at
   - logs: thread_id, ts, level, message

Matching: Query threads table for cwd = query.cwd AND created_at within the step window. If no SQLite match, fall back to history.jsonl.

Token extraction: threads.tokens_used gives the total. For breakdown, check if the schema has per-field columns.

Error extraction: Query logs where level = 'error' AND thread_id = matched thread.

If files don't exist, canCollect() returns false.

Wire it into the factory in cli-session-collector.ts for cli === 'codex'.
    `.trim(),
    dependsOn: ['impl-collector-interface'],
    verification: { type: 'file_exists', value: 'packages/sdk/src/workflows/collectors/codex.ts' },
  });

  // ── Phase 3: Runner integration ─────────────────────────────────────────

  wf.step('impl-runner-integration', {
    agent: 'sdk-worker',
    task: `
Integrate CLI session collection into the workflow runner.

Implementation plan:
{{steps.plan.output}}

Spec (sections 3a-3d):
{{steps.read-spec.output}}

The collectors are implemented:
- OpenCode: {{steps.impl-opencode-collector.output}}
- Claude: {{steps.impl-claude-collector.output}}
- Codex: {{steps.impl-codex-collector.output}}

Changes to packages/sdk/src/workflows/runner.ts:

1. Add 'step:agent-report' to WorkflowEvent union type with fields: runId, stepName, report (CliSessionReport)

2. Import collectCliSession from ./cli-session-collector

3. In executeAgentStep, after spawnAndWait returns and before completion decision:
   - Record stepStartTime at the top of executeAgentStep
   - Call collectCliSession({ cli: agentDef.cli, cwd: effectiveCwd, startedAt: stepStartTime, completedAt: Date.now() })
   - If report is non-null, emit step:agent-report event
   - Store report in a Map<string, CliSessionReport> keyed by stepName

4. Add persistAgentReport method: write {stepName}.report.json to .agent-relay/step-outputs/{runId}/

5. Enhance logRunSummary to print a table when reports exist:
   - Columns: Step, Status, Model, Cost, Tokens, Duration, Errors
   - Footer row with totals for Cost, Tokens, Duration
   - For failed steps, print first error line indented below

Keep changes surgical — do not refactor existing runner methods.
    `.trim(),
    dependsOn: ['impl-step-cwd', 'impl-opencode-collector', 'impl-claude-collector', 'impl-codex-collector'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 4: Tests ──────────────────────────────────────────────────────

  wf.step('write-tests', {
    agent: 'test-writer',
    task: `
Write tests for the CLI observability features.

Implementation plan:
{{steps.plan.output}}

Runner integration output:
{{steps.impl-runner-integration.output}}

Create the following test files:

1. packages/sdk/src/workflows/__tests__/step-cwd.test.ts
   - Test that step.cwd takes precedence over agent.cwd and runner cwd
   - Test that deterministic steps also respect step.cwd
   - Test fallback chain: step.cwd → step.workdir → agent.cwd → runner.cwd

2. packages/sdk/src/workflows/__tests__/cli-session-collector.test.ts
   - Test collectCliSession returns null for unknown CLI
   - Test canCollect returns false when data store doesn't exist

3. packages/sdk/src/workflows/__tests__/collectors/opencode.test.ts
   - Create a test fixture SQLite DB with known session/message/part rows
   - Test matching by directory and time window
   - Test token aggregation
   - Test error extraction
   - Test canCollect returns false when DB missing

4. packages/sdk/src/workflows/__tests__/collectors/claude.test.ts
   - Create fixture history.jsonl and session JSONL files in a temp dir
   - Test matching by project path and timestamp
   - Test canCollect returns false when files missing

5. packages/sdk/src/workflows/__tests__/collectors/codex.test.ts
   - Create fixture SQLite DB with threads and logs tables
   - Test matching by cwd and time window
   - Test error extraction from logs table

6. packages/sdk/src/workflows/__tests__/run-summary-table.test.ts
   - Snapshot test of the formatted summary table given mock CliSessionReport objects
   - Test with all-passing steps
   - Test with one failed step (should show error line)
   - Test with no reports (should fall back to existing summary format)

Use vitest. Mock file system paths to point at temp fixtures. Do NOT hit real user data stores.
    `.trim(),
    dependsOn: ['impl-runner-integration'],
    verification: { type: 'exit_code' },
  });

  // ── Phase 5: Verify ─────────────────────────────────────────────────────

  wf.step('typecheck', {
    type: 'deterministic',
    command: 'cd packages/sdk && npx tsc --noEmit',
    dependsOn: ['write-tests'],
  });

  wf.step('run-tests', {
    type: 'deterministic',
    command: 'cd packages/sdk && npx vitest run --reporter=verbose',
    dependsOn: ['typecheck'],
  });

  // ── Run ─────────────────────────────────────────────────────────────────

  const result = await wf.onError('retry', { maxRetries: 2, retryDelayMs: 10_000 }).run({
    onEvent: (e) => {
      if (e.type.startsWith('step:')) {
        console.log(`[${e.type}] ${e.stepName ?? ''}`);
      }
    },
  });

  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);
