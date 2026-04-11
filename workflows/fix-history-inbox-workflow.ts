import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const result = await workflow('fix-history-inbox-workflow')
    .description('Test and fix history/inbox to work without RELAY_API_KEY env var')
    .pattern('dag')
    .channel('wf-history-inbox')
    .maxConcurrency(1)
    .timeout(600000)

    .agent('fixer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Fix history/inbox workspace_key resolution',
      retries: 2,
    })

    .step('start-broker', {
      type: 'deterministic',
      command: `set -e
agent-relay down --force 2>/dev/null || true
rm -rf .agent-relay
sleep 2
agent-relay up 2>&1 &
sleep 15
agent-relay status 2>&1 | head -5
echo "BROKER_STARTED"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('test-history', {
      type: 'deterministic',
      dependsOn: ['start-broker'],
      command: `set -e
echo "=== TEST: agent-relay history ==="
agent-relay history --limit 3 2>&1 || echo "HISTORY_FAILED"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('test-inbox', {
      type: 'deterministic',
      dependsOn: ['test-history'],
      command: `set -e
echo "=== TEST: agent-relay inbox ==="
agent-relay inbox 2>&1 || echo "INBOX_FAILED"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-history-inbox', {
      agent: 'fixer',
      dependsOn: ['test-history', 'test-inbox'],
      task: `Fix history and inbox commands to work without RELAY_API_KEY env var.

Test outputs:
history: {{steps.test-history.output}}
inbox: {{steps.test-inbox.output}}

The issue: 
- broker creates workspace_key (rk_live_...) but it's not persisted to connection.json
- CLI needs to fetch workspace_key from broker's /api/session endpoint
- Current code tries AgentRelayClient.connect() but connection.json may be missing/inaccessible

Required fix:
1. In src/cli/commands/messaging.ts, resolveRelaycastApiKey() should:
   - First check RELAY_API_KEY env var
   - Try to read from connection.json if it exists
   - If not, call broker API directly to get workspace_key from /api/session

The broker exposes /api/session which returns {"workspace_key": "rk_live_..."} when authenticated.

Example fix approach:
\`\`\`typescript
async function resolveRelaycastApiKey(cwd: string): Promise<string> {
  // Check env first
  const envKey = process.env.RELAY_API_KEY?.trim();
  if (envKey) return envKey;

  // Try direct broker API call
  try {
    const conn = JSON.parse(fs.readFileSync(path.join(cwd, '.agent-relay', 'connection.json'), 'utf-8');
    const resp = await fetch(\`http://127.0.0.1:\${conn.port}/api/session\`, {
      headers: { 'Authorization': \`Bearer \${conn.api_key}\` }
    });
    const session = await resp.json();
    if (session.workspace_key) return session.workspace_key;
  } catch {}

  throw new Error('No workspace key found');
}
\`\`\`

Fix the code in src/cli/commands/messaging.ts, rebuild, test again.
End with FIXES_COMPLETE when done.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('rebuild', {
      type: 'deterministic',
      dependsOn: ['fix-history-inbox'],
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
rm -rf .agent-relay
sleep 2
agent-relay up 2>&1 &
sleep 15
echo "=== RETEST HISTORY ==="
agent-relay history --limit 3 2>&1
echo ""
echo "=== RETEST INBOX ==="
agent-relay inbox 2>&1
echo "RETEST_DONE"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('cleanup', {
      type: 'deterministic',
      dependsOn: ['retest'],
      command: `set -e
agent-relay down --force 2>/dev/null || true
echo "CLEANUP_DONE"`,
      captureOutput: true,
      failOnError: false,
    })

    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);