import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const smokeScript = resolve('scripts/ci-standalone-smoke.sh');
const temporaryDirectories: string[] = [];

function makeExecutable(directory: string, name: string, contents: string): string {
  const path = join(directory, name);
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function createFakeBinaries(): { cli: string; broker: string; invocationLog: string; toolsPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'relay-standalone-smoke-test-'));
  temporaryDirectories.push(directory);

  const invocationLog = join(directory, 'invocations.log');
  writeFileSync(invocationLog, '');
  const toolsPath = join(directory, 'tools');
  mkdirSync(toolsPath);
  makeExecutable(
    toolsPath,
    'curl',
    `#!/usr/bin/env bash
set -euo pipefail
output=/dev/null
headers=/dev/null
method=GET
url=
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    --output) output="\$2"; shift 2 ;;
    --dump-header) headers="\$2"; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    --request) method="\$2"; shift 2 ;;
    --write-out) shift 2 ;;
    --data|--header) shift 2 ;;
    *) url="\$1"; shift ;;
  esac
done
if [[ "$method" = POST && "$url" = */v1/workspaces ]]; then
  printf '%s' '{"data":{"api_key":"rk_live_fake_smoke_key","workspace_id":"rw_fake_smoke"}}' > "\$output"
  echo 201
elif [[ "$method" = DELETE && "$url" = */v1/workspace ]]; then
  delete_status="\${FAKE_DELETE_STATUS:-204}"
  if [ "$delete_status" != 200 ] && [ "$delete_status" != 204 ]; then
    printf '%s' '{"error":{"code":"internal_error","message":"rk_live_delete_body_must_not_print"}}' > "\$output"
  fi
  echo "$delete_status"
elif [[ "$method" = GET && "$url" = */v1/workspace ]]; then
  verify_status="\${FAKE_VERIFY_STATUS:-401}"
  if [ -n "\${FAKE_VERIFY_STATUSES:-}" ]; then
    verify_count_file="\${INVOCATION_LOG}.verify-count"
    verify_count=0
    if [ -f "\$verify_count_file" ]; then
      verify_count="\$(<"\$verify_count_file")"
    fi
    IFS=',' read -r -a verify_statuses <<< "\$FAKE_VERIFY_STATUSES"
    verify_index="\$verify_count"
    if [ "\$verify_index" -ge "\${#verify_statuses[@]}" ]; then
      verify_index="\$((\${#verify_statuses[@]} - 1))"
    fi
    verify_status="\${verify_statuses[\$verify_index]}"
    printf '%s\n' "\$((verify_count + 1))" > "\$verify_count_file"
  fi
  if [ -n "\${FAKE_VERIFY_RETRY_AFTER:-}" ]; then
    retry_after_header="\${FAKE_VERIFY_RETRY_AFTER_HEADER:-Retry-After}"
    printf 'HTTP/2 %s\r\n%s: %s\r\n\r\n' "\$verify_status" "\$retry_after_header" "\$FAKE_VERIFY_RETRY_AFTER" > "\$headers"
  fi
  echo "\$verify_status"
else
  echo 500
fi
`
  );
  makeExecutable(
    toolsPath,
    'sleep',
    `#!/usr/bin/env bash
printf 'sleep %s\n' "\${1:-}" >> "$INVOCATION_LOG"
`
  );
  makeExecutable(
    toolsPath,
    'jq',
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-cn" ]; then
  echo '{"name":"fake","expires_in_seconds":300}'
elif [ "\${1:-}" = "-er" ] && [[ "\${2:-}" = *api_key* ]]; then
  echo 'rk_live_fake_smoke_key'
elif [ "\${1:-}" = "-er" ] && [[ "\${2:-}" = *workspace_id* ]]; then
  echo 'rw_fake_smoke'
elif [ "\${1:-}" = "-er" ] && [[ "\${2:-}" = *error.code* ]] && [ -n "\${FAKE_DELETE_ERROR_CODE:-}" ]; then
  echo "\$FAKE_DELETE_ERROR_CODE"
else
  exit 1
fi
`
  );
  const broker = makeExecutable(
    directory,
    'broker',
    `#!/usr/bin/env bash
printf 'broker\\n' >> "$INVOCATION_LOG"
exit 0
`
  );
  const cli = makeExecutable(
    directory,
    'relay',
    `#!/usr/bin/env bash
set -euo pipefail
printf 'cli %s %s\\n' "\${1:-}" "\${2:-}" >> "$INVOCATION_LOG"

if [ "\${1:-}" != "node" ]; then
  exit 64
fi

case "\${2:-}" in
  status)
    echo "Status: STOPPED"
    ;;
  down)
    if [ "\${FAKE_READY_AFTER_SECOND_DOWN:-}" = "1" ] && [ "$(grep -c '^cli node down$' "$INVOCATION_LOG" || true)" -ge 2 ]; then
      # Wait for the fixture's late startup output before cleanup tails its log.
      for ((attempt=0; attempt<200; attempt++)); do
        if grep -q '^up-ready$' "$INVOCATION_LOG"; then break; fi
        sleep 0.01
      done
    fi
    echo "No verified orphan broker found; retained existing state."
    ;;
  up)
    if [ "\${RELAY_BASE_URL:-}" != "https://cast.agentrelay.com" ]; then
      echo "trusted Relaycast base URL missing" >&2
      exit 65
    fi
    if [ -n "\${RELAY_WORKSPACES_JSON:-}" ]; then
      echo "ambient multi-workspace session was not cleared" >&2
      exit 68
    fi
    if [ "\${3:-}" != "--broker-name" ] || [ -z "\${4:-}" ]; then
      echo "unique broker name missing" >&2
      exit 66
    fi
    if [ "\${FAKE_READY_AFTER_SECOND_DOWN:-}" = "1" ]; then
      printf 'up-waiting\\n' >> "$INVOCATION_LOG"
      while [ "$(grep -c '^cli node down$' "$INVOCATION_LOG" || true)" -lt 2 ]; do
        sleep 0.01
      done
    fi
    echo 'Workspace source: environment ($RELAY_WORKSPACE_KEY)'
    if [ "\${FAKE_WORKSPACE_MODE:-joined}" = "created" ]; then
      echo "Workspace: created new workspace rw_throwaway"
    else
      echo "Workspace: joined rw_ci"
    fi
    echo "Broker started."
    if [ "\${FAKE_READY_AFTER_SECOND_DOWN:-}" = "1" ]; then
      printf 'up-ready\\n' >> "$INVOCATION_LOG"
    fi
    ;;
  *)
    exit 67
    ;;
esac
`
  );

  return { cli, broker, invocationLog, toolsPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ci-standalone-smoke workspace reuse', () => {
  it('disarms the EXIT trap before entering the cleanup subshell', () => {
    const script = readFileSync(smokeScript, 'utf8');
    const cleanupBody = script.match(/^cleanup\(\) \{\n([\s\S]*?)^\}$/m)?.[1];
    expect(cleanupBody).toBeDefined();

    const trapDisarmIndex = cleanupBody!.indexOf('trap - EXIT');
    const cleanupSubshellIndex = cleanupBody!.search(/^\s*\($/m);
    expect(trapDisarmIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupSubshellIndex).toBeGreaterThan(trapDisarmIndex);
  });

  it('creates an ephemeral workspace on the trusted engine and wires its base URL explicitly', () => {
    const script = readFileSync(smokeScript, 'utf8');
    expect(script).toContain('TRUSTED_RELAY_BASE_URL="https://cast.agentrelay.com"');
    expect(script).toContain('WORKSPACE_LEASE_SECONDS=300');
    expect(script).toContain('CURL_CONNECT_TIMEOUT_SECONDS=10');
    expect(script).toContain('CURL_MAX_TIME_SECONDS=60');
    expect(script).toContain('--connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS"');
    expect(script).toContain('--max-time "$CURL_MAX_TIME_SECONDS"');
    expect(script).toContain('expires_in_seconds: $expires');
    expect(script).toContain('printf \'::add-mask::%s\\n\' "$WORKSPACE_KEY"');
    expect(script).toContain('--request DELETE');
    expect(script).toContain('Ephemeral workspace deletion verified');
    for (const workflow of ['.github/workflows/package-validation.yml', '.github/workflows/publish.yml']) {
      expect(readFileSync(resolve(workflow), 'utf8')).not.toContain('RELAY_CI_WORKSPACE_KEY');
    }
  });

  it('reports the create HTTP status and sanitized error code when no key is returned', () => {
    const script = readFileSync(smokeScript, 'utf8');
    expect(script).toContain('CREATE_ERROR_CODE=');
    expect(script).toContain('did not contain an API key (HTTP ${CREATE_STATUS:-unknown}');
    expect(script).toContain('error code ${CREATE_ERROR_CODE}');
    expect(script).not.toContain('cat "$WORKSPACE_RESPONSE"');
  });

  it('keeps the outer startup deadline above the broker aggregate handshake budget', () => {
    const script = readFileSync(smokeScript, 'utf8');
    const brokerSession = readFileSync(resolve('crates/broker/src/runtime/session.rs'), 'utf8');
    const minimumSeconds = Number(script.match(/MIN_STARTUP_TIMEOUT_SECONDS=([0-9]+)/)?.[1]);
    const maximumSeconds = Number(script.match(/MAX_STARTUP_TIMEOUT_SECONDS=([0-9]+)/)?.[1]);
    const leaseSeconds = Number(script.match(/WORKSPACE_LEASE_SECONDS=([0-9]+)/)?.[1]);
    const smokeSeconds = Number(
      script.match(/AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS:-([0-9]+)}/)?.[1]
    );
    const brokerSeconds = Number(
      brokerSession.match(/const HANDSHAKE_TOTAL_TIMEOUT:[^=]+=[\s\n]*Duration::from_secs\(([0-9]+)\);/)?.[1]
    );

    expect(minimumSeconds).toBeGreaterThanOrEqual(brokerSeconds + 10);
    expect(smokeSeconds).toBeGreaterThanOrEqual(minimumSeconds);
    expect(leaseSeconds - maximumSeconds).toBeGreaterThanOrEqual(60);
  });

  it('rejects unsafe startup-timeout overrides before invoking binaries', () => {
    for (const [override, expectedMessage] of [
      ['49', 'must be at least 50s'],
      ['050', 'without leading zeros'],
      ['060', 'without leading zeros'],
      ['08', 'without leading zeros'],
      ['241', 'must be no more than 240s'],
      ['99999', 'must be no more than 240s'],
      ['9223372036854775808', 'between 50s and 240s'],
    ]) {
      const { cli, broker, invocationLog } = createFakeBinaries();
      const result = spawnSync('bash', [smokeScript, cli, broker], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS: override,
          INVOCATION_LOG: invocationLog,
        },
      });

      expect(result.status, `${override}: ${result.stderr}`).toBe(2);
      expect(result.stderr, override).toContain(expectedMessage);
      expect(readFileSync(invocationLog, 'utf8'), override).toBe('');
    }
  });

  it('mints and cleans up the ephemeral workspace without printing its key', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Ephemeral workspace deletion verified');
    // The GitHub workflow command necessarily carries the value once so the
    // runner can mask it; all ordinary output must remain free of the key.
    const ordinaryOutput = result.stdout.replace(/::add-mask::[^\n]*\n/g, '');
    expect(ordinaryOutput).not.toContain('rk_live_fake_smoke_key');
    expect(result.stderr).not.toContain('rk_live_fake_smoke_key');
  });

  it('accepts a successful delete without adding a follow-up read dependency', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
        FAKE_DELETE_STATUS: '204',
        FAKE_VERIFY_STATUS: '503',
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Ephemeral workspace deletion verified');
    expect(result.stderr).not.toContain('follow-up HTTP');
  });

  it('accepts an ambiguous delete response only when the follow-up proves absence', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
        FAKE_DELETE_STATUS: '500',
        FAKE_DELETE_ERROR_CODE: 'internal_error',
        FAKE_VERIFY_STATUS: '401',
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Ephemeral workspace deletion verified after ambiguous DELETE HTTP 500, error code internal_error'
    );
    expect(result.stdout).not.toContain('rk_live_delete_body_must_not_print');
    expect(result.stderr).not.toContain('rk_live_delete_body_must_not_print');
  });

  it('retries a transient verification read and honors bounded Retry-After', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
        FAKE_DELETE_STATUS: '500',
        FAKE_DELETE_ERROR_CODE: 'internal_error',
        FAKE_VERIFY_STATUSES: '503,401',
        FAKE_VERIFY_RETRY_AFTER: '3',
        FAKE_VERIFY_RETRY_AFTER_HEADER: 'retry-after',
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Ephemeral workspace deletion verified after ambiguous DELETE HTTP 500, error code internal_error'
    );
    expect(readFileSync(invocationLog, 'utf8')).toContain('sleep 3');
  });

  it('classifies an unsafe delete error code instead of logging it', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
        FAKE_DELETE_STATUS: '500',
        FAKE_DELETE_ERROR_CODE: 'rk_live_untrusted_code',
        FAKE_VERIFY_STATUS: '401',
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ambiguous DELETE HTTP 500, error code other');
    expect(result.stdout).not.toContain('rk_live_untrusted_code');
    expect(result.stderr).not.toContain('rk_live_untrusted_code');
  });

  it('fails closed when an ambiguous delete leaves the workspace readable', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
        FAKE_DELETE_STATUS: '500',
        FAKE_DELETE_ERROR_CODE: 'internal_error',
        FAKE_VERIFY_STATUS: '200',
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ephemeral workspace cleanup returned HTTP 500, error code internal_error'
    );
    expect(result.stderr).toContain('ephemeral workspace deletion was not proved (follow-up HTTP 200)');
    expect(result.stdout).not.toContain('rk_live_delete_body_must_not_print');
    expect(result.stderr).not.toContain('rk_live_delete_body_must_not_print');
  });

  it('fails closed when an ambiguous delete cannot be verified', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
        INVOCATION_LOG: invocationLog,
        FAKE_DELETE_STATUS: '500',
        FAKE_DELETE_ERROR_CODE: 'internal_error',
        FAKE_VERIFY_STATUS: '503',
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ephemeral workspace cleanup returned HTTP 500, error code internal_error'
    );
    expect(result.stderr).toContain('ephemeral workspace deletion was not proved (follow-up HTTP 503)');
  });

  it('passes the shared key through the isolated lifecycle and joins its workspace', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_WORKSPACES_JSON: '[{"workspace_id":"rw_wrong","api_key":"rk_wrong"}]',
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-a',
        INVOCATION_LOG: invocationLog,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Workspace reuse verified');
    expect(result.stdout).toContain('Standalone smoke passed');
  });

  it('rejects a lifecycle that reports a newly created workspace', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-b',
        FAKE_WORKSPACE_MODE: 'created',
        INVOCATION_LOG: invocationLog,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('created a workspace instead of reusing');
    expect(result.stderr).toContain('Workspace: created new workspace rw_throwaway');
  });

  it('rejects readiness written after the startup deadline', () => {
    const { cli, broker, invocationLog, toolsPath } = createFakeBinaries();
    const bashEnv = join(dirname(invocationLog), 'accelerated-clock.sh');
    writeFileSync(
      bashEnv,
      'sleep() { if [ "${1:-}" = "0.25" ]; then SECONDS=$((SECONDS + 60)); /bin/sleep 0.01; else /bin/sleep "$@"; fi; }\nexport -f sleep\n'
    );
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-c',
        AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS: '50',
        FAKE_READY_AFTER_SECOND_DOWN: '1',
        INVOCATION_LOG: invocationLog,
        BASH_ENV: bashEnv,
        PATH: `${toolsPath}:${process.env.PATH ?? ''}`,
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not become ready');
    expect(result.stderr).toContain('Broker started.');
    expect(result.stdout).not.toContain('Standalone smoke passed');

    const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n');
    const downIndexes = invocations
      .map((invocation, index) => (invocation === 'cli node down' ? index : -1))
      .filter((index) => index >= 0);
    expect(invocations).toContain('up-waiting');
    // Document the intended sequence: preflight cleanup, deadline teardown,
    // and one EXIT cleanup. The source contract above covers the re-entry guard.
    expect(downIndexes).toHaveLength(3);
    expect(invocations.indexOf('up-ready')).toBeGreaterThan(downIndexes[1]);
  });
});
