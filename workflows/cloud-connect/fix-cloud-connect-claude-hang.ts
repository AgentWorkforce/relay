/**
 * fix-cloud-connect-claude-hang.ts
 *
 * ## Problem
 *
 * `agent-relay cloud connect anthropic` prints "Starting interactive
 * authentication..." and then hangs with zero further output. The SSH channel
 * to the Daytona sandbox is open, but claude's Ink-based TUI never renders
 * anything in the local terminal. The same codepath works for opencode and
 * cursor in some shapes but hangs consistently for claude.
 *
 * This is a separate bug from the openai PATH-propagation hang (fixed
 * server-side in cloud repo — that one was `VAR=val cmd1; cmd2` bash scoping).
 * Claude is preinstalled on the Daytona base image so PATH isn't the issue;
 * this one lives in the relay CLI's SSH shell bridge.
 *
 * ## Hypotheses
 *
 * The root cause is in `src/cli/lib/ssh-interactive.ts` inside the
 * `sshClient.shell({ term, cols, rows }, (err, stream) => { ... })` callback
 * (around line 180). Two concrete things are wrong:
 *
 * **H1 — data-listener race.** `stream.on('data', ...)` is attached AFTER
 * `stream.write(\`${command}; exit $?\\n\`)`. ssh2 ClientChannel is a
 * Readable stream. While no 'data' listener is attached, the stream is
 * paused and bytes buffer internally. When the listener is attached, the
 * stream enters flowing mode and the buffered bytes should flush.
 *
 * In practice, if the shell's early output (PS1, banner, TUI enter-alt-screen
 * sequences) is emitted in the same tick as the stream.write call, ssh2 can
 * dispatch those bytes as a single 'data' event that is dropped because no
 * listener is attached yet. The TUI then hides the cursor and clears the
 * screen — and the local terminal sits black until the 15-minute session
 * timeout.
 *
 * **H2 — `; exit $?` race.** `stream.write(\`${command}; exit $?\\n\`)` sends
 * the command plus a trailing `; exit $?`. When the wrapped CLI is an
 * Ink-based TUI (claude, codex, opencode), the TUI enters alternate-screen
 * buffer and hides the cursor at start. If the user's SSH client exits or
 * the shell process closes before the TUI has flushed its final redraw, the
 * local terminal never renders anything. Using `exec <command>` replaces the
 * shell process with the CLI outright, so there is no "shell exit" after the
 * TUI returns — the PTY closes when the CLI exits, cleanly.
 *
 * ## Fix
 *
 * 1. Move all stream event handlers (`stream.on('data', ...)`, stdin
 *    wiring, resize handler, timeout setup) BEFORE the `stream.write(...)`
 *    call inside the shell() callback. Do not call `stream.write` until
 *    after the 'data' listener is attached.
 *
 * 2. Change `stream.write(\`${command}; exit $?\\n\`)` to
 *    `stream.write(\`exec ${command}\\n\`)`. The shell is replaced with the
 *    target CLI; the PTY closes when the CLI exits and emits its exit code
 *    naturally.
 *
 * 3. Extract `ssh-interactive.ts`'s shell-invocation command transformation
 *    into a pure helper `formatShellInvocation(command: string): string` so
 *    it can be unit-tested without a real SSH server.
 *
 * 4. Add a unit test that mocks `sshClient.shell()` and asserts:
 *    - A 'data' event listener is attached BEFORE any `stream.write` call
 *    - The write payload starts with `exec ` and contains no `; exit $?`
 *    - When the fake stream emits data synchronously upon open, the handler
 *      sees it (regression test for H1)
 *
 * ## Acceptance contract
 *
 *   A1  formatShellInvocation('claude')              === 'exec claude\\n'
 *   A2  formatShellInvocation('codex login --no-browser') === 'exec codex login --no-browser\\n'
 *   A3  formatShellInvocation never contains '; exit $?'
 *   A4  In the shell() callback, on('data') is registered before stream.write
 *   A5  When the mock stream emits 'READY\\n' synchronously after open, the
 *       captured output buffer contains 'READY'
 *   A6  `npx tsc --noEmit` is clean
 *   A7  Existing ssh-interactive tests (if any) still pass
 *   A8  `npm run test:cli -- ssh-interactive` is green
 *
 * ## Usage
 *
 *   cd /Users/khaliqgant/Projects/AgentWorkforce/relay
 *   agent-relay run workflows/fix-cloud-connect-claude-hang.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';
import { CodexModels } from '@agent-relay/config';

const SSH_INTERACTIVE = 'src/cli/lib/ssh-interactive.ts';
const NEW_TEST = 'src/cli/lib/ssh-interactive.test.ts';

async function main() {
  const result = await workflow('fix-cloud-connect-claude-hang')
    .description(
      'Fix claude TUI hang in ssh-interactive.ts — data-listener race + shell exit race. Validates with unit tests.'
    )
    .pattern('dag')
    .channel('wf-fix-claude-hang')
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Refactors ssh-interactive.ts shell callback and exports formatShellInvocation',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Writes unit tests for formatShellInvocation and the handler-order regression',
      retries: 2,
    })
    .agent('fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Fixes type errors, test failures, and regressions',
      retries: 2,
    })

    // ── Phase 0: Setup branch ────────────────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: `set -e
BRANCH="fix/cloud-connect-claude-hang"
CURRENT=$(git branch --show-current)
if [ "$CURRENT" = "$BRANCH" ]; then
  echo "Already on $BRANCH"
elif git checkout -b "$BRANCH" 2>/dev/null; then
  echo "Checked out new $BRANCH"
elif git checkout "$BRANCH" 2>/dev/null; then
  echo "Checked out existing $BRANCH"
else
  echo "Branch $BRANCH unavailable in this worktree; staying on $CURRENT"
fi
echo "BRANCH: $(git branch --show-current)"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 1: Read source ─────────────────────────────────────────
    .step('read-ssh-interactive', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: `cat ${SSH_INTERACTIVE}`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 2: Implement the fix ───────────────────────────────────
    .step('implement-fix', {
      agent: 'impl',
      dependsOn: ['read-ssh-interactive'],
      timeoutMs: 900_000,
      task: `Edit \`${SSH_INTERACTIVE}\`. Do not touch other files.

Current file:
{{steps.read-ssh-interactive.output}}

Make three changes inside the \`sshClient.shell({ term, cols, rows }, (err, stream) => { ... })\` callback (starting around the line \`sshClient.shell({ term, cols, rows }, (err, stream) => {\`):

---

**Change 1 — Add an exported pure helper at module top-level (above runInteractiveSession):**

\`\`\`ts
/**
 * Format a remote command for execution inside an ssh2 shell() PTY.
 *
 * Uses \`exec\` to replace the shell process with the target CLI so there is
 * no shell-teardown race after a TUI (claude, codex, opencode, etc.) returns.
 * The PTY closes when the CLI exits and emits its exit code naturally, with
 * no trailing \`; exit $?\` that can win a race against the TUI's final
 * alternate-screen-buffer flush.
 */
export function formatShellInvocation(command: string): string {
  return \`exec \${command}\\n\`;
}
\`\`\`

---

**Change 2 — Reorder the shell() callback so data handlers are attached BEFORE the write.**

Find the block that currently looks (approximately) like:

\`\`\`ts
sshClient.shell({ term, cols, rows }, (err, stream) => {
  if (err) return reject(err);

  // Send the command through the shell, then exit with its status
  stream.write(\`\${command}; exit $?\\n\`);

  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let authDetected = false;
  let outputBuffer = '';

  const stdin = process.stdin;
  const stdout = process.stdout;
  const stderr = process.stderr;

  // ... raw mode setup, stdin handler, cleanup, resize handler, timer ...

  stream.on('data', (data: Buffer) => { /* ... */ });
  stream.stderr.on('data', (data: Buffer) => { /* ... */ });

  // ... stream.on('exit'), stream.on('close'), stream.on('error') ...
});
\`\`\`

Restructure so the order is:

1. \`if (err) return reject(err);\`
2. All variable declarations (\`let exitCode\`, etc.)
3. All handler declarations (\`onStdinData\`, \`cleanup\`, \`closeOnAuthSuccess\`, \`onResize\`)
4. \`stream.on('data', ...)\`  — MOVED BEFORE the write
5. \`stream.stderr.on('data', ...)\` — MOVED BEFORE the write
6. \`stream.on('exit', ...)\`
7. \`stream.on('close', ...)\`
8. \`stream.on('error', ...)\`
9. \`stdout.on('resize', onResize)\`
10. \`stdin.on('data', onStdinData)\`
11. \`stdin.setRawMode?.(true); stdin.resume();\`
12. \`const timer = runtime.setTimeout(...);\`
13. **Only now:** \`stream.write(formatShellInvocation(command));\`

The key invariant: no \`stream.write\` call may happen before \`stream.on('data', ...)\` is registered.

---

**Change 3 — Replace the write payload.**

OLD:
\`\`\`ts
stream.write(\`\${command}; exit $?\\n\`);
\`\`\`

NEW:
\`\`\`ts
stream.write(formatShellInvocation(command));
\`\`\`

---

Do NOT change any other function, the system-ssh fallback branch, types, imports (except that you may need to add an export for \`formatShellInvocation\`), or the file's public surface. Keep the diff focused.

When done, end your message with EDIT_DONE.`,
      verification: { type: 'output_contains', value: 'EDIT_DONE' },
    })

    // ── Phase 3: Verify edit landed ──────────────────────────────────
    .step('verify-edit', {
      type: 'deterministic',
      dependsOn: ['implement-fix'],
      command: `set -e
git diff --quiet ${SSH_INTERACTIVE} && (echo "NOT MODIFIED"; exit 1) || true

grep -q "export function formatShellInvocation" ${SSH_INTERACTIVE} || (echo "MISSING formatShellInvocation export"; exit 1)

grep -q "formatShellInvocation(command)" ${SSH_INTERACTIVE} || (echo "NOT CALLED from shell callback"; exit 1)

# Must NOT contain the old shell-wrapper stream.write call.
# Comments may still describe the legacy behavior, so match the code pattern.
if rg -q 'stream\\.write\\(.*exit \\$\\?\\\\n' ${SSH_INTERACTIVE}; then
  echo "ERROR: still contains legacy shell wrapper write — must be removed"
  exit 1
fi

# Basic ordering check: stream.on('data' should appear before stream.write(
# inside the shell callback region. This uses line numbers.
DATA_LINE=$(grep -n "stream.on('data'" ${SSH_INTERACTIVE} | head -1 | cut -d: -f1)
WRITE_LINE=$(grep -n "stream.write(formatShellInvocation" ${SSH_INTERACTIVE} | head -1 | cut -d: -f1)

if [ -z "$DATA_LINE" ] || [ -z "$WRITE_LINE" ]; then
  echo "MISSING expected markers: data=$DATA_LINE write=$WRITE_LINE"
  exit 1
fi

if [ "$DATA_LINE" -gt "$WRITE_LINE" ]; then
  echo "ERROR: stream.on('data') (line $DATA_LINE) appears AFTER stream.write(formatShellInvocation) (line $WRITE_LINE)"
  exit 1
fi

echo "VERIFY_EDIT_OK"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Write unit tests ────────────────────────────────────
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['verify-edit'],
      timeoutMs: 600_000,
      task: `Create \`${NEW_TEST}\`. This is a new test file — there is no existing one to extend.

Use Vitest (the rest of this repo uses \`vitest\`) with \`describe/it/expect\`. Import from the module under test:

\`\`\`ts
import { describe, it, expect, vi } from 'vitest';
import { formatShellInvocation, runInteractiveSession } from './ssh-interactive.js';
\`\`\`

Write these test cases:

**Suite: formatShellInvocation**

1. \`exec\` prefix: \`expect(formatShellInvocation('claude')).toBe('exec claude\\n')\`
2. passes args through: \`expect(formatShellInvocation('codex login --no-browser')).toBe('exec codex login --no-browser\\n')\`
3. never includes \`; exit $?\`: \`expect(formatShellInvocation('claude').includes('; exit $?')).toBe(false)\`
4. ends with a single \`\\n\`: \`expect(formatShellInvocation('claude').endsWith('\\n')).toBe(true)\` and \`.split('\\n').length === 2\`

**Suite: runInteractiveSession — handler-order regression (H1)**

Construct a fake ssh2 client via the \`runtime\` option. Strategy:

\`\`\`ts
import { EventEmitter } from 'node:events';

function createFakeStream() {
  const stream: any = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = vi.fn();
  stream.close = vi.fn();
  stream.setWindow = vi.fn();
  return stream;
}

function createFakeClient() {
  const client: any = new EventEmitter();
  const stream = createFakeStream();
  client.stream = stream;
  client.connect = vi.fn(() => {
    // Fire 'ready' async
    setImmediate(() => client.emit('ready'));
  });
  client.shell = vi.fn((opts: any, cb: any) => {
    // Synchronously invoke callback with the stream
    cb(null, stream);
  });
  client.forwardOut = vi.fn((src: any, p1: any, dst: any, p2: any, cb: any) => {
    cb(null, new EventEmitter());
  });
  client.end = vi.fn();
  return client;
}

const fakeSSH2 = {
  Client: class FakeClientWrap {
    constructor() {
      return createFakeClient();
    }
  },
};
\`\`\`

Tests:

5. **stream.on('data') is attached before stream.write**:
   - Call \`runInteractiveSession\` with a fake \`loadSSH2\` that returns \`fakeSSH2\`.
   - After the shell() callback fires, inspect the order of events on the fake stream: listenerCount('data') must be \`>= 1\` BEFORE the first \`stream.write.mock.calls\` entry. Track this by spying on \`stream.write\` with vi.fn and recording \`stream.listenerCount('data')\` at the moment write is called.
   - Assert the recorded listener count at write-time is \`>= 1\`.

6. **write payload starts with 'exec '**:
   - Assert \`stream.write.mock.calls[0][0].startsWith('exec ')\`.
   - Assert \`stream.write.mock.calls[0][0].includes('; exit $?')\` is false.

7. **synchronous early data is captured**:
   - Configure the fake \`client.shell\` to emit \`stream.emit('data', Buffer.from('READY\\n'))\` synchronously inside the shell callback, immediately after passing the stream to \`cb\`.
   - Configure the successPatterns to include \`/READY/\` so the session resolves with \`authDetected: true\`.
   - Assert the returned \`InteractiveSessionResult.authDetected === true\`.

Required test options — pass these to \`runInteractiveSession\`:
- \`ssh: { host: 'test', port: 22, user: 'test', password: 'test' }\`
- \`remoteCommand: 'claude'\`
- \`successPatterns: [/READY/]\` (for test 7; use \`[]\` for tests 5 and 6)
- \`errorPatterns: []\`
- \`timeoutMs: 5000\`
- \`io: { log: vi.fn(), error: vi.fn() }\`
- \`runtime: { loadSSH2: async () => fakeSSH2, createServer: () => ({ listen: (_: any, _h: any, cb: any) => cb(), close: vi.fn(), on: vi.fn() }), setTimeout: (fn: any, ms: any) => setTimeout(fn, ms) }\`

Mock stdin/stdout via vi.spyOn so raw mode + resume don't break the test environment:
\`\`\`ts
vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);
vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
\`\`\`

You may need to call \`stream.emit('close')\` after setup to resolve the session. Study the current \`runInteractiveSession\` code to understand the resolve path.

When done, end your message with TESTS_WRITTEN.`,
      verification: { type: 'file_exists', value: NEW_TEST },
    })

    .step('verify-tests-written', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: `set -e
test -f ${NEW_TEST} || (echo "MISSING test file"; exit 1)
grep -q "formatShellInvocation" ${NEW_TEST} || (echo "missing formatShellInvocation import/usage"; exit 1)
grep -q "exec claude" ${NEW_TEST} || (echo "missing exec claude assertion"; exit 1)
grep -q "listenerCount" ${NEW_TEST} || (echo "missing listener-count handler-order test"; exit 1)
echo OK`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 5: Run unit tests (test-fix-rerun) ─────────────────────
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-tests-written'],
      command: `npx vitest run ${NEW_TEST} 2>&1 | tail -80`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-tests', {
      agent: 'fixer',
      dependsOn: ['run-tests'],
      timeoutMs: 900_000,
      task: `Vitest output:

{{steps.run-tests.output}}

If ALL tests passed, do nothing and end with ALL_GREEN.

If there are failures, decide whether the bug is in:
  (a) the implementation in ${SSH_INTERACTIVE}, or
  (b) the test in ${NEW_TEST}, or
  (c) the fake-ssh2 setup.

The handler-order regression test (test 5) is a hard contract — if it fails because listenerCount('data') is 0 at write-time, the implementation reordering is wrong. Fix ${SSH_INTERACTIVE}, not the test.

Re-run: \`npx vitest run ${NEW_TEST}\`. Iterate until green. End with ALL_GREEN.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: `npx vitest run ${NEW_TEST} 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 6: Typecheck ───────────────────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: `npx tsc --noEmit 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-typecheck', {
      agent: 'fixer',
      dependsOn: ['typecheck'],
      timeoutMs: 600_000,
      task: `Typecheck output:
{{steps.typecheck.output}}

If EXIT: 0, do nothing and end with TYPECHECK_OK.
If there are type errors in ${SSH_INTERACTIVE} or ${NEW_TEST}, fix them. Do not touch unrelated files. Re-run \`npx tsc --noEmit\`. End with TYPECHECK_OK.`,
      verification: { type: 'exit_code' },
    })

    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: `npx tsc --noEmit 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 7: Regression — run related CLI tests ──────────────────
    .step('run-cli-tests', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: `npx vitest run src/cli 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'fixer',
      dependsOn: ['run-cli-tests'],
      timeoutMs: 600_000,
      task: `CLI test output:
{{steps.run-cli-tests.output}}

If all green, end with NO_REGRESSIONS.
If the refactor broke any existing test under src/cli, fix the root cause in ${SSH_INTERACTIVE} (not the test). End with NO_REGRESSIONS.`,
      verification: { type: 'exit_code' },
    })

    .step('run-cli-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: `npx vitest run src/cli 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 8: Summary ─────────────────────────────────────────────
    .step('summary', {
      type: 'deterministic',
      dependsOn: ['run-cli-tests-final'],
      command: `echo "=== Files changed ==="
git status --short ${SSH_INTERACTIVE} ${NEW_TEST}
echo ""
echo "=== Diff summary ==="
git diff --stat ${SSH_INTERACTIVE} ${NEW_TEST}
echo ""
echo "All green. Review the diff, commit, and open a PR."`,
      captureOutput: true,
      failOnError: false,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 5_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
  console.log('Steps completed:', Object.keys(result.steps || {}));
  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch((error) => {
  console.error('Workflow failed:', error);
  process.exit(1);
});
