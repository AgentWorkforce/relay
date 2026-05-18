---
name: relay-80-100-workflow
description: Use when writing agent-relay workflows that must fully validate features end-to-end before merging. Covers the 80-to-100 pattern - going beyond "code compiles" to "feature works, tested E2E locally." Includes PGlite for in-memory Postgres testing, mock sandbox patterns, test-fix-rerun loops, verify gates after every edit, and the full lifecycle from implementation through passing tests to commit.
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

## The Test-Fix-Rerun Pattern

Every testable feature in a workflow should follow this three-step pattern:

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

// Step 3: Deterministic final run — this one MUST pass
.step('run-tests-final', {
  type: 'deterministic',
  dependsOn: ['fix-tests'],
  command: 'npx tsx --test tests/my-feature.test.ts 2>&1',
  captureOutput: true,
  failOnError: true,  // <-- Hard fail if tests still broken
})
```

**Why three steps instead of one?**

- The first run captures output for the agent to diagnose
- The agent step can iterate (read errors, fix, re-run) multiple times
- The final deterministic run is the gate — no agent judgment, just pass/fail

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
  failOnError: true,
  captureOutput: true,
})
```

**What to verify:**

- File was actually modified (`git diff --quiet` returns non-zero)
- Key content exists (grep for table names, function names, imports)
- For new files: `file_exists` verification type

**What NOT to verify:**

- Exact content (too brittle — agents format differently)
- Line counts or byte sizes (meaningless)

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
    failOnError: true,
    captureOutput: true,
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
    dependsOn: ['create-test-helpers', 'verify-target'],
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
    failOnError: true,
  })

  // ── Phase 5: Build + regression ──────────────────────────────────
  .step('build-check', {
    type: 'deterministic',
    dependsOn: ['run-tests-final'],
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
  .step('commit', {
    type: 'deterministic',
    dependsOn: ['fix-regressions'],
    command: 'git add <files> && git commit -m "feat: ..."',
    captureOutput: true,
    failOnError: true,
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });
```

## Checklist: Is Your Workflow 80-to-100?

| Check                               | How                                             |
| ----------------------------------- | ----------------------------------------------- |
| Tests exist                         | `file_exists` verification on test file         |
| Tests actually run                  | Deterministic step executes them                |
| Test failures get fixed             | Agent step reads output, fixes, re-runs         |
| Final test run is hard-gated        | `failOnError: true` on last test step           |
| Build passes                        | `npx tsc --noEmit` deterministic step           |
| No regressions                      | Existing test suite runs after changes          |
| Every edit is verified              | `git diff --quiet` + grep after each agent edit |
| Commit only happens after all gates | `dependsOn` chains to final verification        |

## Common Anti-Patterns

| Anti-pattern                                     | Why it fails                                                          | Fix                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Tests written but never executed                 | Agent claims they pass, they don't                                    | Add deterministic `run-tests` step                    |
| Single `failOnError: true` test run              | First failure kills workflow, no chance to fix                        | Use the three-step test-fix-rerun pattern             |
| No regression test                               | New feature works, old features break                                 | Run `npm test` after build check                      |
| Agent asked to "write and run tests" in one step | Agent writes tests, runs them, they fail, it edits, output is garbled | Separate write/run/fix into distinct steps            |
| PGlite DDL doesn't match Drizzle schema          | Tests pass on wrong schema                                            | Derive DDL from schema.ts or test with real migration |
| `failOnError: false` on final test run           | Broken tests get committed                                            | Always `failOnError: true` on the gate step           |
| Testing only happy path                          | Edge cases break in prod                                              | Specify edge case tests in the task prompt            |
| No verify gate after agent edits                 | Agent exits 0 without writing anything                                | Add `git diff --quiet` check after every edit         |
