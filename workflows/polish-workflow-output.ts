import { workflow } from '@agent-relay/sdk/workflows';

const result = await workflow('polish-workflow-output')
    .description('Replace plain console.log workflow output with listr2 + chalk for a polished CLI experience')
    .pattern('dag')
    .channel('wf-polish-workflow-output')
    .maxConcurrency(4)
    .timeout(3600000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architect and reviewer. Plans the listr2 integration and reviews implementation.',
    })
    .agent('cli-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implements the new cli.ts with listr2 rendering.',
      model: 'gpt-5.3-codex',
    })
    .agent('runner-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Enhances runner.ts log/summary methods with chalk color.',
      model: 'gpt-5.3-codex',
    })

    // ── Phase 1: Read context (parallel) ──────────────────────────────────
    .step('create-branch', {
      type: 'deterministic',
      command: [
        'git checkout -b feature/polish-workflow-output 2>&1 ||',
        'git checkout feature/polish-workflow-output 2>&1',
        '&& echo "branch=$(git branch --show-current)"',
      ].join(' '),
      captureOutput: true,
      failOnError: true,
    })
    .step('read-cli', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      command: 'cat packages/sdk/src/workflows/cli.ts',
      captureOutput: true,
    })
    .step('read-runner-segments', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      command: [
        'echo "=== runner.ts: log() method ==="',
        "sed -n '983,994p' packages/sdk/src/workflows/runner.ts",
        'echo ""',
        'echo "=== runner.ts: broker stderr wiring ==="',
        "sed -n '2236,2239p' packages/sdk/src/workflows/runner.ts",
        'echo ""',
        'echo "=== runner.ts: logRunSummary() method ==="',
        "sed -n '6000,6039p' packages/sdk/src/workflows/runner.ts",
      ].join('\n'),
      captureOutput: true,
    })
    .step('read-package-json', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      command: 'cat packages/sdk/package.json',
      captureOutput: true,
    })

    // ── Phase 2: Plan ──────────────────────────────────────────────────────
    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-cli', 'read-runner-segments', 'read-package-json'],
      task: `You are planning the integration of \`listr2\` and \`chalk\` into the
agent-relay workflow output system to make running workflows a polished,
beautiful CLI experience.

**Current output (plain text, no color):**
  [workflow 00:00] Starting workflow "default" (15 steps)
  [run] started
  [step] apply-stash started
  [step] apply-stash completed
  [workflow 00:04] [architecture-plan] Started (owner: architect)
  [broker] Broker ready (hello handshake complete)

**Target output:**
  ✔ apply-stash
  ✔ read-context
  ⠸ architecture-plan  [owner: architect · 00:04]
    → Spawning owner "architect" (cli: claude)

**Two files to modify:**

1. \`packages/sdk/src/workflows/cli.ts\` — Replace the \`formatEvent()\` +
   \`console.log\` pattern with a listr2 renderer that dynamically tracks steps
   as tasks. Steps are discovered via streaming events (step:started,
   step:completed, step:failed, etc.), not upfront. Use listr2's task map
   approach with dynamic task addition. The \`[workflow HH:MM]\` and \`[broker]\`
   lines from runner.ts come through console.log directly and must not break the
   listr2 renderer — use listr2's verbose/simple renderer or a logger that is
   compatible with interleaved console output.

2. \`packages/sdk/src/workflows/runner.ts\` — Targeted chalk enhancements to
   3 specific locations (do not rewrite the file):
   - \`log()\` method (~line 985): color the \`[workflow HH:MM]\` prefix in dim cyan
   - broker stderr wiring (~line 2237): color \`[broker]\` prefix in dim yellow
   - \`logRunSummary()\` method (~line 6000): color ✓ green, ✗ red, ⊘ dim,
     and the ━━━ header/footer lines in dim

**IMPORTANT — chalk version:** The project uses CommonJS (no \`"type": "module"\`
in package.json). Use \`chalk\` v4.x (last CJS-compatible version) NOT chalk v5+
which is ESM-only and will fail to import.

**Current cli.ts:**
{{steps.read-cli.output}}

**Current runner.ts segments:**
{{steps.read-runner-segments.output}}

**Current package.json:**
{{steps.read-package-json.output}}

Produce a detailed implementation plan covering:
1. Exact npm install command (listr2 version, chalk@4 pinned)
2. Complete new implementation for \`cli.ts\` (write the full file)
3. Exact before/after replacements for the 3 runner.ts locations
4. TypeScript import style for chalk and listr2 in CJS context
5. How the listr2 task map is keyed (stepName → task) and updated per event
6. How step:owner-assigned, step:retrying, step:nudged events render as
   subtask output lines rather than top-level tasks

PLAN_COMPLETE`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ── Phase 3: Install deps ──────────────────────────────────────────────
    .step('install-deps', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command: 'cd packages/sdk && npm install listr2 chalk@4 2>&1 && echo "exit=0"',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Implement (parallel workers) ──────────────────────────────
    .step('implement-cli', {
      agent: 'cli-worker',
      dependsOn: ['install-deps', 'plan', 'read-cli'],
      task: `Rewrite packages/sdk/src/workflows/cli.ts to use listr2 for beautiful
workflow step rendering.

Architect's plan (follow this precisely):
{{steps.plan.output}}

Current file to replace:
{{steps.read-cli.output}}

Write the complete new file to disk at:
  packages/sdk/src/workflows/cli.ts

IMPORTANT: Write the file using your file-writing tools.
Do NOT print the code to stdout — it must exist on disk when you finish.`,
      verification: { type: 'exit_code' },
    })
    .step('implement-runner', {
      agent: 'runner-worker',
      dependsOn: ['install-deps', 'plan', 'read-runner-segments'],
      task: `Add chalk color to 3 targeted locations in
packages/sdk/src/workflows/runner.ts.

Architect's plan (follow this precisely):
{{steps.plan.output}}

The exact code segments you need to find and edit:
{{steps.read-runner-segments.output}}

Make surgical edits to packages/sdk/src/workflows/runner.ts:
1. Find the log() method (~line 985) — add chalk color to [workflow HH:MM]
2. Find the broker stderr wiring (~line 2237) — add chalk to [broker]
3. Find logRunSummary() (~line 6000) — add chalk colors to icons and borders

Do NOT rewrite the entire runner.ts file — only edit those 3 sections.
Use search-and-replace editing so you touch only the lines shown above.
Write changes to disk using your file-editing tools.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 5: Verify build ──────────────────────────────────────────────
    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['implement-cli', 'implement-runner'],
      command: [
        'cd packages/sdk',
        'npx tsc --noEmit 2>&1 | head -80',
        'TSC_EXIT=${PIPESTATUS[0]}',
        'echo ""',
        'echo "tsc exit code: $TSC_EXIT"',
      ].join('\n'),
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 6: Review + fix ──────────────────────────────────────────────
    .step('review', {
      agent: 'lead',
      dependsOn: ['verify-build'],
      task: `Review the listr2 + chalk implementation.

TypeScript build output:
{{steps.verify-build.output}}

1. Read packages/sdk/src/workflows/cli.ts and verify:
   - listr2 is imported and used correctly
   - Steps render with spinners / completion icons
   - The file compiles (check build output above)

2. Check packages/sdk/src/workflows/runner.ts at lines ~985, ~2237, ~6000
   to verify chalk was added correctly to log(), broker wiring,
   and logRunSummary().

3. If there are TypeScript compilation errors in the build output, fix them
   by editing the affected files directly. Then confirm the fix is correct.

4. When satisfied that the implementation is correct and compiles cleanly,
   commit the changes with a concise commit message.

Approve when the implementation is complete and working.`,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10000 })
    .run({ onEvent: (e: { type: string }) => console.log(`[${e.type}]`) });

console.log('Result:', result.status);
