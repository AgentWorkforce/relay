import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function createFakeBinaries(): { cli: string; broker: string; invocationLog: string } {
  const directory = mkdtempSync(join(tmpdir(), 'relay-standalone-smoke-test-'));
  temporaryDirectories.push(directory);

  const invocationLog = join(directory, 'invocations.log');
  writeFileSync(invocationLog, '');
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
    echo "Cleaned up (was not running)"
    ;;
  up)
    if [ -z "\${RELAY_WORKSPACE_KEY:-}" ]; then
      echo "workspace key missing" >&2
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
      printf 'up-ready\\n' >> "$INVOCATION_LOG"
    fi
    echo 'Workspace source: environment ($RELAY_WORKSPACE_KEY)'
    if [ "\${FAKE_WORKSPACE_MODE:-joined}" = "created" ]; then
      echo "Workspace: created new workspace rw_throwaway"
    else
      echo "Workspace: joined rw_ci"
    fi
    echo "Broker started."
    ;;
  *)
    exit 67
    ;;
esac
`
  );

  return { cli, broker, invocationLog };
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

  it('keeps the package-validation production check while isolating publish lifecycle gates', () => {
    const packageValidation = readFileSync(resolve('.github/workflows/package-validation.yml'), 'utf8');
    const publish = readFileSync(resolve('.github/workflows/publish.yml'), 'utf8');
    const publishedDriverVerify = readFileSync(resolve('.github/workflows/verify-publish-sdk.yml'), 'utf8');

    expect(packageValidation).toContain('RELAY_WORKSPACE_KEY: ${{ secrets.RELAY_CI_WORKSPACE_KEY }}');
    expect(publish).not.toContain('secrets.RELAY_CI_WORKSPACE_KEY');
    expect(publish.match(/uses: \.\/\.github\/actions\/start-relaycast-stub/g)).toHaveLength(2);
    expect(publishedDriverVerify).toContain('uses: ./.github/actions/start-relaycast-stub');
  });

  it('keeps the outer startup deadline above the broker aggregate handshake budget', () => {
    const script = readFileSync(smokeScript, 'utf8');
    const brokerSession = readFileSync(resolve('crates/broker/src/runtime/session.rs'), 'utf8');
    const minimumSeconds = Number(script.match(/MIN_STARTUP_TIMEOUT_SECONDS=([0-9]+)/)?.[1]);
    const smokeSeconds = Number(
      script.match(/AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS:-([0-9]+)}/)?.[1]
    );
    const brokerSeconds = Number(
      brokerSession.match(/const HANDSHAKE_TOTAL_TIMEOUT:[^=]+=[\s\n]*Duration::from_secs\(([0-9]+)\);/)?.[1]
    );

    expect(minimumSeconds).toBeGreaterThanOrEqual(brokerSeconds + 10);
    expect(smokeSeconds).toBeGreaterThanOrEqual(minimumSeconds);
  });

  it('rejects unsafe startup-timeout overrides before invoking binaries', () => {
    for (const [override, expectedMessage] of [
      ['49', 'must be at least 50s'],
      ['050', 'without leading zeros'],
      ['060', 'without leading zeros'],
      ['08', 'without leading zeros'],
      ['99999', 'must be no more than 86400s'],
      ['9223372036854775808', 'between 50s and 86400s'],
    ]) {
      const { cli, broker, invocationLog } = createFakeBinaries();
      const result = spawnSync('bash', [smokeScript, cli, broker], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RELAY_WORKSPACE_KEY: 'rk_live_test_only',
          AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS: override,
          INVOCATION_LOG: invocationLog,
        },
      });

      expect(result.status, `${override}: ${result.stderr}`).toBe(2);
      expect(result.stderr, override).toContain(expectedMessage);
      expect(readFileSync(invocationLog, 'utf8'), override).toBe('');
    }
  });

  it('fails closed before invoking binaries when the dedicated key is missing or whitespace-only', () => {
    const unusableKeys: Array<[label: string, value: string | undefined]> = [
      ['unset', undefined],
      ['empty', ''],
      ['single space', ' '],
      ['tab', '\t'],
    ];

    for (const [label, value] of unusableKeys) {
      const { cli, broker, invocationLog } = createFakeBinaries();
      const env = { ...process.env };
      if (value === undefined) {
        delete env.RELAY_WORKSPACE_KEY;
      } else {
        env.RELAY_WORKSPACE_KEY = value;
      }
      env.INVOCATION_LOG = invocationLog;

      const result = spawnSync('bash', [smokeScript, cli, broker], {
        encoding: 'utf8',
        env,
      });

      expect(result.status, `${label}: ${result.stderr}`).toBe(2);
      expect(result.stderr, label).toContain('Refusing to start');
      expect(result.stderr, label).toContain('throwaway workspace');
      expect(result.stderr, label).not.toContain('binary not found');
      expect(readFileSync(invocationLog, 'utf8'), label).toBe('');
    }
  });

  it('passes the shared key through the isolated lifecycle and joins its workspace', () => {
    const { cli, broker, invocationLog } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_WORKSPACE_KEY: 'rk_live_test_only',
        RELAY_WORKSPACES_JSON: '[{"workspace_id":"rw_wrong","api_key":"rk_wrong"}]',
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-a',
        INVOCATION_LOG: invocationLog,
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Workspace reuse verified');
    expect(result.stdout).toContain('Standalone smoke passed');
  });

  it('rejects a lifecycle that reports a newly created workspace', () => {
    const { cli, broker, invocationLog } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_WORKSPACE_KEY: 'rk_live_test_only',
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-b',
        FAKE_WORKSPACE_MODE: 'created',
        INVOCATION_LOG: invocationLog,
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('created a workspace instead of reusing');
    expect(result.stderr).toContain('Workspace: created new workspace rw_throwaway');
  });

  it('rejects readiness written after the startup deadline', () => {
    const { cli, broker, invocationLog } = createFakeBinaries();
    const bashEnv = join(dirname(invocationLog), 'accelerated-clock.sh');
    writeFileSync(
      bashEnv,
      'sleep() { if [ "${1:-}" = "0.25" ]; then SECONDS=$((SECONDS + 60)); command sleep 0.01; else command sleep "$@"; fi; }\nexport -f sleep\n'
    );
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_WORKSPACE_KEY: 'rk_live_test_only',
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-c',
        AGENT_RELAY_STANDALONE_STARTUP_TIMEOUT_SECONDS: '50',
        FAKE_READY_AFTER_SECOND_DOWN: '1',
        INVOCATION_LOG: invocationLog,
        BASH_ENV: bashEnv,
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
