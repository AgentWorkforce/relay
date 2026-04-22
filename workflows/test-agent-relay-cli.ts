import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const result = await workflow('test-agent-relay-cli-commands')
    .description('TDD test for agent-relay CLI commands: spawn, who, agents:logs, release, set-model, send, history, inbox with all subcommands and options')
    .pattern('dag')
    .channel('wf-cli-test')
    .maxConcurrency(3)
    .timeout(3600000)

    .agent('lead', {
      cli: 'claude',
      preset: 'lead',
      role: 'Architect coordinating test creation and verification',
      model: 'sonnet-4-20250514',
      retries: 2,
    })
    .agent('codex', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implementation agent for fixing CLI bugs',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'analyst',
      role: 'Running tests and verifying fixes',
      retries: 2,
    })

    .step('map-commands', {
      type: 'deterministic',
      command: `
        set -e
        cd "$PWD"
        echo "=== CLI COMMAND STRUCTURE ==="
        node dist/src/cli/index.js --help 2>&1 | head -50
        echo ""
        echo "=== spawn help ==="
        node dist/src/cli/index.js spawn --help 2>&1
        echo ""
        echo "=== who help ==="
        node dist/src/cli/index.js who --help 2>&1
        echo ""
        echo "=== agents help ==="
        node dist/src/cli/index.js agents --help 2>&1
        echo ""
        echo "=== release help ==="
        node dist/src/cli/index.js release --help 2>&1
        echo ""
        echo "=== set-model help ==="
        node dist/src/cli/index.js set-model --help 2>&1
        echo ""
        echo "=== send help ==="
        node dist/src/cli/index.js send --help 2>&1
        echo ""
        echo "=== history help ==="
        node dist/src/cli/index.js history --help 2>&1
        echo ""
        echo "=== inbox help ==="
        node dist/src/cli/index.js inbox --help 2>&1
      `,
      captureOutput: true,
      failOnError: false,
    })

    .step('write-tests', {
      agent: 'lead',
      dependsOn: ['map-commands'],
      task: `Create TDD tests for agent-relay CLI commands.

CLI help:
{{steps.map-commands.output}}

Commands: spawn, who, agents:logs, release, set-model, send, history, inbox

Write to: tests/integration/cli-commands.test.ts

Test against LIVE broker (not mocked). End with TESTS_WRITTEN.`,
      verification: { type: 'output_contains', value: 'TESTS_WRITTEN' },
      retries: 2,
    })

    .step('run-tests', {
      agent: 'tester',
      dependsOn: ['write-tests'],
      task: `Run tests against live broker.

Setup:
1. agent-relay down --force --timeout 5000 || true
2. agent-relay up --no-dashboard --verbose > /tmp/broker.log 2>&1 &
3. sleep 8

Test all commands. Report PASS/FAIL per command.
End with TEST_RESULTS_COMPLETE.`,
      verification: { type: 'output_contains', value: 'TEST_RESULTS_COMPLETE' },
      retries: 2,
    })

    .step('fix-broken', {
      agent: 'codex',
      dependsOn: ['run-tests'],
      task: `Fix broken CLI commands.

Test report:
{{steps.run-tests.output}}

Focus on src/cli/commands/messaging.ts and agent-management.ts.
End with FIXES_COMPLETE.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('retest', {
      agent: 'tester',
      dependsOn: ['fix-broken'],
      task: `Retest all commands after fixes.

Restart broker and test again.
End with RETEST_COMPLETE.`,
      verification: { type: 'output_contains', value: 'RETEST_COMPLETE' },
      retries: 2,
    })

    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);