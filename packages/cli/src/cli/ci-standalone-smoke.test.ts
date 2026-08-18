import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const smokeScript = resolve('scripts/ci-standalone-smoke.sh');
const temporaryDirectories: string[] = [];

function makeExecutable(directory: string, name: string, contents: string): string {
  const path = join(directory, name);
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function createFakeBinaries(): { cli: string; broker: string } {
  const directory = mkdtempSync(join(tmpdir(), 'relay-standalone-smoke-test-'));
  temporaryDirectories.push(directory);

  const broker = makeExecutable(directory, 'broker', '#!/usr/bin/env bash\nexit 0\n');
  const cli = makeExecutable(
    directory,
    'relay',
    `#!/usr/bin/env bash
set -euo pipefail

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

  return { cli, broker };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ci-standalone-smoke workspace reuse', () => {
  it('injects the same dedicated secret at every workflow call site', () => {
    for (const workflow of ['.github/workflows/package-validation.yml', '.github/workflows/publish.yml']) {
      expect(readFileSync(resolve(workflow), 'utf8')).toContain(
        'RELAY_WORKSPACE_KEY: ${{ secrets.RELAY_CI_WORKSPACE_KEY }}'
      );
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
      const env = { ...process.env };
      if (value === undefined) {
        delete env.RELAY_WORKSPACE_KEY;
      } else {
        env.RELAY_WORKSPACE_KEY = value;
      }

      const result = spawnSync('bash', [smokeScript, '/missing/cli', '/missing/broker'], {
        encoding: 'utf8',
        env,
      });

      expect(result.status, `${label}: ${result.stderr}`).toBe(2);
      expect(result.stderr, label).toContain('Refusing to start');
      expect(result.stderr, label).toContain('throwaway workspace');
      expect(result.stderr, label).not.toContain('binary not found');
    }
  });

  it('passes the shared key through the isolated lifecycle and joins its workspace', () => {
    const { cli, broker } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_WORKSPACE_KEY: 'rk_live_test_only',
        RELAY_WORKSPACES_JSON: '[{"workspace_id":"rw_wrong","api_key":"rk_wrong"}]',
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-a',
      },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Workspace reuse verified');
    expect(result.stdout).toContain('Standalone smoke passed');
  });

  it('rejects a lifecycle that reports a newly created workspace', () => {
    const { cli, broker } = createFakeBinaries();
    const result = spawnSync('bash', [smokeScript, cli, broker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_WORKSPACE_KEY: 'rk_live_test_only',
        AGENT_RELAY_STANDALONE_BROKER_NAME: 'relay-ci-test-b',
        FAKE_WORKSPACE_MODE: 'created',
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('created a workspace instead of reusing');
    expect(result.stderr).toContain('Workspace: created new workspace rw_throwaway');
  });
});
