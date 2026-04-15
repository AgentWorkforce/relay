/**
 * validate-cloud-connect-e2e.ts
 *
 * ## Problem
 *
 * `agent-relay cloud connect <provider>` still appears to hang for users on
 * the released Bun binary (v4.0.26), even after:
 *   - PR #743 (handler-order + exec sh -c refactor in ssh-interactive.ts)
 *   - PR #744 (wrapWithLaunchCheckpoint — visible printf breadcrumb before
 *     the provider CLI enters alt-screen)
 *
 * The user upgrades, runs `cloud connect claude`, sees the unified
 * "Starting interactive authentication…" banner, and then… silence. No
 * `[agent-relay] launching provider CLI…` line. No claude TUI. Nothing.
 *
 * ## Root-cause hypothesis
 *
 * `scripts/build-bun.sh` passes `--external ssh2` to `bun build --compile`
 * on BOTH the cross-compile loop (line 68) and the current-platform build
 * (line 104). That means the released standalone binary does NOT contain
 * ssh2. At runtime, `loadSSH2()` attempts `import('ssh2')`, which throws
 * inside a packaged Bun binary, so the helper returns null and the CLI
 * falls through to the system-ssh fallback path in ssh-interactive.ts.
 *
 * The ssh2 path has rich observability (AGENT_RELAY_DEBUG_SSH, first-byte
 * timing, stream lifecycle, line-clearing hint). The system-ssh fallback
 * has ALMOST NONE: it shells out to `ssh -tt user@host 'remoteCommand'`
 * and inherits stdio. If the remote command hangs during environment
 * setup — before `printf '…launching provider CLI…'` ever runs — the user
 * sees no breadcrumb because the printf never executed.
 *
 * Every fix we've shipped so far has lived in the ssh2 branch or in the
 * remote command string that the ssh2 branch writes into the PTY. None of
 * those fixes reach released-binary users because they aren't running the
 * ssh2 branch at all.
 *
 * We validated locally that ssh2 bundles cleanly into a Bun compile:
 *
 *   bun build --compile --target=bun-darwin-arm64 \
 *     --external better-sqlite3 --external cpu-features --external node-pty \
 *     ./dist/src/cli/index.js --outfile /tmp/ssh2-bundle-test/agent-relay-ssh2
 *   # → 986 modules, 62M binary, --version works
 *
 * ## Fix
 *
 *   1. Drop `--external ssh2` from both occurrences in scripts/build-bun.sh.
 *   2. Add a real ssh2 integration test (tests/integration/ssh-interactive-live.test.ts)
 *      that spawns an in-process ssh2 Server, runs `runInteractiveSession`
 *      against it WITHOUT mocking the runtime, and asserts the launch
 *      checkpoint printf is visible in captured stdout. This is the
 *      mechanical E2E proof that the ssh2 path actually reaches the printf.
 *   3. Rebuild the Bun binary from scratch and validate:
 *      - Binary runs: `./.release/agent-relay --version` exits 0
 *      - Binary contains ssh2: `strings` output references ssh2 / ssh-userauth
 *      - Binary exercises the ssh2 branch at runtime (not fallback)
 *
 * ## Acceptance contract
 *
 *   A1  scripts/build-bun.sh contains zero `--external ssh2` occurrences
 *   A2  Existing unit tests green: ssh-interactive.test.ts (13 tests) +
 *       packages/cloud/src/auth.test.ts (10 tests)
 *   A3  `npx tsc --noEmit` is clean
 *   A4  tests/integration/ssh-interactive-live.test.ts exists and passes.
 *       It spins up an in-process ssh2 Server on a random port, calls
 *       runInteractiveSession with a default runtime (no loadSSH2 mock),
 *       and asserts:
 *         - the ssh2 client connects successfully
 *         - a shell session is opened on the fake server
 *         - the first payload received by the fake shell STARTS with
 *           `exec sh -c '` and contains `launching provider CLI`
 *         - captured stdout (via a write-spy) includes the dim-ANSI
 *           "launching provider CLI…" breadcrumb as proof the pipeline
 *           reached the printf
 *   A5  `npm run build && bash scripts/build-bun.sh` produces a binary at
 *       .release/agent-relay that runs `--version` successfully
 *   A6  The built binary contains ssh2 symbols (proof ssh2 is bundled).
 *       Heuristic check: `strings .release/agent-relay | grep -c 'ssh-userauth'`
 *       returns >= 1
 *   A7  `npm run orchestrator:test` (or the project's regression suite)
 *       still green
 *   A8  No commit is made until A1-A7 all pass
 *
 * ## What this workflow explicitly does NOT cover
 *
 *   - Live Daytona validation. Real Daytona sessions cost money per run and
 *     require CLOUD_API_* credentials. After this workflow is green, the
 *     operator must run `./.release/agent-relay cloud connect claude`
 *     against a real Daytona sandbox to confirm the fix works end-to-end.
 *     The workflow prints explicit validation instructions in its final
 *     summary step.
 *
 * ## Usage
 *
 *   cd /Users/khaliqgant/Projects/AgentWorkforce/relay
 *   agent-relay run --dry-run workflows/cloud-connect/validate-cloud-connect-e2e.ts
 *   agent-relay run workflows/cloud-connect/validate-cloud-connect-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';
import { CodexModels, ClaudeModels } from '@agent-relay/config';

const BUILD_BUN_SH = 'scripts/build-bun.sh';
const SSH_INTERACTIVE = 'src/cli/lib/ssh-interactive.ts';
const SSH_INTERACTIVE_TEST = 'src/cli/lib/ssh-interactive.test.ts';
const AUTH_TEST = 'packages/cloud/src/auth.test.ts';
const LIVE_TEST = 'tests/integration/ssh-interactive-live.test.ts';

async function main() {
  const result = await workflow('validate-cloud-connect-e2e')
    .description(
      'Validate cloud connect E2E: drop --external ssh2, add ssh2 live integration test, rebuild binary, prove the launch-checkpoint printf actually fires on the ssh2 path.'
    )
    .pattern('dag')
    .channel('wf-validate-cloud-connect-e2e')
    .maxConcurrency(3)
    .timeout(5_400_000)

    .agent('impl', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Edits scripts/build-bun.sh and writes the live ssh2 integration test',
      retries: 2,
    })
    .agent('tester', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Writes and iterates on the ssh2 live integration test until green',
      retries: 2,
    })
    .agent('fixer', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'worker',
      role: 'Fixes unit-test, typecheck, and regression failures',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      model: ClaudeModels.SONNET,
      preset: 'reviewer',
      role: 'Reviews the final diff for correctness before commit',
      retries: 1,
    })

    // ── Phase 0: Branch setup ────────────────────────────────────────
    .step('setup-branch', {
      type: 'deterministic',
      command: `set -e
BRANCH="fix/cloud-connect-bundle-ssh2"
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
echo "BRANCH: $(git branch --show-current)"
git status --short`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 1: Snapshot the bug ────────────────────────────────────
    .step('snapshot-build-bun', {
      type: 'deterministic',
      dependsOn: ['setup-branch'],
      command: `cat ${BUILD_BUN_SH}`,
      captureOutput: true,
      failOnError: true,
    })

    .step('snapshot-ssh-external-count', {
      type: 'deterministic',
      dependsOn: ['snapshot-build-bun'],
      command: `set -e
COUNT=$(grep -c -- '--external ssh2' ${BUILD_BUN_SH} || true)
echo "ssh2-external-count-before: $COUNT"
if [ "$COUNT" -eq 0 ]; then
  echo "UNEXPECTED: no --external ssh2 occurrences — fix may already be applied"
  exit 1
fi
echo "OK: $COUNT occurrences to remove"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('snapshot-existing-tests', {
      type: 'deterministic',
      dependsOn: ['snapshot-build-bun'],
      command: `set -e
echo "=== ssh-interactive.test.ts ==="
npx vitest run ${SSH_INTERACTIVE_TEST} 2>&1 | tail -30
echo ""
echo "=== auth.test.ts ==="
npx vitest run ${AUTH_TEST} 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 2: Read source files the fix touches ───────────────────
    .step('read-ssh-interactive', {
      type: 'deterministic',
      dependsOn: ['snapshot-existing-tests'],
      command: `cat ${SSH_INTERACTIVE}`,
      captureOutput: true,
      failOnError: true,
    })

    .step('read-auth-ssh', {
      type: 'deterministic',
      dependsOn: ['snapshot-existing-tests'],
      command: `cat src/cli/lib/auth-ssh.ts 2>/dev/null | head -120 || echo "(auth-ssh.ts missing or short)"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 3: Drop --external ssh2 from build-bun.sh ──────────────
    .step('edit-build-bun', {
      agent: 'impl',
      dependsOn: ['snapshot-ssh-external-count', 'read-ssh-interactive'],
      timeoutMs: 300_000,
      task: `Edit \`${BUILD_BUN_SH}\`. This is a bash script. Do not touch any other file.

Current contents:
{{steps.snapshot-build-bun.output}}

Remove EVERY line that is exactly \`    --external ssh2 \\\` (part of a \`bun build\` multi-line command). There are two such occurrences — one inside the \`for target_spec in "\${TARGETS[@]}"\` cross-compile loop, and one inside the current-platform build block further down. Keep all other \`--external\` flags (\`better-sqlite3\`, \`cpu-features\`, \`node-pty\`) intact. Keep the trailing backslash continuation on the line ABOVE the removed line so the bash command still parses.

Do NOT add comments explaining the removal. Do NOT change version strings, paths, or any other logic.

After editing, verify with: \`grep -c -- '--external ssh2' ${BUILD_BUN_SH}\` — it must output \`0\`.

End your message with EDIT_DONE.`,
      verification: { type: 'output_contains', value: 'EDIT_DONE' },
    })

    .step('verify-build-bun-edit', {
      type: 'deterministic',
      dependsOn: ['edit-build-bun'],
      command: `set -e
git diff --quiet ${BUILD_BUN_SH} && (echo "NOT MODIFIED"; exit 1) || true

COUNT_AFTER=$(grep -c -- '--external ssh2' ${BUILD_BUN_SH} || true)
echo "ssh2-external-count-after: $COUNT_AFTER"
if [ "$COUNT_AFTER" -ne 0 ]; then
  echo "ERROR: still has $COUNT_AFTER --external ssh2 lines"
  exit 1
fi

# Quick bash syntax check.
bash -n ${BUILD_BUN_SH} && echo "SYNTAX_OK" || (echo "BASH SYNTAX ERROR"; exit 1)

# The other externals must still be present.
grep -q -- '--external better-sqlite3' ${BUILD_BUN_SH} || (echo "MISSING better-sqlite3"; exit 1)
grep -q -- '--external cpu-features'   ${BUILD_BUN_SH} || (echo "MISSING cpu-features"; exit 1)
grep -q -- '--external node-pty'       ${BUILD_BUN_SH} || (echo "MISSING node-pty"; exit 1)

echo "VERIFY_BUILD_BUN_OK"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Write live ssh2 integration test ───────────────────
    .step('write-live-integration-test', {
      agent: 'tester',
      dependsOn: ['verify-build-bun-edit', 'read-ssh-interactive'],
      timeoutMs: 900_000,
      task: `Create \`${LIVE_TEST}\`. This is a NEW integration test — there is no existing one to extend.

The test must spin up an in-process ssh2 Server, call \`runInteractiveSession\` from \`src/cli/lib/ssh-interactive.ts\` with the DEFAULT runtime (i.e. do NOT mock \`loadSSH2\`), and prove that:
  (a) the ssh2 client actually connects to our fake server
  (b) the fake server receives a shell-channel write whose payload starts with \`exec sh -c '\` AND contains \`launching provider CLI\`
  (c) the CLI's stdout pipeline emits the dim-ANSI "launching provider CLI…" breadcrumb

This is the mechanical E2E proof that the ssh2 path actually fires the launch-checkpoint printf — the piece users have NOT been seeing in the released binary.

Use Vitest. Key shape:

\`\`\`ts
import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Server as SSH2Server } from 'ssh2';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInteractiveSession } from '../../src/cli/lib/ssh-interactive.js';

// You will need an ephemeral RSA host key for the fake server.
// Generate once in the test with ssh2's utils or ship a fixture under
// tests/fixtures/ssh-host-key. Prefer generating at test time to avoid a
// checked-in private key:
//
//   import { generateKeyPairSync } from 'node:crypto';
//   const { privateKey } = generateKeyPairSync('rsa', {
//     modulusLength: 2048,
//     privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
//     publicKeyEncoding:  { type: 'spki',  format: 'pem' },
//   });
\`\`\`

Test plan:

**Test 1 — ssh2 path writes exec sh -c with launch checkpoint through a real ssh2 connection:**

1. Generate an ephemeral RSA host key.
2. Start an ssh2 Server listening on an OS-assigned port (pass 0 to .listen).
3. In the server's connection handler:
   - Accept \`password\` auth unconditionally for user \`test\` / password \`test\`
   - Accept the first session
   - When the client requests a PTY, accept it
   - When the client opens a shell, capture \`stream.on('data')\` — the first
     data chunk is what the CLI writes into the shell. Store it into
     \`capturedWrite: string\`, then write nothing back (or a trivial banner)
     and call \`stream.exit(0); stream.end();\` after a short delay so the
     CLI's close handler fires.
4. Spy on \`process.stdout.write\` (vi.spyOn) to capture every byte the CLI
   writes to stdout. Collect them into \`capturedStdout: string\`.
5. Spy on \`process.stdin.setRawMode\`, \`resume\`, \`pause\` and no-op them.
6. Call \`runInteractiveSession\` with:
   \`\`\`ts
   {
     ssh: { host: '127.0.0.1', port: serverPort, user: 'test', password: 'test' },
     remoteCommand: 'claude',
     successPatterns: [],
     errorPatterns: [],
     timeoutMs: 5000,
     io: { log: vi.fn(), error: vi.fn() },
     // No runtime override — use the real default loadSSH2.
   }
   \`\`\`
7. Await the result. Assertions:
   - \`capturedWrite\` starts with \`exec sh -c '\`
   - \`capturedWrite\` includes \`launching provider CLI\`
   - \`capturedWrite\` does NOT include \`; exit $?\` (regression for PR #743)
   - \`capturedStdout\` includes the literal text \`launching provider CLI\` — this proves the ssh2 data pipeline hands bytes back to stdout. (In the real sandbox, the printf is the FIRST thing the shell runs before exec claude. In this test, the server has to echo the payload back so the CLI sees "data" and writes it to stdout. See step 3.)
8. Always close the ssh2 server + client in an \`afterEach\` / \`finally\`.

**Test 2 — loadSSH2 returns a truthy ssh2 module in the default runtime:**

1. Import \`loadSSH2\` from \`src/cli/lib/auth-ssh.js\`.
2. Call it and assert the result is truthy AND has a \`Client\` constructor.
3. This is a canary: if the bundler ever starts externalizing ssh2 again,
   this test fails inside the Bun binary smoke check in Phase 6.

**Gotchas:**

- ssh2 Server needs \`hostKeys: [{ key: privateKeyPem }]\` in its options
- The server's \`ready\` event signals the client is ready — use it to know
  when to resolve \`new Promise\` wrappers
- Server must call \`accept()\` on authentication, session, pty, and shell
  requests (not \`reject()\`)
- The shell stream emitted by the server is a Writable you can write to,
  and a Readable you listen to (\`stream.on('data', …)\`)
- Remember to call \`stream.exit(0)\` before \`stream.end()\` so the client's
  \`exit\` handler fires before \`close\`
- Mock \`process.stdin.setRawMode\` so vitest doesn't crash in CI environments
  where stdin is not a TTY
- Give the test a \`timeout: 10_000\` suffix on the \`it()\` call

**Environment:**

If ssh2 types are not re-exported from '@types/ssh2' in the usual place,
use \`// @ts-expect-error\` or \`as any\` narrowly rather than fighting types.
This is an integration test, not a type showcase.

When done, end your message with LIVE_TEST_WRITTEN.`,
      verification: { type: 'file_exists', value: LIVE_TEST },
    })

    .step('verify-live-test-written', {
      type: 'deterministic',
      dependsOn: ['write-live-integration-test'],
      command: `set -e
test -f ${LIVE_TEST} || (echo "MISSING test file"; exit 1)
grep -q "from 'ssh2'" ${LIVE_TEST} || grep -q 'from "ssh2"' ${LIVE_TEST} || (echo "missing ssh2 import"; exit 1)
grep -q "runInteractiveSession" ${LIVE_TEST} || (echo "missing runInteractiveSession import/usage"; exit 1)
grep -q "launching provider CLI" ${LIVE_TEST} || (echo "missing launch-checkpoint assertion"; exit 1)
grep -q "exec sh -c" ${LIVE_TEST} || (echo "missing exec sh -c assertion"; exit 1)
echo VERIFY_LIVE_TEST_OK`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 5: Run live integration test (test-fix-rerun) ─────────
    .step('run-live-test', {
      type: 'deterministic',
      dependsOn: ['verify-live-test-written'],
      command: `npx vitest run ${LIVE_TEST} 2>&1 | tail -120`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-live-test', {
      agent: 'fixer',
      dependsOn: ['run-live-test'],
      timeoutMs: 1_500_000,
      task: `Vitest output for ${LIVE_TEST}:

{{steps.run-live-test.output}}

If ALL tests passed, do nothing and end with LIVE_GREEN.

If tests failed, diagnose and fix. The failure could be in:
  (a) the integration test itself (${LIVE_TEST}) — wrong ssh2 server API shape, missing accept() call, flaky timing, bad host key format
  (b) the test expecting different bytes than what the ssh2 path actually produces
  (c) a real bug in ${SSH_INTERACTIVE} that the mocked unit tests missed

If the failure is that the ssh2 client never connects: the ssh2 Server is probably not accepting auth correctly. Read the ssh2 \`Server\` docs, the \`auth-method\` on the auth context is 'password', and you must call \`ctx.accept()\` for it.

If the failure is that \`capturedWrite\` is empty: the client is connecting but the shell callback isn't firing — check that the server is accepting the 'session' + 'pty' + 'shell' subrequests.

If the failure is that \`capturedStdout\` does not contain the breadcrumb: the server needs to echo the captured shell-write back through the stream so the CLI reads it, prints it to stdout, and the spy captures it. Adjust the server shell handler to \`stream.write(capturedWrite)\` (or the portion after 'exec sh -c …') before \`stream.exit(0)\`.

Do NOT relax the assertions to make the test pass. The assertions encode the ACCEPTANCE CONTRACT from the workflow header — weakening them defeats the purpose.

Re-run: \`npx vitest run ${LIVE_TEST}\`. Iterate until green. End with LIVE_GREEN.`,
      verification: { type: 'exit_code' },
    })

    .step('run-live-test-final', {
      type: 'deterministic',
      dependsOn: ['fix-live-test'],
      command: `npx vitest run ${LIVE_TEST} 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 6: Typecheck + regression ──────────────────────────────
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-live-test-final'],
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

If there are type errors, fix them. They are almost certainly in ${LIVE_TEST} (new file) since we did not touch any TypeScript source. Do not touch files outside ${LIVE_TEST} unless the error is in a file we already edited in this workflow. Narrow \`any\` casts are acceptable for ssh2 Server types. Re-run \`npx tsc --noEmit\`. End with TYPECHECK_OK.`,
      verification: { type: 'exit_code' },
    })

    .step('typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: `npx tsc --noEmit 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
    })

    .step('run-unit-tests', {
      type: 'deterministic',
      dependsOn: ['typecheck-final'],
      command: `set -e
echo "=== ssh-interactive.test.ts ==="
npx vitest run ${SSH_INTERACTIVE_TEST} 2>&1 | tail -30
echo ""
echo "=== auth.test.ts ==="
npx vitest run ${AUTH_TEST} 2>&1 | tail -30
echo ""
echo "=== broader src/cli ==="
npx vitest run src/cli 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-unit-regressions', {
      agent: 'fixer',
      dependsOn: ['run-unit-tests'],
      timeoutMs: 900_000,
      task: `Unit test output:
{{steps.run-unit-tests.output}}

If all green, end with UNIT_GREEN.

If any existing test regressed, fix the ROOT CAUSE (most likely in the integration test file you just wrote, since the workflow did not touch any production TS source). Do not weaken assertions in existing tests. End with UNIT_GREEN.`,
      verification: { type: 'exit_code' },
    })

    .step('run-unit-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-unit-regressions'],
      command: `set -e
npx vitest run ${SSH_INTERACTIVE_TEST} ${AUTH_TEST} ${LIVE_TEST} 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 7: Rebuild Bun binary from scratch ─────────────────────
    .step('build-ts', {
      type: 'deterministic',
      dependsOn: ['run-unit-tests-final'],
      command: `npm run build 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
    })

    .step('build-bun-binary', {
      type: 'deterministic',
      dependsOn: ['build-ts'],
      command: `set -e
rm -rf .release
bash ${BUILD_BUN_SH} 2>&1 | tail -80
echo ""
echo "=== .release contents ==="
ls -lh .release/ 2>&1`,
      captureOutput: true,
      failOnError: true,
    })

    .step('validate-binary-runs', {
      type: 'deterministic',
      dependsOn: ['build-bun-binary'],
      command: `set -e
BIN=.release/agent-relay
test -x "$BIN" || (echo "MISSING executable $BIN"; exit 1)

echo "=== --version ==="
"$BIN" --version
echo ""
echo "=== cloud connect --help ==="
"$BIN" cloud connect --help 2>&1 | head -40 || true
echo ""
echo "=== binary size ==="
du -h "$BIN"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('validate-ssh2-bundled', {
      type: 'deterministic',
      dependsOn: ['validate-binary-runs'],
      command: `set -e
BIN=.release/agent-relay

# Heuristic 1: strings-grep for ssh2 protocol markers. ssh-userauth is part
# of the SSH2 wire protocol and is present as a literal string in ssh2's
# JS sources, so a bundled binary should contain it.
USERAUTH_HITS=$(strings "$BIN" 2>/dev/null | grep -c 'ssh-userauth' || true)
echo "ssh-userauth hits: $USERAUTH_HITS"

# Heuristic 2: the ssh2 package name also appears as a module id in the
# bundle's module map.
SSH2_HITS=$(strings "$BIN" 2>/dev/null | grep -c '"ssh2"\\|node_modules/ssh2' || true)
echo "ssh2 module hits:  $SSH2_HITS"

if [ "$USERAUTH_HITS" -lt 1 ]; then
  echo "ERROR: binary does not appear to contain ssh2 (ssh-userauth not found in strings)"
  echo "This means --external ssh2 is still being applied somewhere in the build."
  exit 1
fi

echo "SSH2_BUNDLED_OK"`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 8: Review ──────────────────────────────────────────────
    .step('collect-diff', {
      type: 'deterministic',
      dependsOn: ['validate-ssh2-bundled'],
      command: `set -e
echo "=== files changed ==="
git status --short ${BUILD_BUN_SH} ${LIVE_TEST}
echo ""
echo "=== diff stat ==="
git diff --stat ${BUILD_BUN_SH} ${LIVE_TEST}
echo ""
echo "=== build-bun.sh diff ==="
git diff ${BUILD_BUN_SH}
echo ""
echo "=== live test (first 80 lines) ==="
head -80 ${LIVE_TEST}`,
      captureOutput: true,
      failOnError: false,
    })

    .step('review-diff', {
      agent: 'reviewer',
      dependsOn: ['collect-diff'],
      timeoutMs: 600_000,
      task: `Review the diff for the cloud-connect fix.

{{steps.collect-diff.output}}

Check:
  1. build-bun.sh: both \`--external ssh2\` occurrences removed, line continuations still valid, no other flags lost.
  2. The new integration test actually exercises the real ssh2 path (no loadSSH2 mock) and asserts the launch-checkpoint printf.
  3. No unrelated files modified.
  4. No secrets, credentials, or private keys committed.

Respond with one of:
  - REVIEW_OK — diff is correct and ready to commit
  - REVIEW_BLOCK: <reason> — do not commit; explain what's wrong

Do not edit files in this step. Review only.`,
      verification: { type: 'output_contains', value: 'REVIEW_OK' },
    })

    // ── Phase 9: Summary ─────────────────────────────────────────────
    .step('summary', {
      type: 'deterministic',
      dependsOn: ['review-diff'],
      command: `set -e
cat <<'EOF'
════════════════════════════════════════════════════════════════
  validate-cloud-connect-e2e — ALL GATES GREEN
════════════════════════════════════════════════════════════════

Acceptance contract:
  A1  scripts/build-bun.sh has zero --external ssh2         PASS
  A2  ssh-interactive + auth unit tests green               PASS
  A3  npx tsc --noEmit clean                                PASS
  A4  tests/integration/ssh-interactive-live.test.ts green  PASS
  A5  .release/agent-relay --version works                  PASS
  A6  Built binary contains ssh2 symbols                    PASS
  A7  Regression suite green                                PASS
  A8  Reviewer approved diff                                PASS

Next steps (MANUAL — not covered by this workflow):

  1. Commit and push on fix/cloud-connect-bundle-ssh2:

       git add scripts/build-bun.sh tests/integration/ssh-interactive-live.test.ts
       git commit -m "fix(cli): bundle ssh2 into Bun binary so cloud connect exercises the ssh2 path"
       git push -u origin fix/cloud-connect-bundle-ssh2

  2. Live Daytona validation against a real sandbox BEFORE releasing:

       # This requires CLOUD_API_* credentials and a real cloud workspace.
       # Expect to see the dim '[agent-relay] launching provider CLI…'
       # breadcrumb appear within 1-2 seconds of 'Starting interactive
       # authentication…'. If that line does not appear, the fix did not
       # land and the ssh2 branch is still being skipped.

       AGENT_RELAY_DEBUG_SSH=1 ./.release/agent-relay cloud connect claude

       Success criteria:
         - Unified 'Starting interactive authentication…' banner prints
         - Dim '[agent-relay] launching provider CLI…' breadcrumb prints
           within 1-2s
         - Claude TUI renders within 15s
         - First-byte debug log shows non-zero elapsedMs
         - AGENT_RELAY_DEBUG_SSH output shows 'shell-request' then
           'shell-opened' then 'shell-write'

  3. Open PR, get review, merge, cut new release.

════════════════════════════════════════════════════════════════
EOF`,
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
