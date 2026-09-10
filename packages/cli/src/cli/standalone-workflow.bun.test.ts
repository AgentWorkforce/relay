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

// These are optional peer dependencies of @agent-relay/sandbox.  The
// standalone CLI must remain buildable without installing every provider;
// selected providers are resolved at runtime by their dynamic imports.
const optionalSandboxProviders = [
  'e2b',
  'modal',
  'freestyle',
  'microsandbox',
  '@vercel/sandbox',
  '@aws-sdk/client-bedrock-agentcore-control',
  '@aws-sdk/client-bedrock-agentcore',
];

describe.skipIf(!bunAvailable || !existsSync(distEntrypoint))('compiled Bun workflow regression', () => {
  it('runs a no-allocation workflow to terminal logs and completed status', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-bun-workflow-test-'));
    const binary = path.join(tempRoot, 'agent-relay');
    const bundle = path.join(tempRoot, 'cli-bundle.mjs');
    try {
      execFileSync(
        'bash',
        [path.join(repoRoot, 'scripts/bundle-cli-for-bun.sh'), distEntrypoint, bundle, 'test'],
        {
          cwd: repoRoot,
          stdio: 'pipe',
        }
      );
      execFileSync(
        'bun',
        [
          'build',
          '--compile',
          '--minify',
          '--external=better-sqlite3',
          '--external=node-pty',
          '--external=cpu-features',
          ...optionalSandboxProviders.map((provider) => `--external=${provider}`),
          bundle,
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
