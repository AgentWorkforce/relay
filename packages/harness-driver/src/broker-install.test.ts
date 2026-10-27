import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';

import { testInternals, compareVersions, ensureCanonicalBroker, parseVersion } from './broker-install.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-broker-install-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake broker: a shell script that prints `agent-relay-broker <version>` for --version. */
function fakeBrokerScript(version: string, label = version): string {
  return `#!/bin/sh\n# ${label}\nif [ "$1" = "--version" ]; then echo "agent-relay-broker ${version}"; fi\nexit 0\n`;
}

/** Lay out an npm optional-dependency package: <root>/<pkg>/{package.json,bin/agent-relay-broker}. */
function makeNpmBroker(
  version: string,
  options: { sidecar?: 'match' | 'mismatch' | 'malformed' | 'empty' } = {}
): string {
  const pkgDir = path.join(makeTempDir(), 'node_modules', '@agent-relay', 'broker-test');
  mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@agent-relay/broker-test', version })
  );
  const bin = path.join(pkgDir, 'bin', 'agent-relay-broker');
  writeFileSync(bin, fakeBrokerScript(version, 'npm'));
  chmodSync(bin, 0o755);
  if (options.sidecar === 'malformed') {
    writeFileSync(`${bin}.sha256`, 'truncated\n');
  } else if (options.sidecar === 'empty') {
    writeFileSync(`${bin}.sha256`, '');
  } else if (options.sidecar) {
    const digest =
      options.sidecar === 'match'
        ? createHash('sha256').update(readFileSync(bin)).digest('hex')
        : 'f'.repeat(64);
    writeFileSync(`${bin}.sha256`, `${digest}  agent-relay-broker\n`);
  }
  return bin;
}

function makeCanonical(version: string | null): string {
  const binDir = path.join(makeTempDir(), 'relay', 'bin');
  mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, 'agent-relay-broker');
  if (version !== null) {
    writeFileSync(target, fakeBrokerScript(version, 'canonical'));
    chmodSync(target, 0o755);
  }
  return target;
}

const sh = process.platform === 'win32' ? describe.skip : describe;

describe('version helpers', () => {
  it('parses broker --version output', () => {
    expect(parseVersion('agent-relay-broker 14.0.0\n')).toBe('14.0.0');
    expect(parseVersion('agent-relay-broker 14.1.0-beta.2')).toBe('14.1.0-beta.2');
    expect(parseVersion('no version')).toBeNull();
  });

  it('orders versions, with prereleases below their release', () => {
    expect(compareVersions('14.0.0', '13.9.9')).toBe(1);
    expect(compareVersions('14.0.0', '14.0.0')).toBe(0);
    expect(compareVersions('14.0.0', '14.0.1')).toBe(-1);
    expect(compareVersions('14.1.0-beta.1', '14.1.0')).toBe(-1);
    expect(compareVersions('14.1.0-beta.10', '14.1.0-beta.2')).toBe(1);
    expect(compareVersions('garbage', '1.0.0')).toBeNull();
  });

  it('scans long digit runs in linear time and never starts mid-number', () => {
    const digits = '0'.repeat(200_000);
    const started = performance.now();
    expect(parseVersion(digits)).toBeNull();
    expect(compareVersions(digits, `${digits}.1`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    expect(parseVersion(`${digits}1.2.3`)).toBeNull();
    expect(parseVersion(`${digits} 1.2.3`)).toBe('1.2.3');
  });
});

sh('ensureCanonicalBroker', () => {
  it('installs the npm broker into an empty canonical bin directory, atomically and 0755', () => {
    const source = makeNpmBroker('14.0.0');
    const target = makeCanonical(null);

    const result = ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} });

    expect(result).toEqual({ action: 'installed', path: target, version: '14.0.0' });
    expect(readFileSync(target)).toEqual(readFileSync(source));
    expect(statSync(target).mode & 0o777).toBe(0o755);
    // Only the binary and its version cache remain: no temp or lock files.
    expect(readdirSync(path.dirname(target)).sort()).toEqual(
      ['.agent-relay-broker.version.json', 'agent-relay-broker'].sort()
    );
  });

  it('creates the canonical bin directory under AGENT_RELAY_INSTALL_DIR', () => {
    const source = makeNpmBroker('14.0.0');
    const installDir = path.join(makeTempDir(), 'custom-root');

    const result = ensureCanonicalBroker({
      sourcePath: source,
      env: { AGENT_RELAY_INSTALL_DIR: installDir },
    });

    expect(result).toMatchObject({
      action: 'installed',
      path: path.join(installDir, 'bin', 'agent-relay-broker'),
    });
    expect(existsSync(path.join(installDir, 'bin', 'agent-relay-broker'))).toBe(true);
  });

  it('upgrades an older canonical broker', () => {
    const source = makeNpmBroker('14.0.0');
    const target = makeCanonical('13.2.0');

    const result = ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} });

    expect(result).toEqual({
      action: 'upgraded',
      path: target,
      version: '14.0.0',
      previousVersion: '13.2.0',
    });
    expect(readFileSync(target, 'utf-8')).toContain('# npm');
  });

  it('never downgrades a newer canonical broker (install.sh or desktop app)', () => {
    const source = makeNpmBroker('14.0.0');
    const target = makeCanonical('14.2.0');
    const before = readFileSync(target);

    const result = ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} });

    expect(result).toMatchObject({ action: 'skipped', reason: 'newer-installed', detail: '14.2.0' });
    expect(readFileSync(target)).toEqual(before);
  });

  it('leaves an equal-version canonical broker alone and caches its version', () => {
    const source = makeNpmBroker('14.0.0');
    const target = makeCanonical('14.0.0');
    let probes = 0;
    const readVersion = (bin: string): string | null => {
      probes += 1;
      return parseVersion(readFileSync(bin, 'utf-8').match(/broker (\S+)"/u)?.[1] ?? null);
    };

    expect(
      ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {}, readVersion })
    ).toMatchObject({
      action: 'skipped',
      reason: 'up-to-date',
    });
    expect(
      ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {}, readVersion })
    ).toMatchObject({
      action: 'skipped',
      reason: 'up-to-date',
    });
    // The second run is served from the stat-keyed cache.
    expect(probes).toBe(1);
    expect(existsSync(testInternals.versionCachePath(target))).toBe(true);
  });

  it('replaces a canonical file that cannot report a version', () => {
    const source = makeNpmBroker('14.0.0');
    const target = makeCanonical(null);
    writeFileSync(target, '#!/bin/sh\nexit 1\n');
    chmodSync(target, 0o755);

    const result = ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} });

    expect(result).toEqual({ action: 'upgraded', path: target, version: '14.0.0' });
  });

  it('verifies the npm sha256 sidecar when the package ships one', () => {
    const good = makeNpmBroker('14.0.0', { sidecar: 'match' });
    const bad = makeNpmBroker('14.0.0', { sidecar: 'mismatch' });
    const goodTarget = makeCanonical(null);
    const badTarget = makeCanonical(null);

    expect(ensureCanonicalBroker({ sourcePath: good, targetPath: goodTarget, env: {} })).toMatchObject({
      action: 'installed',
    });
    expect(ensureCanonicalBroker({ sourcePath: bad, targetPath: badTarget, env: {} })).toMatchObject({
      action: 'skipped',
      reason: 'checksum-mismatch',
    });
    expect(existsSync(badTarget)).toBe(false);
    expect(readdirSync(path.dirname(badTarget))).toEqual([]);
  });

  it('rejects a present but malformed or empty sha256 sidecar', () => {
    for (const sidecar of ['malformed', 'empty'] as const) {
      const source = makeNpmBroker('14.0.0', { sidecar });
      const target = makeCanonical(null);

      const result = ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} });

      expect(result).toMatchObject({ action: 'skipped', reason: 'checksum-mismatch' });
      expect(result.action === 'skipped' && result.detail).toContain('holds no SHA-256 digest');
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(path.dirname(target))).toEqual([]);
    }
  });

  it('skips when disabled, when a broker override is set, or when there is no npm broker', () => {
    const source = makeNpmBroker('14.0.0');
    const target = makeCanonical(null);

    expect(
      ensureCanonicalBroker({
        sourcePath: source,
        targetPath: target,
        env: { AGENT_RELAY_SKIP_BROKER_INSTALL: '1' },
      })
    ).toMatchObject({ reason: 'disabled' });
    expect(
      ensureCanonicalBroker({
        sourcePath: source,
        targetPath: target,
        env: { BROKER_BINARY_PATH: '/x/broker' },
      })
    ).toMatchObject({ reason: 'override' });
    expect(ensureCanonicalBroker({ sourcePath: null, targetPath: target, env: {} })).toMatchObject({
      reason: 'no-source',
    });
    expect(ensureCanonicalBroker({ sourcePath: target, targetPath: target, env: {} })).toMatchObject({
      reason: 'no-source',
    });
    expect(existsSync(target)).toBe(false);
  });

  it("copies only the CLI's own npm broker, never one resolved through the current project", async () => {
    const getOptionalDepBrokerPath = vi.fn(() => null);
    vi.resetModules();
    vi.doMock('./broker-path.js', () => ({ getOptionalDepBrokerPath }));
    try {
      const mod = await import('./broker-install.js');
      expect(mod.ensureCanonicalBroker({ targetPath: makeCanonical(null), env: {} })).toMatchObject({
        reason: 'no-source',
      });
      expect(getOptionalDepBrokerPath).toHaveBeenCalledWith({ includeCwd: false });
    } finally {
      vi.doUnmock('./broker-path.js');
      vi.resetModules();
    }
  });

  it('skips when the npm broker already is the canonical file', () => {
    const target = makeCanonical('14.0.0');
    expect(ensureCanonicalBroker({ sourcePath: target, targetPath: target, env: {} })).toMatchObject({
      reason: 'source-is-canonical',
    });
  });

  describe('lock', () => {
    it('skips while another live process holds the lock, then converges once it is released', () => {
      const source = makeNpmBroker('14.0.0');
      const target = makeCanonical(null);
      const lockPath = path.join(path.dirname(target), '.agent-relay-broker.lock');
      const lock = testInternals.acquireLock(lockPath, 60_000);
      expect(lock).not.toBeNull();
      expect(lock?.isHeld()).toBe(true);

      expect(ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} })).toMatchObject({
        action: 'skipped',
        reason: 'locked',
      });
      expect(existsSync(target)).toBe(false);

      lock?.release();
      expect(existsSync(lockPath)).toBe(false);
      expect(ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} })).toMatchObject({
        action: 'installed',
      });
    });

    it('takes over a lock whose owner is dead', () => {
      const source = makeNpmBroker('14.0.0');
      const target = makeCanonical(null);
      // PID 2^22+ is above Linux/macOS pid_max defaults, so it is not alive.
      writeFileSync(
        path.join(path.dirname(target), '.agent-relay-broker.lock'),
        JSON.stringify({ pid: 4_194_400, token: 'dead' })
      );

      expect(ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {} })).toMatchObject({
        action: 'installed',
      });
      expect(existsSync(path.join(path.dirname(target), '.agent-relay-broker.lock'))).toBe(false);
    });

    it('takes over a lock older than the stale timeout even if its pid is alive', () => {
      const source = makeNpmBroker('14.0.0');
      const target = makeCanonical(null);
      writeFileSync(
        path.join(path.dirname(target), '.agent-relay-broker.lock'),
        JSON.stringify({ pid: process.pid, token: 'old' })
      );

      expect(
        ensureCanonicalBroker({ sourcePath: source, targetPath: target, env: {}, lockStaleMs: -1 })
      ).toMatchObject({ action: 'installed' });
    });

    it('never deletes a replacement lock when two processes recover the same abandoned lock', () => {
      const dir = makeTempDir();
      const lockPath = path.join(dir, '.agent-relay-broker.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: 4_194_400, token: 'dead' }));

      // Both contenders inspect the abandoned lock before either acts.
      const seenByA = testInternals.inspectLock(lockPath, 60_000);
      const seenByB = testInternals.inspectLock(lockPath, 60_000);
      expect(seenByA?.stale).toBe(true);
      expect(seenByB?.stale).toBe(true);

      // A breaks it and takes a fresh lock.
      expect(testInternals.breakStaleLock(lockPath, seenByA!.identity)).toBe(true);
      const lockA = testInternals.acquireLock(lockPath, 60_000);
      expect(lockA?.isHeld()).toBe(true);

      // B acts on its outdated view: it must not remove A's live lock.
      expect(testInternals.breakStaleLock(lockPath, seenByB!.identity)).toBe(false);
      expect(lockA?.isHeld()).toBe(true);
      expect(testInternals.acquireLock(lockPath, 60_000)).toBeNull();
      expect(readdirSync(dir).filter((f) => f.endsWith('.stale'))).toEqual([]);
      lockA?.release();
    });

    it('does not commit a copy after its lock was taken over', () => {
      const source = makeNpmBroker('14.0.0');
      const target = makeCanonical(null);
      const lockPath = path.join(path.dirname(target), '.agent-relay-broker.lock');
      const lock = testInternals.acquireLock(lockPath, 60_000);
      // Simulate a takeover: the lock file now belongs to someone else.
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
      expect(lock?.isHeld()).toBe(false);

      expect(testInternals.copyAtomically(source, target, lock!.isHeld)).toMatchObject({
        ok: false,
        reason: 'locked',
      });
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

      lock?.release();
      expect(existsSync(lockPath)).toBe(true); // release never removes someone else's lock
    });

    it('lets exactly one of many concurrent CLI processes install', async () => {
      const source = makeNpmBroker('14.0.0');
      const target = makeCanonical(null);
      const work = makeTempDir();
      const bundle = path.join(work, 'broker-install.mjs');
      buildSync({
        entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'broker-install.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: bundle,
        logLevel: 'silent',
      });
      const runner = path.join(work, 'run.mjs');
      writeFileSync(
        runner,
        `import { ensureCanonicalBroker } from ${JSON.stringify(bundle)};\n` +
          `const startAt = Number(process.argv[2]);\n` +
          `while (Date.now() < startAt) {}\n` +
          `const r = ensureCanonicalBroker({ sourcePath: ${JSON.stringify(source)}, targetPath: ${JSON.stringify(target)}, env: {} });\n` +
          `process.stdout.write(JSON.stringify(r));\n`
      );

      const startAt = Date.now() + 750;
      const results = await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            new Promise<{ action: string; reason?: string }>((resolve, reject) => {
              const child = spawn(process.execPath, [runner, String(startAt)], {
                stdio: ['ignore', 'pipe', 'inherit'],
              });
              let out = '';
              child.stdout.on('data', (chunk: Buffer) => {
                out += chunk.toString();
              });
              child.on('error', reject);
              child.on('close', () => {
                try {
                  resolve(JSON.parse(out));
                } catch (err) {
                  reject(err);
                }
              });
            })
        )
      );

      const installed = results.filter((r) => r.action === 'installed');
      expect(installed).toHaveLength(1);
      for (const r of results.filter((x) => x.action !== 'installed')) {
        expect(['locked', 'up-to-date']).toContain(r.reason);
      }
      expect(readFileSync(target)).toEqual(readFileSync(source));
      const leftovers = readdirSync(path.dirname(target)).filter(
        (f) => f.endsWith('.tmp') || f.endsWith('.lock')
      );
      expect(leftovers).toEqual([]);
    }, 30_000);
  });
});
