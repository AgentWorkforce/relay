/**
 * Keep the published CLI installable when this monorepo ships the next major.
 *
 * `@relayflows/sdk` >=2.0.23 declares optional peers capped at `<13`. A caret
 * pin floats consumers onto that range and npm ERESOLVEs once `agent-relay` /
 * `@agent-relay/sdk` are 13.x — even though the peers are optional. The publish
 * workflow's root override does not travel with the published package, so the
 * CLI manifest itself must stay on a peer-safe pin.
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

  it('installs cleanly beside workspace packages at the next major', () => {
    const cli = readCliPackage();
    const pin = cli.dependencies?.['@relayflows/sdk'];
    expect(pin).toBeTruthy();
    const next = nextMajor(cli.version);

    const root = mkdtempSync(path.join(tmpdir(), 'relayflows-peer-compat-'));
    try {
      writeWorkspacePackage(root, 'sdk', next);
      writeWorkspacePackage(root, 'harness-driver', next);

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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
