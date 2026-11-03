/**
 * Keep the published CLI installable with its exact Flows SDK pin and Relay peers.
 * Optional peers participate in npm resolution, so the root development override
 * cannot substitute for a fresh consumer install without that override.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function readCliPackage(): {
  version: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
  };
}

function nextMajor(version: string): string {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) {
    throw new Error(`unparseable CLI version: ${version}`);
  }
  return `${major + 1}.0.0`;
}

function writeWorkspacePackage(root: string, name: 'sdk' | 'harness-driver', version: string): void {
  const dir = path.join(root, 'pkgs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@agent-relay/${name}`,
        version,
        main: 'index.js',
      },
      null,
      2
    )
  );
  writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
}

describe('published CLI @relayflows/sdk peer compatibility', () => {
  it('pins an exact @relayflows/sdk version (no floating caret)', () => {
    const pin = readCliPackage().dependencies?.['@relayflows/sdk'];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Fresh registry install of @relayflows/sdk routinely exceeds vitest's 5s
  // default under CI load; keep the proof but budget for a cold npm resolve.
  it('installs cleanly beside workspace packages at the released CLI version', () => {
    const cli = readCliPackage();
    const pin = cli.dependencies?.['@relayflows/sdk'];
    expect(pin).toBeTruthy();
    const current = cli.version;

    const root = mkdtempSync(path.join(tmpdir(), 'relayflows-peer-compat-'));
    try {
      writeWorkspacePackage(root, 'sdk', current);
      writeWorkspacePackage(root, 'harness-driver', current);

      writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify(
          {
            name: 'relayflows-peer-compat-consumer',
            private: true,
            dependencies: {
              '@agent-relay/sdk': 'file:pkgs/sdk',
              '@agent-relay/harness-driver': 'file:pkgs/harness-driver',
              '@relayflows/sdk': pin,
            },
          },
          null,
          2
        )
      );

      execFileSync('npm', ['install', '--no-fund', '--no-audit'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Unsupported Relay majors must fail resolution instead of being accepted
      // because a development-only override hid the published peer contract.
      rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
      rmSync(path.join(root, 'package-lock.json'));
      writeWorkspacePackage(root, 'sdk', nextMajor(current));
      writeWorkspacePackage(root, 'harness-driver', nextMajor(current));
      let rejected: { status?: number; stderr?: string } | undefined;
      try {
        execFileSync('npm', ['install', '--no-fund', '--no-audit'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        rejected = error as typeof rejected;
      }
      expect(rejected?.status).not.toBe(0);
      expect(rejected?.stderr).toContain('ERESOLVE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
