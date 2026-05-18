---
name: relay-80-100-workflow
description: Use when writing agent-relay workflows that must fully validate features end-to-end before merging. Covers the 80-to-100 pattern - going beyond "code compiles" to "feature works, tested E2E locally." Includes repair-before-failure validation gates, mandatory sequential Claude-then-Codex fresh-eyes review/fix loops with test hardening, PGlite for in-memory Postgres testing, mock sandbox patterns, test-fix-rerun loops, verify gates after every edit, and the full lifecycle from implementation through passing tests to commit.
---

# Writing 80-to-100 Validated Workflows

## Overview

Most agent workflows get features to ~80%: code written, types check, maybe a build passes. This skill covers the **80-to-100 gap** — making workflows that fully validate features end-to-end before committing. The goal: every feature merged via these workflows is **tested, verified, and known-working**, not just "it compiles."

## When to Use

- Writing workflows where the deliverable must be **production-ready**, not just code-complete
- Features that touch databases, APIs, or infrastructure that can be tested locally
- Any workflow where "it compiles" is not sufficient proof of correctness
- When you want confidence that the commit actually works before deploying

## Core Principle: Test In The Workflow

The key insight: **run tests as deterministic steps inside the workflow itself**. Don't just write test files — execute them, verify they pass, fix failures, and re-run. The workflow doesn't commit until tests are green.

```
implement → write tests → run tests → fix failures → re-run → build check → regression check → commit
```

This means the commit at the end of the workflow represents code that is **proven working**, not just code that an agent wrote and claimed works.

## Repair Before Failure

An 80-to-100 workflow should not stop merely because a test, typecheck, lint, schema, or E2E gate turns red. That red output is work for the agent team. Capture it, hand it to a repair owner, fix it, and rerun. Workflow-owned validation gates should never terminate the run with `FAILED`. If the team exhausts its repair budget or hits an external blocker such as missing credentials, wrong repository, or unsafe dirty worktree, write a `BLOCKED_NO_COMMIT` artifact and end without committing or opening a PR instead of crashing the workflow.

Use this shape for every meaningful gate:

1. `run-*`: deterministic command with `captureOutput: true` and `failOnError: false`.
2. `fix-*`: agent step that reads `{{steps.run-*.output}}`, fixes source/tests/config, and reruns the command locally until green.
3. `verify-*`: deterministic rerun, usually still `failOnError: false`, followed by a final repair step if red.
4. `commit-if-green`: deterministic step that reruns the full acceptance command and commits only when every exit code is zero. If anything is still red, it writes `BLOCKED_NO_COMMIT` with the failing evidence and exits successfully so the workflow reports a handled blocked state, not a runtime failure.

AgentWorkforce/relay#827 added repair-aware reliability to the SDK (`.reliable()` / `.repairable()` and repair-aware retry-mode workflows). Prefer those presets when available, but still model explicit repair owners when gate output needs domain-specific fixing.

## Keep Repairable Gates On The Critical Path

Repair-before-failure only works after the workflow reaches a deterministic gate. If a long-running interactive agent step is a hard dependency for the first gate, then a dropped PTY, agent spawn error, or transport failure can stop the workflow before the repair loop ever sees evidence.

For large rollouts, treat implementation agents as advisory producers and put a deterministic reconciliation step on the critical path:

1. Start implementation/review agents in parallel if useful, but require them to write durable artifacts such as `.workflow-artifacts/<task>/runtime.md`, self-review notes, changed-file lists, and command evidence.
2. Add `implementation-reconcile`: a deterministic step that inspects `git status --short -- <paths>`, required files, artifact files, and diff stats. It should use `captureOutput: true` and `failOnError: false`.
3. Add `repair-implementation-reconcile`: a focused repair owner that reads the reconcile output and finishes missing artifacts or code before validation gates run.
4. Make discovery, typecheck, E2E, and final acceptance depend on the reconcile/repair path, not directly on every long-lived implementation agent.
5. Keep the final commit deterministic and green-only; red final evidence becomes a repair/blocking artifact, not a failed workflow.

This shape prevents "agent transport failed" from masquerading as "the product failed." The product still has to pass the same gates; the difference is that the workflow can reach the gates and repair them.

## Squad Review Before Final Acceptance

For high-stakes implementation workflows, validation should include human-like review structure, not only command gates. Use small implementation squads and make review state durable:

1. Split independent scopes into 2-3 agent squads. Each squad has an implementer, a shadow reviewer, and optionally a validation/test owner.
2. The shadow reviewer follows the implementer while work is happening and flags spec drift early.
3. Before external review, the implementer writes a self-reflection artifact under `.workflow-artifacts/<task>/` covering spec coverage, changed files, tests/proofs, repo-rule alignment, and known risks.
4. A fresh self-review agent reads the actual files, AGENTS.md / CLAUDE.md, recent related work, and local conventions. It writes findings to disk.
5. The implementer repairs valid findings, then deterministic gates rerun from captured output.
6. After all squads converge, run the mandatory sequential fresh-eyes review/fix loops: Claude reviews the final diff and artifacts, a fixer repairs valid findings and adds or updates appropriate tests/proofs, Claude reviews the post-fix state again, then Codex repeats the same cycle from scratch over the post-Claude-fix state.
7. If either final review still finds issues, run another explicit fix pass or write `BLOCKED_NO_COMMIT` with exact evidence.
8. Commit or PR creation is allowed only after final deterministic acceptance and post-Codex-fix review are green. Otherwise write a `BLOCKED_NO_COMMIT` artifact with exact evidence.

This keeps "100%" tied to both executable evidence and independent review over the final state.

## The Test-Fix-Rerun Pattern

Every testable feature in a workflow should follow this four-step pattern:

```typescript
// Step 1: Run tests (allow failure — we expect issues on first run)
.step('run-tests', {
  type: 'deterministic',
  dependsOn: ['create-tests'],
  command: 'npx tsx --test tests/my-feature.test.ts 2>&1 | tail -60',
  captureOutput: true,
  failOnError: false,  // <-- Don't fail the workflow, let the agent fix it
})

// Step 2: Agent reads output, fixes issues, re-runs until green
.step('fix-tests', {
  agent: 'tester',
  dependsOn: ['run-tests'],
  task: `Check the test output and fix any failures.

Test output:
{{steps.run-tests.output}}

If all tests passed, do nothing.
If there are failures:
1. Read the failing test file and source files
2. Fix the issues (could be in test or source)
3. Re-run: npx tsx --test tests/my-feature.test.ts
4. Keep fixing until ALL tests pass.`,
  verification: { type: 'exit_code' },
})

// Step 3: Deterministic rerun — capture result for a final repair pass
.step('run-tests-final', {
  type: 'deterministic',
  dependsOn: ['fix-tests'],
  command: 'npx tsx --test tests/my-feature.test.ts 2>&1',
  captureOutput: true,
  failOnError: false,
})

// Step 4: Repair again if the rerun is still red
.step('fix-tests-final', {
  agent: 'tester',
  dependsOn: ['run-tests-final'],
  task: `If the final test rerun passed, record the green evidence.
If it failed, fix the remaining issue and rerun until green:
{{steps.run-tests-final.output}}`,
  verification: { type: 'exit_code' },
})
```

**Why four steps instead of one?**

- The first run captures output for the agent to diagnose
- The agent step can iterate (read errors, fix, re-run) multiple times
- The final deterministic run is still evidence-based, but a repair agent sees it before the workflow stops
- The last repair step keeps the workflow aligned with the agent-team model instead of ending on a fixable failure

## PGlite: In-Memory Postgres for Database Testing

When your feature touches the database, use **PGlite** — a WASM-based Postgres that runs in-process. No Docker, no external services, no flaky network dependencies.

### Setup

Install as a dev dependency in the workflow:

```typescript
.step('install-pglite', {
  type: 'deterministic',
  command: 'npm install --save-dev @electric-sql/pglite 2>&1 | tail -5',
  captureOutput: true,
})
```

### Test Helper Pattern

Create a reusable helper that boots an in-memory Postgres with your schema:

```typescript
// tests/helpers/pglite-db.ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../packages/web/lib/db/schema.js';

// Raw DDL matching your Drizzle schema — PGlite doesn't run Drizzle migrations
const MY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS my_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function createTestDb() {
  const pg = new PGlite();
  await pg.exec(MY_TABLE_DDL);
  const db = drizzle(pg, { schema });
  return { db, pg, schema, cleanup: () => pg.close() };
}
```

### PGlite Gotchas

| Issue                              | Fix                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `pgcrypto` extension not available | Use `gen_random_uuid()` (built-in since PG 13) or generate UUIDs in app code   |
| UUID columns                       | PGlite supports UUID natively — no special handling needed                     |
| `drizzle-orm/pglite` import        | Exists since drizzle-orm 0.30+. If not found, check version.                   |
| Index creation                     | PGlite supports standard CREATE INDEX — no limitations                         |
| Concurrent writes                  | PGlite is single-connection. Test concurrent logic with sequential assertions. |

### Test Structure

```typescript
// tests/my-feature.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './helpers/pglite-db.js';

describe('my feature', () => {
  it('does the thing correctly', async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      // Arrange
      const testId = randomUUID();
      // Act — use your module against the real (in-memory) Postgres
      // Assert
      assert.equal(result.name, 'expected');
    } finally {
      await cleanup();
    }
  });
});
```

## Verify Gates After Every Edit

Never trust that an agent edited a file correctly. Add a deterministic verify gate after every agent edit step:

```typescript
// Agent edits a file
.step('edit-schema', {
  agent: 'impl',
  dependsOn: ['read-schema'],
  task: `Edit packages/web/lib/db/schema.ts...`,
  verification: { type: 'exit_code' },
})

// Deterministic verification — did the edit actually land?
.step('verify-schema', {
  type: 'deterministic',
  dependsOn: ['edit-schema'],
  command: `if git diff --quiet packages/web/lib/db/schema.ts; then echo "NOT MODIFIED"; exit 1; fi
grep "my_new_table" packages/web/lib/db/schema.ts >/dev/null && echo "OK" || (echo "MISSING"; exit 1)`,
  failOnError: false,
  captureOutput: true,
})
.step('fix-schema-verification', {
  agent: 'impl',
  dependsOn: ['verify-schema'],
  task: `Fix the schema edit if verification failed. Output:\n{{steps.verify-schema.output}}`,
  verification: { type: 'exit_code' },
})
```

**What to verify:**

- File was actually modified (`git diff --quiet` returns non-zero)
- Key content exists (grep for table names, function names, imports)
- For new files: `file_exists` verification type
- For new directories, package trees, generated files, or mixed tracked/untracked
  edits: use `git status --short -- <paths>`, because `git diff --quiet`
  ignores untracked files

**What NOT to verify:**

- Exact content (too brittle — agents format differently)
- Line counts or byte sizes (meaningless)

### Edit Gates That Include New Files

When an agent may create new files or package directories, do not use
`git diff --quiet -- <paths>` as the only edit gate. It only sees tracked
changes, so a valid new package can be misclassified as "no changes."

Use `git status --short -- <paths>` and keep the first gate repairable:

```typescript
.step('edit-gate-capture', {
  type: 'deterministic',
  dependsOn: ['implement'],
  command: `if [ -z "$(git status --short -- packages/new-adapter tests docs)" ]; then
  echo "NO_CHANGES"
  exit 1
fi
echo "EDIT_GATE_OK"`,
  captureOutput: true,
  failOnError: false,
})
.step('fix-edit-gate', {
  agent: 'impl',
  dependsOn: ['edit-gate-capture'],
  task: `If the edit gate reported NO_CHANGES, inspect the acceptance contract
and current git status, then add the missing source/test/artifacts.

Gate output:
{{steps.edit-gate-capture.output}}

If it already passed, do nothing.`,
  verification: { type: 'exit_code' },
})
.step('edit-gate-final', {
  type: 'deterministic',
  dependsOn: ['fix-edit-gate'],
  command: `if [ -z "$(git status --short -- packages/new-adapter tests docs)" ]; then
  echo "NO_CHANGES"
  exit 1
fi
echo "EDIT_GATE_FINAL_OK"`,
  captureOutput: true,
  failOnError: true,
})
```

Rule of thumb: `git diff --quiet` is fine for tracked-only edits to known
files. Use `git status --short -- <paths>` for materialization gates that may
include new tests, docs, generated artifacts, or package directories.

## Mock Sandbox Pattern

When testing code that interacts with Daytona sandboxes, use inline mock objects matching the existing test conventions:

```typescript
const daytona = {
  create: async () => ({
    id: 'sandbox-id',
    process: {
      executeCommand: async (cmd, cwd, env) => ({
        result: 'output',
        exitCode: 0,
      }),
    },
    fs: {
      uploadFile: async () => undefined,
    },
    getUserHomeDir: async () => '/home/daytona',
  }),
  remove: async () => undefined,
};
```

For testing that your code calls the right methods, record calls in an array:

```typescript
const emitted: EmitEventOptions[] = [];
const mockClient: SessionEventClient = {
  emit: async (opts) => {
    emitted.push(opts);
  },
  getEvents: async () => [],
  getLatestSequence: async () => 0,
};

// ... run the code ...

assert.equal(emitted.length, 4);
assert.equal(emitted[0].eventType, 'sandbox_created');
```

## Regression Testing

After your new tests pass, always run the **existing test suite** to catch regressions:

```typescript
.step('run-existing-tests', {
  type: 'deterministic',
  dependsOn: ['fix-build'],
  command: 'npm run orchestrator:test 2>&1 | tail -40',
  captureOutput: true,
  failOnError: false,
})

.step('fix-regressions', {
  agent: 'impl',
  dependsOn: ['run-existing-tests'],
  task: `Check the full test suite for regressions caused by our changes.

Test output:
{{steps.run-existing-tests.output}}

If all tests passed, do nothing.
If EXISTING tests broke, read the failing test, find what we broke, fix it.
Most likely cause: constructor signatures changed, new required fields added
without defaults, or import paths shifted.

Run: npm run orchestrator:test
Fix until all tests pass.`,
  verification: { type: 'exit_code' },
})
```

## Full Workflow Template

Here's the complete pattern for a feature that touches the database:

```typescript
import { workflow } from '@agent-relay/sdk/workflows';

const result = await workflow('my-feature')
  .description('Add feature X with full E2E validation')
  .pattern('dag')
  .channel('wf-my-feature')
  .maxConcurrency(3)
  .timeout(3_600_000)
  .repairable()

  .agent('impl', { cli: 'claude', preset: 'worker', retries: 2 })
  .agent('tester', { cli: 'claude', preset: 'worker', retries: 2 })

  // ── Phase 1: Read ────────────────────────────────────────────────
  .step('read-target', {
    type: 'deterministic',
    command: 'cat path/to/file.ts',
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────
  .step('edit-target', {
    agent: 'impl',
    dependsOn: ['read-target'],
    task: `Edit path/to/file.ts. Current contents:
{{steps.read-target.output}}
<specific instructions>
Only edit this one file.`,
    verification: { type: 'exit_code' },
  })
  .step('verify-target', {
    type: 'deterministic',
    dependsOn: ['edit-target'],
    command: 'git diff --quiet path/to/file.ts && (echo "NOT MODIFIED"; exit 1) || echo "OK"',
    failOnError: false,
    captureOutput: true,
  })
  .step('fix-target-verification', {
    agent: 'impl',
    dependsOn: ['verify-target'],
    task: `Fix the target edit if verification failed. Output:\n{{steps.verify-target.output}}`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 3: Test infrastructure ─────────────────────────────────
  .step('install-pglite', {
    type: 'deterministic',
    command: 'npm install --save-dev @electric-sql/pglite 2>&1 | tail -5',
    captureOutput: true,
  })
  .step('create-test-helpers', {
    agent: 'tester',
    dependsOn: ['install-pglite'],
    task: 'Create tests/helpers/pglite-db.ts with <DDL for your tables>...',
    verification: { type: 'file_exists', value: 'tests/helpers/pglite-db.ts' },
  })
  .step('create-tests', {
    agent: 'tester',
    dependsOn: ['create-test-helpers', 'fix-target-verification'],
    task: 'Create tests/my-feature.test.ts with <test descriptions>...',
    verification: { type: 'file_exists', value: 'tests/my-feature.test.ts' },
  })

  // ── Phase 4: Test-fix-rerun loop ─────────────────────────────────
  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['create-tests'],
    command: 'npx tsx --test tests/my-feature.test.ts 2>&1 | tail -60',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-tests', {
    agent: 'tester',
    dependsOn: ['run-tests'],
    task: `Fix any test failures. Output:\n{{steps.run-tests.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('run-tests-final', {
    type: 'deterministic',
    dependsOn: ['fix-tests'],
    command: 'npx tsx --test tests/my-feature.test.ts 2>&1',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-tests-final', {
    agent: 'tester',
    dependsOn: ['run-tests-final'],
    task: `If the final test rerun is red, fix and rerun until green. Output:\n{{steps.run-tests-final.output}}`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 5: Build + regression ──────────────────────────────────
  .step('build-check', {
    type: 'deterministic',
    dependsOn: ['fix-tests-final'],
    command: 'npx tsc --noEmit 2>&1 | tail -20; echo "EXIT: $?"',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-build', {
    agent: 'impl',
    dependsOn: ['build-check'],
    task: `Fix type errors if any. Output:\n{{steps.build-check.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('run-existing-tests', {
    type: 'deterministic',
    dependsOn: ['fix-build'],
    command: 'npm test 2>&1 | tail -40',
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-regressions', {
    agent: 'impl',
    dependsOn: ['run-existing-tests'],
    task: `Fix regressions if any. Output:\n{{steps.run-existing-tests.output}}`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 6: Commit ──────────────────────────────────────────────
  .step('record-head-baseline', {
    type: 'deterministic',
    dependsOn: ['fix-regressions'],
    // Snapshot HEAD *before* committing so verify-commit-created can prove
    // HEAD actually advanced, not just that the latest subject happens to match.
    command: 'git rev-parse HEAD > .workflow-head-before',
    captureOutput: true,
    failOnError: true,
  })
  .step('commit', {
    type: 'deterministic',
    dependsOn: ['record-head-baseline'],
    command: [
      'npx tsx --test tests/my-feature.test.ts',
      'npm test',
      'git add <files>',
      'git commit -m "feat: ..."',
    ].join(' && '),
    captureOutput: true,
    failOnError: false,
  })
  .step('repair-commit', {
    agent: 'impl',
    dependsOn: ['commit'],
    task: `If commit failed, fix the blocker, rerun the feature and regression tests, and create the commit.
If commit passed, confirm the commit subject.
Output:
{{steps.commit.output}}`,
    verification: { type: 'exit_code' },
  })
  .step('verify-commit-created', {
    type: 'deterministic',
    dependsOn: ['repair-commit'],
    // Assert HEAD advanced past the baseline AND the new commit has the
    // expected subject AND nothing is left uncommitted. Checking the subject
    // alone passes falsely when HEAD was already a matching commit and the
    // commit step never created a new one.
    command:
      [
        'baseline="$(cat .workflow-head-before)"',
        'rm -f .workflow-head-before',
        'test "$(git rev-parse HEAD)" != "$baseline"',
        'git log -1 --pretty=%s | grep -q "^feat: "',
        'test -z "$(git status --porcelain)"',
      ].join(' && ') + ' && echo "COMMIT_OK" || (echo "COMMIT_MISSING_OR_HEAD_UNCHANGED"; exit 1)',
    captureOutput: true,
    failOnError: true,
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });
```

## Checklist: Is Your Workflow 80-to-100?

| Check                                    | How                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Tests exist                              | `file_exists` verification on test file                                                                                               |
| Tests actually run                       | Deterministic step executes them                                                                                                      |
| Test failures get fixed                  | Agent step reads output, fixes, re-runs                                                                                               |
| Final test run is repairable             | Deterministic rerun captures output, then a repair owner gets one more pass                                                           |
| Build passes                             | `npx tsc --noEmit` deterministic step                                                                                                 |
| No regressions                           | Existing test suite runs after changes                                                                                                |
| Every edit is verified and repairable    | `git diff --quiet` + grep for tracked-only edits; `git status --short -- <paths>` when new files/packages may appear; then a fix step |
| Commit only happens after green evidence | Final commit step reruns acceptance checks and commits only on zero exit codes                                                        |

## Common Anti-Patterns

| Anti-pattern                                                 | Why it fails                                                                     | Fix                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tests written but never executed                             | Agent claims they pass, they don't                                               | Add deterministic `run-tests` step                                                      |
| Single `failOnError: true` test run                          | First failure kills workflow, no chance to fix                                   | Use repairable run-fix-rerun-final-fix loops                                            |
| No regression test                                           | New feature works, old features break                                            | Run `npm test` after build check                                                        |
| Agent asked to "write and run tests" in one step             | Agent writes tests, runs them, they fail, it edits, output is garbled            | Separate write/run/fix into distinct steps                                              |
| PGlite DDL doesn't match Drizzle schema                      | Tests pass on wrong schema                                                       | Derive DDL from schema.ts or test with real migration                                   |
| Final test output not handed to an agent                     | Broken tests can stop the run or get ignored                                     | Add a final repair owner before commit                                                  |
| Testing only happy path                                      | Edge cases break in prod                                                         | Specify edge case tests in the task prompt                                              |
| No verify gate after agent edits                             | Agent exits 0 without writing anything                                           | Add `git diff --quiet` check after every edit, then route failures to a repair step     |
| `git diff --quiet` for new package/test directories          | Untracked files are invisible, so valid new artifacts can look like "no changes" | Use `git status --short -- <paths>` and a repairable capture → fix → final gate pattern |
| Committing after `failOnError: false` without checking exits | Broken work can be committed because the shell step returned successfully        | In `commit-if-green`, record each exit code and skip commit unless all are zero         |
