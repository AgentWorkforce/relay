import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

await workflow('fix-agent-relay-local-bootstrap-and-messaging')
  .description('Diagnose and fix local agent-relay install/bootstrap/messaging failures on macOS, then verify broker startup, worker spawn, and CLI communication in a real repo.')
  .pattern('dag')
  .channel('wf-relay-fix')
  .maxConcurrency(4)
  .timeout(3600000)

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'Relay fix lead coordinating diagnosis and acceptance checks',
    model: ClaudeModels.SONNET,
    retries: 2,
  })
  .agent('impl-a', {
    cli: 'codex',
    preset: 'worker',
    role: 'Installer and launcher path implementer',
    model: CodexModels.GPT_5_4,
    retries: 2,
  })
  .agent('impl-b', {
    cli: 'codex',
    preset: 'worker',
    role: 'CLI messaging and local-mode behavior implementer',
    model: CodexModels.GPT_5_4,
    retries: 2,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Verification reviewer for fixes and regressions',
    model: ClaudeModels.SONNET,
    retries: 2,
  })

  .step('capture-current-failures', {
    type: 'deterministic',
    command: `
      set -e
      cd "$PWD"
      echo '## PATH' > /tmp/relay-fix-baseline.txt
      printf '%s\n' "$PATH" >> /tmp/relay-fix-baseline.txt
      echo '\n## which/type agent-relay' >> /tmp/relay-fix-baseline.txt
      (which -a agent-relay || true) >> /tmp/relay-fix-baseline.txt 2>&1
      (type -a agent-relay || true) >> /tmp/relay-fix-baseline.txt 2>&1
      echo '\n## installer smoke' >> /tmp/relay-fix-baseline.txt
      (bash install.sh || true) >> /tmp/relay-fix-baseline.txt 2>&1
      echo '\n## local launcher smoke' >> /tmp/relay-fix-baseline.txt
      (env PATH="$HOME/.local/bin:$PATH" agent-relay --version || true) >> /tmp/relay-fix-baseline.txt 2>&1
      cat /tmp/relay-fix-baseline.txt
    `,
    captureOutput: true,
    failOnError: false,
  })

  .step('read-plan-doc', {
    type: 'deterministic',
    dependsOn: ['capture-current-failures'],
    command: 'cat workflows/PLAN-relay-fix-workflow.md',
    captureOutput: true,
    failOnError: true,
  })

  .step('fix-installer-and-launcher', {
    agent: 'impl-a',
    dependsOn: ['read-plan-doc'],
    task: `Implement the installer/bootstrap fixes in ~/Projects/AgentWorkforce/relay.

Plan document:
{{steps.read-plan-doc.output}}

Observed baseline:
{{steps.capture-current-failures.output}}

Requirements:
- ensure install.sh leaves users with a working \`agent-relay\` command on macOS
- handle stale shim/symlink situations safely
- prefer a real launcher in ~/.local/bin when appropriate
- improve install verification and failure messaging when standalone binary validation fails
- do not edit unrelated files

Write code to disk. Do not just describe changes.
Only edit the files necessary for installer/bootstrap behavior.
End by printing CHANGES_COMPLETE.`,
    verification: { type: 'exit_code' },
    retries: 2,
  })

  .step('fix-cli-messaging-local-mode', {
    agent: 'impl-b',
    dependsOn: ['read-plan-doc'],
    task: `Implement local broker messaging fixes in ~/Projects/AgentWorkforce/relay.

Plan document:
{{steps.read-plan-doc.output}}

Observed baseline:
{{steps.capture-current-failures.output}}

Requirements:
- fix or harden \`agent-relay send\` in local broker mode so default sender behavior does not break message delivery
- fix or clarify \`agent-relay history\` behavior in local mode when RELAY_API_KEY is absent
- prefer code fixes over docs-only work if behavior is incorrect
- do not edit unrelated files

Write code to disk. Do not just describe changes.
Only edit files necessary for local messaging/history behavior.
End by printing CHANGES_COMPLETE.`,
    verification: { type: 'exit_code' },
    retries: 2,
  })

  .step('verify-files-changed', {
    type: 'deterministic',
    dependsOn: ['fix-installer-and-launcher', 'fix-cli-messaging-local-mode'],
    command: `
      set -e
      cd "$PWD"
      if git diff --quiet; then
        echo 'NO_CHANGES_DETECTED'
        exit 1
      fi
      git diff --stat
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('install-deps', {
    type: 'deterministic',
    dependsOn: ['verify-files-changed'],
    command: `
      set -e
      cd "$PWD"
      npm install
    `,
    failOnError: true,
  })

  .step('build-config', {
    type: 'deterministic',
    dependsOn: ['install-deps'],
    command: `
      set -e
      cd "$PWD"
      npm run -w @agent-relay/config build
    `,
    failOnError: true,
  })

  .step('build-sdk', {
    type: 'deterministic',
    dependsOn: ['build-config'],
    command: `
      set -e
      cd "$PWD"
      npm exec --package typescript@5.7.3 -- tsc -p packages/sdk/tsconfig.build.json
    `,
    failOnError: true,
  })

  .step('build-all', {
    type: 'deterministic',
    dependsOn: ['build-sdk'],
    command: `
      set -e
      cd "$PWD"
      npm run build
    `,
    failOnError: true,
  })

  .step('smoke-test-local-launcher', {
    type: 'deterministic',
    dependsOn: ['build-all'],
    command: `
      set -e
      cd "$PWD"
      bash install.sh || true
      env PATH="$HOME/.local/bin:$PATH" agent-relay --version
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('integration-test-sage', {
    type: 'deterministic',
    dependsOn: ['smoke-test-local-launcher'],
    command: `
      set -e
      cd ~/Projects/AgentWorkforce/sage
      env PATH="$HOME/.local/bin:$PATH" agent-relay down --force --timeout 5000 >/dev/null 2>&1 || true
      env PATH="$HOME/.local/bin:$PATH" agent-relay up --no-dashboard --verbose >/tmp/sage-relay-workflow.log 2>&1 &
      BROKER_PID=$!
      sleep 5
      env PATH="$HOME/.local/bin:$PATH" agent-relay status
      env PATH="$HOME/.local/bin:$PATH" agent-relay spawn WorkflowProbe claude "Reply with exactly: ACK from WorkflowProbe. Then wait for another message."
      sleep 5
      env PATH="$HOME/.local/bin:$PATH" agent-relay who
      env PATH="$HOME/.local/bin:$PATH" agent-relay send WorkflowProbe "Reply with exactly: SECOND ACK from WorkflowProbe." --from Miya
      sleep 5
      env PATH="$HOME/.local/bin:$PATH" agent-relay agents:logs WorkflowProbe | tail -n 120
      env PATH="$HOME/.local/bin:$PATH" agent-relay release WorkflowProbe || true
      env PATH="$HOME/.local/bin:$PATH" agent-relay down --force --timeout 5000 || true
      wait $BROKER_PID || true
    `,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['read-plan-doc', 'verify-files-changed', 'smoke-test-local-launcher', 'integration-test-sage'],
    task: `Review the relay fixes and test evidence.

Plan:
{{steps.read-plan-doc.output}}

Changed files evidence:
{{steps.verify-files-changed.output}}

Launcher smoke test:
{{steps.smoke-test-local-launcher.output}}

Sage integration test:
{{steps.integration-test-sage.output}}

Produce:
1. PASS_FAIL verdict
2. what is fixed
3. what still fails, if anything
4. precise follow-up recommendations

End with REVIEW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    retries: 2,
  })

  .run({ cwd: process.cwd() });
