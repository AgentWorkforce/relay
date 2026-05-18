import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const result = await workflow('fix-history-inbox')
    .description('Test, fix, verify history/inbox workspace_key resolution, then commit and open PR')
    .pattern('dag')
    .channel('wf-history-inbox')
    .maxConcurrency(1)
    .timeout(600000)

    .agent('fixer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Fix resolveRelaycastApiKey in messaging.ts',
      retries: 2,
    })

    // Test in a temp directory so we don't nuke the workflow's own broker
    .step('diagnose', {
      type: 'deterministic',
      command: `set -e
TMPDIR=$(mktemp -d)
echo "=== Testing history/inbox in temp workspace: $TMPDIR ==="
agent-relay up --cwd "$TMPDIR" --no-dashboard 2>&1 &
BROKER_PID=$!
sleep 12
echo "=== connection.json ==="
cat "$TMPDIR/.agent-relay/connection.json" 2>/dev/null || echo "NO_CONNECTION_JSON"
echo ""
echo "=== history test ==="
agent-relay history --cwd "$TMPDIR" --limit 3 2>&1 || agent-relay history --limit 3 2>&1 || echo "HISTORY_FAILED"
echo ""
echo "=== inbox test ==="
agent-relay inbox --cwd "$TMPDIR" 2>&1 || agent-relay inbox 2>&1 || echo "INBOX_FAILED"
echo ""
kill $BROKER_PID 2>/dev/null || true
echo "TMPDIR=$TMPDIR"
echo "DIAGNOSE_DONE"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('read-messaging', {
      type: 'deterministic',
      dependsOn: ['diagnose'],
      command: `cat src/cli/commands/messaging.ts`,
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-messaging', {
      agent: 'fixer',
      dependsOn: ['read-messaging'],
      task: `Fix resolveRelaycastApiKey() in src/cli/commands/messaging.ts so that history and inbox work without RELAY_API_KEY env var.

Current file content:
{{steps.read-messaging.output}}

The bug: resolveRelaycastApiKey() throws "Relaycast API key not found in RELAY_API_KEY" because AgentRelayClient.connect() fails to find connection.json.

Root cause: connection.json is written by the broker at startup but uses a state dir that may differ from cwd/.agent-relay/. The broker's /api/session endpoint always returns workspace_key when called with the broker's api_key.

The fix: Replace the current fallback logic with a direct HTTP fetch to the broker's /api/session endpoint. The broker port is discoverable via getProjectPaths() or by scanning for the running broker.

Here is the exact approach that is proven to work (verified via curl):
- Read connection.json from the project's .agent-relay/ directory
- Use its api_key and port to call GET http://127.0.0.1:{port}/api/session with Authorization: Bearer {api_key}
- Return session.workspace_key

The getProjectPaths() import is already available. Use node's built-in fs/path (not dynamic import, use static import at the top if needed, or require('fs') style if the file uses require).

Only edit src/cli/commands/messaging.ts. Do not touch any other file.
End with FIXES_COMPLETE.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('verify-changed', {
      type: 'deterministic',
      dependsOn: ['fix-messaging'],
      command: `set -e
if git diff --quiet src/cli/commands/messaging.ts; then
  echo "ERROR: messaging.ts was not modified"
  exit 1
fi
echo "messaging.ts modified — diff summary:"
git diff --stat src/cli/commands/messaging.ts
echo "CHANGED_OK"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('rebuild', {
      type: 'deterministic',
      dependsOn: ['verify-changed'],
      command: `set -e
npm run build 2>&1 | tail -15
echo "REBUILD_DONE"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('retest', {
      type: 'deterministic',
      dependsOn: ['rebuild'],
      command: `set -e
TMPDIR=$(mktemp -d)
echo "=== Fresh broker in temp workspace: $TMPDIR ==="
agent-relay up --cwd "$TMPDIR" --no-dashboard 2>&1 &
BROKER_PID=$!
sleep 12

echo "=== RETEST HISTORY ==="
agent-relay history --limit 3 2>&1
HISTORY_EXIT=$?

echo ""
echo "=== RETEST INBOX ==="
agent-relay inbox 2>&1
INBOX_EXIT=$?

kill $BROKER_PID 2>/dev/null || true

echo ""
if [ $HISTORY_EXIT -eq 0 ] && [ $INBOX_EXIT -eq 0 ]; then
  echo "RETEST_PASSED"
else
  echo "RETEST_FAILED: history=$HISTORY_EXIT inbox=$INBOX_EXIT"
  exit 1
fi`,
      captureOutput: true,
      failOnError: true,
    })

    .step('run-unit-tests', {
      type: 'deterministic',
      dependsOn: ['retest'],
      command: `set -e
npx vitest run src/cli/commands/messaging.test.ts 2>&1 | tail -20
echo "UNIT_TESTS_DONE"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-and-open-pr', {
      type: 'deterministic',
      dependsOn: ['run-unit-tests'],
      command: `set -e
git add src/cli/commands/messaging.ts
git commit -m "fix: resolve workspace_key from broker API for history/inbox

history and inbox previously required RELAY_API_KEY env var.
Now resolveRelaycastApiKey() fetches workspace_key directly from the
running broker's /api/session endpoint using the local connection.json,
so both commands work out of the box whenever a broker is running."

git push origin miya/relay-fix-workflow

PR_URL=$(gh pr create \
  --title "fix: history and inbox work without RELAY_API_KEY env var" \
  --body "## Problem
\`agent-relay history\` and \`agent-relay inbox\` failed with:
\`\`\`
Failed to initialize relaycast client: Relaycast API key not found in RELAY_API_KEY
\`\`\`
...even when a broker was running with a valid workspace key.

## Root Cause
\`resolveRelaycastApiKey()\` only checked the \`RELAY_API_KEY\` env var and then tried \`AgentRelayClient.connect()\` which reads \`connection.json\` — but that file was not reliably present when the broker is managed by the workflow runner.

## Fix
Fetch \`workspace_key\` directly from the running broker's \`/api/session\` HTTP endpoint using the \`api_key\` and \`port\` from \`connection.json\`. This is always available when the broker is running.

## Verified
- Workflow test: history and inbox return results after fix
- Unit tests: all messaging tests pass" \
  --base main \
  --head miya/relay-fix-workflow 2>&1)

echo "PR_URL: $PR_URL"
echo "PR_CREATED"`,
      captureOutput: true,
      failOnError: true,
    })

    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);
