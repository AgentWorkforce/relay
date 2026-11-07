import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = readFileSync(resolve('scripts/e2e-test.sh'), 'utf8');
const directories: string[] = [];
it('does not kill listeners based only on port ownership', () => {
  expect(script).not.toMatch(/lsof[^\n]*\|[^\n]*kill/);
});
it('starts the lifecycle fixture without auto-spawning repository teams', () => {
  expect(script).toMatch(/"\$CLI_CMD" node up --no-spawn > "\$DAEMON_LOG"/);
});
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  { output: '', running: 0, expected: 1 },
  { output: 'Broker started.\n', running: 0, expected: 0 },
  { output: 'Broker started.\n', running: 1, expected: 1 },
])('E2E readiness requires completed startup and live status: $expected', ({ output, running, expected }) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-e2e-readiness-'));
  directories.push(directory);
  const log = join(directory, 'daemon log');
  writeFileSync(log, output);
  const helper = script.match(/^broker_is_ready\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(helper).toBeDefined();
  expect(script).toContain('if broker_is_ready; then');
  const result = spawnSync('bash', ['-s', '--', log, String(running)], {
    input: `${helper}\nDAEMON_LOG="$1"\nRUNNING_STATUS="$2"\nbroker_is_running() { return "$RUNNING_STATUS"; }\nbroker_is_ready\n`,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(expected);
});
