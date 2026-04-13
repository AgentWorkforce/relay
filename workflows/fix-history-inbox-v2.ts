import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const result = await workflow('fix-history-inbox-v2')
    .description('Fix history/inbox to work without RELAY_API_KEY - diagnose, fix, verify, PR')
    .pattern('dag')
    .channel('wf-fix-history')
    .maxConcurrency(1)
    .timeout(600000)

    .agent('fixer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Fix resolveRelaycastApiKey to fetch workspace_key from broker HTTP API',
      retries: 2,
    })

    .step('diagnose', {
      type: 'deterministic',
      command: `set -e
echo "=== Testing history ==="
agent-relay history --limit 3 2>&1 || echo "HISTORY_FAILED"
echo ""
echo "=== Testing inbox ==="
agent-relay inbox 2>&1 || echo "INBOX_FAILED"
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
      task: `Fix src/cli/commands/messaging.ts so history and inbox work without RELAY_API_KEY env var.

Current resolveRelaycastApiKey function needs to be replaced with direct HTTP fetch.

Required fix:
1. Add imports at TOP of file (after existing imports): import fs from 'node:fs'; import path from 'node:path';

2. Replace the ENTIRE resolveRelaycastApiKey function with:
async function resolveRelaycastApiKey(cwd: string): Promise<string> {
  const envApiKey = process.env.RELAY_API_KEY?.trim();
  if (envApiKey) { return envApiKey; }

  const connectionPath = path.join(getProjectPaths(cwd).dataDir, 'connection.json');
  let raw: string;
  try { raw = fs.readFileSync(connectionPath, 'utf-8'); }
  catch { throw new Error("Failed to read broker connection. Start broker with agent-relay up or set RELAY_API_KEY"); }

  let parsed: { port?: unknown; api_key?: unknown };
  try { parsed = JSON.parse(raw) as { port?: unknown; api_key?: unknown }; }
  catch { throw new Error("Invalid broker connection metadata"); }

  const port = parsed.port; const apiKey = parsed.api_key;
  if (typeof port !== 'number' || !Number.isInteger(port) || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error("Invalid broker connection metadata");
  }

  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/api/session\`, {
      headers: { Authorization: \`Bearer \${apiKey}\` },
    });
    if (!response.ok) { throw new Error(\`broker session failed (\${response.status})\`); }
    const session = (await response.json()) as { workspaceKey?: string | null; workspace_key?: string | null };
    const workspaceKey = session.workspaceKey ?? session.workspace_key;
    if (workspaceKey && typeof workspaceKey === 'string' && workspaceKey.trim()) { return workspaceKey.trim(); }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(\`Failed to query broker session: \${detail}\`);
  }

  throw new Error("No Relaycast workspace key found. Set RELAY_API_KEY or start broker");
}

Only edit src/cli/commands/messaging.ts. Do NOT edit any other file.
End with FIXES_COMPLETE when done.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('rebuild', {
      type: 'deterministic',
      dependsOn: ['fix-messaging'],
      command: `set -e
npm run build 2>&1 | tail -10
echo "REBUILD_DONE"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('retest', {
      type: 'deterministic',
      dependsOn: ['rebuild'],
      command: `set -e
agent-relay down --force 2>/dev/null || true
sleep 2
rm -rf .agent-relay
sleep 1
agent-relay up 2>&1 &
sleep 15

echo "=== RETEST HISTORY ==="
agent-relay history --limit 3 2>&1
HISTORY_EXIT=$?

echo ""
echo "=== RETEST INBOX ==="
agent-relay inbox 2>&1
INBOX_EXIT=$?

echo ""
if [ $HISTORY_EXIT -eq 0 ] && [ $INBOX_EXIT -eq 0 ]; then echo "RETEST_PASSED"
else echo "RETEST_FAILED: history=$HISTORY_EXIT inbox=$INBOX_EXIT"; exit 1; fi`,
      captureOutput: true,
      failOnError: true,
    })

    .step('commit-pr', {
      type: 'deterministic',
      dependsOn: ['retest'],
      command: `set -e
git add src/cli/commands/messaging.ts
git commit -m "fix: fetch workspace_key from broker HTTP API for history/inbox"
git push origin miya/relay-fix-workflow
PR_URL=$(gh pr create --title "fix: history and inbox work without RELAY_API_KEY" --body "## Problem
history and inbox failed with: 'Relaycast API key not found in RELAY_API_KEY'

## Fix
resolveRelaycastApiKey() now reads connection.json manually using fs/path
and calls the broker's /api/session HTTP endpoint to get workspace_key.

## Verified
- history --limit 3 works
- inbox works
- Works without RELAY_API_KEY set" --base main --head miya/relay-fix-workflow 2>&1)
echo "PR_URL: $PR_URL"
echo "PR_CREATED"`,
      captureOutput: true,
      failOnError: true,
    })

    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);