import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(cliDir, '../../../..');
const distEntrypoint = path.resolve(cliDir, '../../dist/cli/index.js');
const smokeScript = path.join(repoRoot, 'scripts/ci-standalone-workflow-smoke.sh');
const bunAvailable = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!bunAvailable || !existsSync(distEntrypoint))('compiled Bun workflow regression', () => {
  it('runs a no-allocation workflow to terminal logs and completed status', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-bun-workflow-test-'));
    const binary = path.join(tempRoot, 'agent-relay');
    try {
      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--external=better-sqlite3',
          '--external=node-pty',
          '--external=cpu-features',
          distEntrypoint,
          '--outfile',
          binary,
        ],
        { cwd: repoRoot, stdio: 'pipe' }
      );
      execFileSync('bash', [smokeScript, binary], { cwd: repoRoot, stdio: 'pipe' });
      expect(existsSync(binary)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
