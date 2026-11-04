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

function parseVersion(version: string): number[] {
  const parts = version
    .split('-')[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`unparseable version: ${version}`);
  }
  return [parts[0]!, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** Enough of npm's range grammar for peer ranges like `>=12.3.1 <13 || >=15.1.0 <17`. */
function satisfies(version: string, range: string): boolean {
  const target = parseVersion(version);
  return range.split('||').some((set) =>
    set
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((comparator) => {
        if (comparator === '*') return true;
        const match = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(comparator);
        if (!match) throw new Error(`unsupported peer comparator: ${comparator}`);
        const order = compareVersions(target, parseVersion(match[2]!));
        switch (match[1]) {
          case '>=':
            return order >= 0;
          case '<=':
            return order <= 0;
          case '>':
            return order > 0;
          case '<':
            return order < 0;
          default:
            return order === 0;
        }
      })
  );
}

/**
 * The first Relay major above `version` that the pinned SDK's published peer
 * ranges refuse. Flows widens its peers before a Relay major ships, because
 * the pin must accept the major being released before main's version moves.
 * So the refused major is not always `version + 1`, but one must exist: the
 * peer contract has to stay bounded.
 */
function firstUnsupportedMajor(version: string, peerRanges: string[]): string {
  const major = parseVersion(version)[0]!;
  for (let next = major + 1; next <= major + 10; next += 1) {
    const candidate = `${next}.0.0`;
    if (peerRanges.some((range) => !satisfies(candidate, range))) return candidate;
  }
  throw new Error(`@relayflows/sdk peers ${peerRanges.join(', ')} accept every major up to ${major + 10}`);
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
      const installedSdk = JSON.parse(
        readFileSync(path.join(root, 'node_modules/@relayflows/sdk/package.json'), 'utf8')
      ) as { peerDependencies?: Record<string, string> };
      const peerRanges = ['@agent-relay/sdk', '@agent-relay/harness-driver'].map(
        (name) => installedSdk.peerDependencies?.[name] ?? '*'
      );
      const unsupported = firstUnsupportedMajor(current, peerRanges);
      rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
      rmSync(path.join(root, 'package-lock.json'));
      writeWorkspacePackage(root, 'sdk', unsupported);
      writeWorkspacePackage(root, 'harness-driver', unsupported);
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
