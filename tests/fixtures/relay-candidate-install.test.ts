import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  candidateIdentityFromOptions,
  assertSupportedCandidateOutputPlatform,
  createPrivateOutputRoot,
  digestInstalledClosureTree,
  digestInstalledPackageTree,
  privateNpmInvocation,
  sourceBrokerBuildPlan,
  sourceBrokerToolchainPlan,
  validateCandidateInstallAttestation,
  validateCandidateLockfile,
  verifyCandidateInstall,
} from '../../scripts/verify-features/relay-candidate-install.mjs';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const packageNames = [
    'agent-relay',
    '@agent-relay/cloud',
    '@agent-relay/config',
    '@agent-relay/fleet',
    '@agent-relay/harness-driver',
    '@agent-relay/harnesses',
    '@agent-relay/sdk',
    '@agent-relay/session',
    '@agent-relay/utils',
    '@agent-relay/broker-linux-x64',
  ];
  return {
    version: 4,
    kind: 'relay-candidate-clean-install',
    sourceSha: 'a'.repeat(40),
    sourceDirty: false,
    packageVersion: '11.10.3-candidate.1',
    platform: 'linux',
    arch: 'x64',
    cliRelativePath: 'node_modules/agent-relay/dist/cli/index.js',
    cliSha256: 'b'.repeat(64),
    brokerRelativePath: 'node_modules/@agent-relay/broker-linux-x64/bin/agent-relay-broker',
    brokerSha256: 'f'.repeat(64),
    brokerBytes: 100,
    brokerMode: '755',
    npmVersion: '10.9.7',
    installStrategy: 'omit-optional-with-direct-platform-broker',
    lockfileFile: 'candidate-package-lock.json',
    lockfileSha256: '1'.repeat(64),
    lockfileBytes: 100,
    closureTreeSha256: '2'.repeat(64),
    closureEntryCount: 20,
    closureBytes: 1000,
    packages: packageNames.map((name) => ({
      name,
      version: '11.10.3-candidate.1',
      tarballFile: `${name.replaceAll('/', '-').replaceAll('@', '')}.tgz`,
      tarballSha256: 'c'.repeat(64),
      installedPackageJsonSha256: 'd'.repeat(64),
      installedTreeSha256: 'e'.repeat(64),
      installedTreeFileCount: 2,
      installedTreeBytes: 100,
    })),
  };
}

describe('Relay candidate clean-install attestation', () => {
  it('binds trusted hydration to an explicit immutable candidate identity', () => {
    expect(
      candidateIdentityFromOptions({
        'source-sha': 'a'.repeat(40),
        'package-version': '11.10.4-candidate.7',
      })
    ).toEqual({
      sourceSha: 'a'.repeat(40),
      packageVersion: '11.10.4-candidate.7',
    });
    expect(() =>
      candidateIdentityFromOptions({
        'source-sha': 'main',
        'package-version': '11.10.4-candidate.7',
      })
    ).toThrow(/--source-sha/);
    expect(() =>
      candidateIdentityFromOptions({
        'source-sha': 'a'.repeat(40),
        'package-version': 'latest',
      })
    ).toThrow(/--package-version/);
  });
  it('stages portable static musl brokers for Linux source qualification', () => {
    const linuxPlan = sourceBrokerBuildPlan('linux', 'x64');
    expect(linuxPlan).toEqual({
      cargoArgs: [
        'build',
        '--locked',
        '--release',
        '--bin',
        'agent-relay-broker',
        '--target',
        'x86_64-unknown-linux-musl',
      ],
      built: path.join('target', 'x86_64-unknown-linux-musl', 'release', 'agent-relay-broker'),
      env: { RUSTFLAGS: '-C target-feature=+crt-static' },
      target: 'x86_64-unknown-linux-musl',
    });
    expect(sourceBrokerBuildPlan('linux', 'arm64')).toMatchObject({
      cargoArgs: expect.arrayContaining(['--target', 'aarch64-unknown-linux-musl']),
      built: path.join('target', 'aarch64-unknown-linux-musl', 'release', 'agent-relay-broker'),
      env: { RUSTFLAGS: '-C target-feature=+crt-static' },
    });
    expect(
      sourceBrokerToolchainPlan(linuxPlan, {
        muslGccAvailable: false,
        aptGetAvailable: true,
        sudoAvailable: true,
      })
    ).toEqual([
      { command: 'rustup', args: ['target', 'add', 'x86_64-unknown-linux-musl'] },
      { command: 'sudo', args: ['apt-get', 'update'] },
      { command: 'sudo', args: ['apt-get', 'install', '-y', 'musl-tools'] },
    ]);
    expect(
      sourceBrokerToolchainPlan(sourceBrokerBuildPlan('darwin', 'arm64'), {
        muslGccAvailable: false,
      })
    ).toEqual([]);
    expect(() =>
      sourceBrokerToolchainPlan(linuxPlan, {
        muslGccAvailable: false,
        aptGetAvailable: false,
      })
    ).toThrow(/apt-get/);
  });

  it('fails closed outside Linux where directory-handle-bound I/O is unavailable', () => {
    expect(() => assertSupportedCandidateOutputPlatform('win32')).toThrow(/supported only on Linux/);
    expect(() => assertSupportedCandidateOutputPlatform('darwin')).toThrow(/supported only on Linux/);
    expect(() => assertSupportedCandidateOutputPlatform('linux')).not.toThrow();
    expect(() => privateNpmInvocation([], '/dev/fd/3', '/install', 'darwin')).toThrow(
      /supported only on Linux/
    );
  });

  it('makes the candidate output parent private before trusted hydration', async () => {
    const workflow = await readFile('.github/workflows/relay-cleanroom-qualification-consumer.yml', 'utf8');
    const harden = workflow.indexOf('Harden downloaded candidate metadata for private hydration');
    const hydrate = workflow.indexOf('relay-candidate-install.mjs hydrate');
    expect(harden).toBeGreaterThan(workflow.indexOf('qualification-manifest.mjs verify-bundle'));
    expect(hydrate).toBeGreaterThan(harden);
    expect(workflow).toContain('hardenPrivateRegularFileNoFollow');
    expect(workflow).toContain('candidate-install-attestation.json');
    expect(workflow).toContain('candidate-package-lock.json');
    expect(workflow.match(/chmod 700 "\$RUNNER_TEMP"/g)).toHaveLength(1);
    expect(workflow.match(/relay-candidate-install\.mjs hydrate/g)).toHaveLength(1);
  });

  it('runs npm from the parent descriptor on Linux without using --prefix', () => {
    const invocation = privateNpmInvocation(
      ['install', '--package-lock-only'],
      '/proc/self/fd/3',
      '/install',
      'linux',
      '/proc/42/fd/17'
    );

    expect(invocation).toEqual({
      args: ['install', '--package-lock-only'],
      cwd: '/proc/42/fd/17/install',
    });
    expect(invocation.args).not.toContain('--prefix');
  });

  it('rewrites descriptor-bound executable paths before spawning them', async () => {
    const source = await readFile('scripts/verify-features/relay-candidate-install.mjs', 'utf8');
    expect(source).toContain('spawnSync(rewritePrivatePath(command), childArgs');
  });

  it.skipIf(process.platform !== 'linux')(
    'keeps npm lockfile identity canonical through the inherited Linux descriptor',
    { timeout: 320_000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-candidate-procfd-'));
      const install = path.join(root, 'install');
      let descriptor;
      try {
        await mkdir(install);
        await writeFile(
          path.join(install, 'package.json'),
          `${JSON.stringify({ name: 'relay-candidate-clean-install', private: true, version: '0.0.0' })}\n`
        );
        descriptor = await open(root, 'r');
        const invocation = privateNpmInvocation(
          ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
          '/proc/self/fd/3',
          '/install',
          'linux',
          `/proc/${process.pid}/fd/${descriptor.fd}`
        );
        const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn('npm', invocation.args, {
            cwd: invocation.cwd,
            timeout: 300_000,
            stdio: ['ignore', 'ignore', 'pipe', descriptor.fd],
          });
          let stderr = '';
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.once('error', reject);
          child.once('close', (status) => resolve({ status, stderr }));
        });
        expect(result.status, result.stderr).toBe(0);

        const lockfile = JSON.parse(await readFile(path.join(install, 'package-lock.json'), 'utf8'));
        expect(lockfile).toMatchObject({
          name: 'relay-candidate-clean-install',
          version: '0.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'relay-candidate-clean-install', version: '0.0.0' },
          },
        });
      } finally {
        await descriptor?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')('rejects pre-existing output roots and symlinks', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'relay-candidate-output-'));
    try {
      const existing = path.join(parent, 'existing');
      const redirected = path.join(parent, 'redirected');
      const link = path.join(parent, 'output-link');
      await mkdir(existing);
      await mkdir(redirected);
      await symlink(redirected, link);
      await expect(createPrivateOutputRoot(existing)).rejects.toThrow('must not already exist');
      await expect(createPrivateOutputRoot(link)).rejects.toThrow('must not already exist');
      const created = path.join(parent, 'new-output');
      await expect(createPrivateOutputRoot(created)).resolves.toBe(path.resolve(created));
      expect((await lstat(created)).isDirectory()).toBe(true);

      const contended = path.join(parent, 'contended-output');
      const attempts = await Promise.allSettled([
        createPrivateOutputRoot(contended),
        createPrivateOutputRoot(contended),
      ]);
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('rejects an output root whose parent is not private', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'relay-candidate-public-parent-'));
    try {
      await chmod(parent, 0o755);
      await expect(createPrivateOutputRoot(path.join(parent, 'candidate'))).rejects.toThrow(
        /current-user-owned 0700 parent/
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('accepts a complete source-bound runtime package closure', () => {
    const input = fixture();
    expect(
      validateCandidateInstallAttestation(input, {
        sourceSha: input.sourceSha,
        packageVersion: input.packageVersion,
        cliSha256: input.cliSha256,
      })
    ).toBe(input);
  });

  it('rejects dirty source, a missing package, and the wrong installed CLI digest', () => {
    const dirty = fixture();
    dirty.sourceDirty = true;
    expect(() => validateCandidateInstallAttestation(dirty)).toThrow('dirty');

    const incomplete = fixture();
    incomplete.packages.pop();
    expect(() => validateCandidateInstallAttestation(incomplete)).toThrow('closure');

    const substituted = fixture();
    substituted.packages[0]!.name = '@agent-relay/not-the-cli';
    expect(() => validateCandidateInstallAttestation(substituted)).toThrow('missing agent-relay');

    const wrongPlatform = fixture();
    wrongPlatform.packages.at(-1)!.name = '@agent-relay/broker-darwin-arm64';
    expect(() => validateCandidateInstallAttestation(wrongPlatform)).toThrow('platform broker');

    expect(() => validateCandidateInstallAttestation(fixture(), { cliSha256: 'e'.repeat(64) })).toThrow(
      'CLI digest'
    );

    const wrongInstallStrategy = fixture();
    wrongInstallStrategy.installStrategy = 'default';
    expect(() => validateCandidateInstallAttestation(wrongInstallStrategy)).toThrow('installStrategy');
  });

  it('rejects nonportable or caller-substituted lockfile dependencies', () => {
    const input = fixture();
    const dependencies = Object.fromEntries(
      [...input.packages]
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
        .map((entry) => [entry.name, `file:../tarballs/${entry.tarballFile}`])
    );
    const lockfile = {
      name: 'relay-candidate-clean-install',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'relay-candidate-clean-install', version: '0.0.0', dependencies },
        'node_modules/agent-relay': {
          resolved: dependencies['agent-relay'],
        },
      },
    };
    expect(validateCandidateLockfile(lockfile, input.packages)).toBe(lockfile);

    const substituted = structuredClone(lockfile);
    substituted.packages['node_modules/agent-relay']!.resolved = 'file:/tmp/substituted.tgz';
    expect(() => validateCandidateLockfile(substituted, input.packages)).toThrow(
      'unexpected file dependency'
    );
  });

  it('re-verifies the private attestation, every tarball, every installed package, and the CLI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-candidate-install-'));
    const originalPath = process.env.PATH;
    try {
      // The attestation deliberately binds npm 10.9.7. This is a verifier unit
      // test, not a test of whichever npm happens to ship with a Node matrix
      // image, so put an exact harmless version probe ahead of the host npm.
      const fixtureBin = path.join(root, 'fixture-bin');
      const fixtureNpm = path.join(fixtureBin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      await mkdir(fixtureBin, { recursive: true });
      await writeFile(
        fixtureNpm,
        process.platform === 'win32' ? '@echo off\r\necho 10.9.7\r\n' : "#!/bin/sh\nprintf '10.9.7\\n'\n"
      );
      if (process.platform !== 'win32') await chmod(fixtureNpm, 0o755);
      process.env.PATH = `${fixtureBin}${path.delimiter}${originalPath ?? ''}`;

      const input = fixture();
      const cliEntrypoint = path.join(root, 'install', ...input.cliRelativePath.split('/'));
      const cli = `console.log('agent-relay v${input.packageVersion}')\n`;
      await mkdir(path.dirname(cliEntrypoint), { recursive: true });
      await writeFile(cliEntrypoint, cli);
      input.cliSha256 = sha256(cli);

      for (const entry of input.packages) {
        const tarball = `packed:${entry.name}`;
        const packageJson = `${JSON.stringify({ name: entry.name, version: entry.version })}\n`;
        const runtime = `export const packageName = ${JSON.stringify(entry.name)};\n`;
        const installedPackageDir = path.join(root, 'install', 'node_modules', ...entry.name.split('/'));
        await Promise.all([
          mkdir(path.join(root, 'tarballs'), { recursive: true }),
          mkdir(installedPackageDir, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(path.join(root, 'tarballs', entry.tarballFile), tarball),
          writeFile(path.join(installedPackageDir, 'package.json'), packageJson),
          writeFile(path.join(installedPackageDir, 'runtime.js'), runtime),
        ]);
        if (entry.name === '@agent-relay/broker-linux-x64') {
          const broker = path.join(installedPackageDir, 'bin', 'agent-relay-broker');
          await mkdir(path.dirname(broker), { recursive: true });
          await writeFile(broker, `#!/bin/sh\nprintf 'agent-relay-broker ${input.packageVersion}\\n'\n`);
          await chmod(broker, 0o755);
          const brokerBytes = await readFile(broker);
          input.brokerSha256 = sha256(brokerBytes);
          input.brokerBytes = brokerBytes.length;
        }
        entry.tarballSha256 = sha256(tarball);
        entry.installedPackageJsonSha256 = sha256(packageJson);
        const tree = await digestInstalledPackageTree(installedPackageDir);
        entry.installedTreeSha256 = tree.sha256;
        entry.installedTreeFileCount = tree.fileCount;
        entry.installedTreeBytes = tree.bytes;
      }

      const dependencies = Object.fromEntries(
        [...input.packages]
          .sort((left, right) => left.name.localeCompare(right.name, 'en'))
          .map((entry) => [entry.name, `file:../tarballs/${entry.tarballFile}`])
      );
      const installManifest = `${JSON.stringify(
        {
          name: 'relay-candidate-clean-install',
          private: true,
          version: '0.0.0',
          dependencies,
        },
        null,
        2
      )}\n`;
      const lockfile = `${JSON.stringify(
        {
          name: 'relay-candidate-clean-install',
          version: '0.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'relay-candidate-clean-install', version: '0.0.0', dependencies },
            ...Object.fromEntries(
              input.packages.map((entry) => [
                `node_modules/${entry.name}`,
                {
                  name: entry.name,
                  version: entry.version,
                  resolved: dependencies[entry.name],
                },
              ])
            ),
          },
        },
        null,
        2
      )}\n`;
      await Promise.all([
        writeFile(path.join(root, 'install', 'package.json'), installManifest),
        writeFile(path.join(root, 'install', 'package-lock.json'), lockfile),
        writeFile(path.join(root, input.lockfileFile), lockfile, { mode: 0o600 }),
      ]);
      input.lockfileSha256 = sha256(lockfile);
      input.lockfileBytes = Buffer.byteLength(lockfile);

      const attestationPath = path.join(root, 'candidate-install-attestation.json');
      const broker = path.join(root, 'install', ...input.brokerRelativePath.split('/'));
      const brokerPackage = input.packages.find((entry) => entry.name === '@agent-relay/broker-linux-x64')!;
      const syncBrokerAttestation = async () => {
        const bytes = await readFile(broker);
        const tree = await digestInstalledPackageTree(path.dirname(path.dirname(broker)));
        input.brokerSha256 = sha256(bytes);
        input.brokerBytes = bytes.length;
        brokerPackage.installedTreeSha256 = tree.sha256;
        brokerPackage.installedTreeFileCount = tree.fileCount;
        brokerPackage.installedTreeBytes = tree.bytes;
        const closure = await digestInstalledClosureTree(path.join(root, 'install', 'node_modules'));
        input.closureTreeSha256 = closure.sha256;
        input.closureEntryCount = closure.entryCount;
        input.closureBytes = closure.bytes;
        await writeFile(attestationPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
      };
      await syncBrokerAttestation();
      await expect(
        verifyCandidateInstall(attestationPath, { sourceSha: input.sourceSha })
      ).resolves.toMatchObject({ attestation: input });

      const substitutedTransitive = path.join(root, 'install', 'node_modules', 'substituted-transitive');
      await mkdir(substitutedTransitive);
      await writeFile(
        path.join(substitutedTransitive, 'package.json'),
        '{"name":"substituted-transitive","version":"1.0.0"}\n'
      );
      await expect(verifyCandidateInstall(attestationPath)).rejects.toThrow(
        'complete installed closure changed'
      );
      await rm(substitutedTransitive, { recursive: true });

      const outside = path.join(root, 'outside-secret');
      const escapingLink = path.join(root, 'install', 'node_modules', '.bin', 'escaping');
      await writeFile(outside, 'outside');
      await mkdir(path.dirname(escapingLink), { recursive: true });
      await symlink('../../../outside-secret', escapingLink);
      await expect(digestInstalledClosureTree(path.join(root, 'install', 'node_modules'))).rejects.toThrow(
        'escaping symbolic link'
      );
      await rm(escapingLink);

      await chmod(broker, 0o644);
      await syncBrokerAttestation();
      await expect(verifyCandidateInstall(attestationPath)).rejects.toThrow(
        'broker mode is not exactly 0755'
      );
      await chmod(broker, 0o755);
      await syncBrokerAttestation();

      await writeFile(broker, "#!/bin/sh\nprintf 'agent-relay-broker 0.0.0-wrong\\n'\n");
      await chmod(broker, 0o755);
      await syncBrokerAttestation();
      await expect(verifyCandidateInstall(attestationPath)).rejects.toThrow(
        'broker reported a different version'
      );

      await writeFile(broker, `#!/bin/sh\nprintf 'agent-relay-broker ${input.packageVersion}\\n'\n`);
      await chmod(broker, 0o755);
      await syncBrokerAttestation();
      await expect(verifyCandidateInstall(attestationPath)).resolves.toBeTruthy();

      const nonEntrypoint = path.join(root, 'install', 'node_modules', '@agent-relay', 'cloud', 'runtime.js');
      await writeFile(nonEntrypoint, 'export const tampered = true;\n');
      await expect(verifyCandidateInstall(attestationPath)).rejects.toThrow(
        'complete installed closure changed'
      );

      await writeFile(nonEntrypoint, `export const packageName = "@agent-relay/cloud";\n`);
      await writeFile(cliEntrypoint, `${cli}// tampered\n`);
      await expect(verifyCandidateInstall(attestationPath)).rejects.toThrow(
        /(?:CLI digest|complete installed closure) changed/
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
