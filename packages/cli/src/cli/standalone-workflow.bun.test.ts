import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    let unrelatedCwd: string | undefined;
    try {
      const bundler = readFileSync(path.join(repoRoot, 'scripts/bundle-cli-for-bun.sh'), 'utf8');
      expect(bundler).toContain('"$ESBUILD" "$INPUT"');
      expect(bundler).toContain('REPO_ROOT=');
      expect(bundler).toContain('--loader:.node=empty');
      expect(bundler).not.toContain('--external:ssh2');
      expect(bundler).not.toContain('bun node_modules/esbuild/bin/esbuild');
      expect(bundler).not.toContain('node node_modules/esbuild/bin/esbuild');
      unrelatedCwd = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-bun-bundler-cwd-'));
      execFileSync(
        'bash',
        [path.join(repoRoot, 'scripts/bundle-cli-for-bun.sh'), distEntrypoint, bundle, 'test'],
        {
          cwd: unrelatedCwd,
          stdio: 'pipe',
        }
      );
      const bundleSource = readFileSync(bundle, 'utf8');
      for (const provider of optionalSandboxProviders) {
        expect(bundleSource).toContain(`import("${provider}")`);
      }

      // External providers are resolved from the workflow project's normal
      // node_modules layout at runtime, not from the CLI install directory.
      // Keep one real fixture installed under that documented layout so this
      // test catches a bundle that preserves the string but breaks resolution.
      const providerRoot = path.join(tempRoot, 'provider-runtime');
      const providerPackage = path.join(providerRoot, 'node_modules', 'e2b');
      mkdirSync(providerPackage, { recursive: true });
      writeFileSync(
        path.join(providerPackage, 'package.json'),
        JSON.stringify({ name: 'e2b', version: '0.0.0-fixture', type: 'module', exports: './index.js' })
      );
      writeFileSync(
        path.join(providerPackage, 'index.js'),
        'export const fixture = "e2b-runtime-fixture";\n'
      );
      const providerProbe = path.join(providerRoot, 'provider-probe.mjs');
      writeFileSync(
        providerProbe,
        'const provider = await import("e2b");\n' +
          'if (provider.fixture !== "e2b-runtime-fixture") process.exit(1);\n'
      );
      execFileSync('bun', [providerProbe], { cwd: providerRoot, stdio: 'pipe' });
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
      if (unrelatedCwd) rmSync(unrelatedCwd, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
