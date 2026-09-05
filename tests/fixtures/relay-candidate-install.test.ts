import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createPrivateOutputRoot,
  digestInstalledClosureTree,
  digestInstalledPackageTree,
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
  it.skipIf(process.platform === 'win32')('rejects pre-existing output roots and symlinks', async () => {
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
