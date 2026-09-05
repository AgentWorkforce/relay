import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PACKAGE_NAMES,
  RELAY_PACKAGE_POLICY,
  RELAY_PACKAGE_PRODUCER,
  assertPrereleaseVersion,
  assertUnpublishedNpmView,
  validateRelayPackageEnvelope,
  validateRelayPackagePayload,
  verifyRelayPackageFiles,
} from '../../scripts/verify-features/relay-package-qualification.mjs';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const producer = {
  ...RELAY_PACKAGE_PRODUCER,
  ref: 'refs/heads/qualification/test-candidate',
  sourceGitSha: 'a'.repeat(40),
  runId: '71',
  runAttempt: '2',
};
const packages = {
  'agent-relay': '11.10.2-rc.1',
  '@agent-relay/agent': '7.1.1',
  '@agent-relay/config': '11.10.2-rc.1',
  '@agent-relay/credential-proxy': '7.1.1',
  '@agent-relay/events': '7.1.1',
  '@agent-relay/sandbox': '0.1.14',
  '@agent-relay/sdk': '11.10.2-rc.1',
};
const registry = Object.fromEntries(
  Object.entries(packages)
    .filter(([name]) =>
      [
        '@agent-relay/agent',
        '@agent-relay/credential-proxy',
        '@agent-relay/events',
        '@agent-relay/sandbox',
      ].includes(name)
    )
    .map(([name, version]) => [
      name,
      {
        version,
        integrity:
          'sha512-YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==',
        shasum: 'a'.repeat(40),
      },
    ])
);
const candidate = {
  attestationFile: 'candidate-install-attestation.json',
  attestationSha256: 'd'.repeat(64),
  lockfileFile: 'candidate-package-lock.json',
  lockfileSha256: 'e'.repeat(64),
  tarballDirectory: 'tarballs',
};

describe('Relay package qualification producer', () => {
  it('emits the exact Cloud-consumed payload and two-artifact envelope contract', () => {
    const payload = validateRelayPackagePayload({
      schemaVersion: 2,
      kind: 'relayPackages',
      producer,
      packages,
      registry,
      candidate,
    });
    const payloadBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
    expect(
      validateRelayPackageEnvelope({
        ...payload,
        payload: {
          artifact: RELAY_PACKAGE_POLICY.artifact,
          artifactDigest: `sha256:${'b'.repeat(64)}`,
          file: RELAY_PACKAGE_POLICY.file,
          fileSha256: createHash('sha256').update(payloadBytes).digest('hex'),
        },
      })
    ).toBeTruthy();
    expect(Object.keys(packages).sort()).toEqual([...PACKAGE_NAMES].sort());
  });

  it('rejects caller-selected producer identity, package ranges, and circular digest fields', () => {
    expect(() =>
      validateRelayPackagePayload({
        schemaVersion: 2,
        kind: 'relayPackages',
        producer: { ...producer, workflowPath: '.github/workflows/evil.yml' },
        packages,
        registry,
        candidate,
      })
    ).toThrow(/workflowPath/);
    expect(() =>
      validateRelayPackagePayload({
        schemaVersion: 2,
        kind: 'relayPackages',
        producer,
        packages: { ...packages, '@agent-relay/agent': '^7.1.1' },
        registry,
        candidate,
      })
    ).toThrow(/exact semver/);
    expect(() =>
      validateRelayPackagePayload({
        schemaVersion: 2,
        kind: 'relayPackages',
        producer,
        packages: { ...packages, '@agent-relay/agent': `1.0.0-${'a'.repeat(300)}` },
        registry,
        candidate,
      })
    ).toThrow(/exact semver/);
    expect(() =>
      validateRelayPackageEnvelope({
        schemaVersion: 2,
        kind: 'relayPackages',
        producer,
        packages,
        registry,
        candidate,
        payload: {
          artifact: RELAY_PACKAGE_POLICY.artifact,
          artifactDigest: `sha256:${'b'.repeat(64)}`,
          file: RELAY_PACKAGE_POLICY.file,
          fileSha256: 'c'.repeat(64),
        },
        attestationArtifactDigest: `sha256:${'d'.repeat(64)}`,
      })
    ).toThrow(/exactly/);
  });

  it('requires source candidate package versions to be provably unpublished', () => {
    for (const version of ['11.11.0-rc.1', '11.11.0-beta.2', '11.11.0-alpha.3+build.7']) {
      expect(() => assertPrereleaseVersion(version)).not.toThrow();
    }
    for (const version of [
      '11.11.0',
      '11.11.0+build.7',
      'v11.11.0-rc.1',
      '11.11.0-',
      '01.11.0-rc.1',
      '11.01.0-rc.1',
      '11.11.01-rc.1',
      '11.11.0-01',
      '11.11.0-rc..1',
      '11.11.0-rc_1',
      '11.11.0-rc.1+',
      '11.11.0-rc.1+build+other',
      `0.0.0-0.${'--.'.repeat(20_000)}`,
    ]) {
      expect(() => assertPrereleaseVersion(version)).toThrow('must be an exact prerelease semver');
    }
    expect(() =>
      assertUnpublishedNpmView(
        { status: 1, stderr: 'npm error code E404\n404 Not Found', stdout: '' },
        'agent-relay',
        '11.11.0-beta.1'
      )
    ).not.toThrow();
    expect(() =>
      assertUnpublishedNpmView(
        { status: 0, stderr: '', stdout: '"11.11.0-beta.1"' },
        'agent-relay',
        '11.11.0-beta.1'
      )
    ).toThrow('already published');
    expect(() =>
      assertUnpublishedNpmView(
        { status: 1, stderr: 'network timeout', stdout: '' },
        'agent-relay',
        '11.11.0-beta.1'
      )
    ).toThrow('could not prove');
  });

  it('rejects non-canonical registry integrity and qualification ref substitutions', () => {
    expect(() =>
      validateRelayPackagePayload({
        schemaVersion: 2,
        kind: 'relayPackages',
        producer,
        packages,
        registry: {
          ...registry,
          '@agent-relay/agent': {
            ...registry['@agent-relay/agent'],
            integrity: 'sha512-YQ==',
          },
        },
        candidate,
      })
    ).toThrow(/identity is invalid/);

    for (const ref of [
      'refs/heads/main',
      'refs/heads/qualification/../main',
      'refs/heads/qualification//candidate',
      'refs/heads/qualification/candidate/',
      'refs/heads/qualification/.hidden',
      'refs/heads/qualification/trailing.',
      'refs/heads/qualification/can..didate',
    ]) {
      expect(() =>
        validateRelayPackagePayload({
          schemaVersion: 2,
          kind: 'relayPackages',
          producer: { ...producer, ref },
          packages,
          registry,
          candidate,
        })
      ).toThrow(/producer.ref/);
    }
  });

  it('is manually dispatched from one exact canonical prerelease branch without write privileges', async () => {
    const workflow = await readFile('.github/workflows/relay-package-qualification.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+push:/);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('node-version: 22.22.0');
    expect(workflow).not.toContain('node-version: 22.14.0');
    expect(workflow).toContain('refs/heads/qualification/*');
    expect(workflow).toContain('test "${GITHUB_REPOSITORY}" = "AgentWorkforce/relay"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"');
    expect(workflow.indexOf('- name: Set up exact Node.js')).toBeLessThan(
      workflow.indexOf('- name: Require prerelease package version')
    );
    expect(RELAY_PACKAGE_PRODUCER).toMatchObject({
      event: 'workflow_dispatch',
      ref: 'refs/heads/qualification/',
    });
  });

  it('keeps external protocol pins exact and local SDK/config versions aligned', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const [pins, config, sdk] = await Promise.all([
      readFile(
        path.join(root, 'tests/relayflows/cleanroom/snapshot-external-package-pins.json'),
        'utf8'
      ).then(JSON.parse),
      readFile(path.join(root, 'packages/config/package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(root, 'packages/sdk/package.json'), 'utf8').then(JSON.parse),
    ]);
    expect(config.version).toBe(sdk.version);
    expect(Object.keys(pins.packages).sort()).toEqual([
      '@agent-relay/agent',
      '@agent-relay/credential-proxy',
      '@agent-relay/events',
      '@agent-relay/sandbox',
    ]);
    for (const version of Object.values(pins.packages)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    }
  });

  it('verifies the exact portable candidate attestation and tarball file set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-package-payload-'));
    const outsideTarball = path.join(root, '..', `${path.basename(root)}-outside.tgz`);
    const outsidePayload = path.join(root, '..', `${path.basename(root)}-outside.json`);
    try {
      const candidatePackages = [
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
      ].map((name, index) => {
        const tarballFile = `candidate-${index}.tgz`;
        const tarball = `packed:${name}`;
        return {
          name,
          version: packages['agent-relay'],
          tarballFile,
          tarball,
          tarballSha256: sha256(tarball),
          installedPackageJsonSha256: '1'.repeat(64),
          installedTreeSha256: '2'.repeat(64),
          installedTreeFileCount: 2,
          installedTreeBytes: 128,
        };
      });
      const dependencies = Object.fromEntries(
        [...candidatePackages]
          .sort((left, right) => left.name.localeCompare(right.name, 'en'))
          .map((entry) => [entry.name, `file:../tarballs/${entry.tarballFile}`])
      );
      const lockfileBytes = Buffer.from(
        `${JSON.stringify(
          {
            name: 'relay-candidate-clean-install',
            version: '0.0.0',
            lockfileVersion: 3,
            requires: true,
            packages: {
              '': { name: 'relay-candidate-clean-install', version: '0.0.0', dependencies },
              ...Object.fromEntries(
                candidatePackages.map((entry) => [
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
        )}\n`
      );
      const candidateAttestation = {
        version: 4,
        kind: 'relay-candidate-clean-install',
        sourceSha: producer.sourceGitSha,
        sourceDirty: false,
        packageVersion: packages['agent-relay'],
        platform: 'linux',
        arch: 'x64',
        cliRelativePath: 'node_modules/agent-relay/dist/cli/index.js',
        cliSha256: '3'.repeat(64),
        brokerRelativePath: 'node_modules/@agent-relay/broker-linux-x64/bin/agent-relay-broker',
        brokerSha256: '4'.repeat(64),
        brokerBytes: 100,
        brokerMode: '755',
        npmVersion: '10.9.7',
        installStrategy: 'omit-optional-with-direct-platform-broker',
        lockfileFile: candidate.lockfileFile,
        lockfileSha256: sha256(lockfileBytes),
        lockfileBytes: lockfileBytes.length,
        closureTreeSha256: '5'.repeat(64),
        closureEntryCount: 20,
        closureBytes: 1024,
        packages: candidatePackages.map(({ tarball: _tarball, ...entry }) => entry),
      };
      const candidateBytes = Buffer.from(`${JSON.stringify(candidateAttestation, null, 2)}\n`);
      const portablePayload = {
        schemaVersion: 2,
        kind: 'relayPackages',
        producer,
        packages,
        registry,
        candidate: {
          ...candidate,
          attestationSha256: sha256(candidateBytes),
          lockfileSha256: sha256(lockfileBytes),
        },
      };
      await mkdir(path.join(root, 'tarballs'));
      await Promise.all([
        writeFile(path.join(root, RELAY_PACKAGE_POLICY.file), `${JSON.stringify(portablePayload)}\n`),
        writeFile(path.join(root, candidate.attestationFile), candidateBytes),
        writeFile(path.join(root, candidate.lockfileFile), lockfileBytes),
        ...candidatePackages.map((entry) =>
          writeFile(path.join(root, 'tarballs', entry.tarballFile), entry.tarball)
        ),
      ]);

      await expect(verifyRelayPackageFiles(portablePayload, root)).resolves.toMatchObject({
        payload: portablePayload,
        candidate: candidateAttestation,
      });

      const payloadPath = path.join(root, RELAY_PACKAGE_POLICY.file);
      const payloadBytes = `${JSON.stringify(portablePayload)}\n`;
      await writeFile(outsidePayload, payloadBytes);
      await rm(payloadPath);
      await symlink(outsidePayload, payloadPath);
      await expect(verifyRelayPackageFiles(portablePayload, root)).rejects.toThrow(/symbolic link|ELOOP/i);
      await rm(payloadPath);
      await writeFile(payloadPath, payloadBytes);

      await writeFile(path.join(root, 'tarballs', candidatePackages[2]!.tarballFile), 'substituted');
      await expect(verifyRelayPackageFiles(portablePayload, root)).rejects.toThrow(
        'candidate tarball bytes changed'
      );

      await writeFile(
        path.join(root, 'tarballs', candidatePackages[2]!.tarballFile),
        candidatePackages[2]!.tarball
      );
      const linkedTarball = path.join(root, 'tarballs', candidatePackages[2]!.tarballFile);
      await writeFile(outsideTarball, candidatePackages[2]!.tarball);
      await rm(linkedTarball);
      await symlink(outsideTarball, linkedTarball);
      await expect(verifyRelayPackageFiles(portablePayload, root)).rejects.toThrow(
        'tarball is not a regular file'
      );
      await rm(linkedTarball);
      await writeFile(linkedTarball, candidatePackages[2]!.tarball);
      await rm(outsideTarball);
      await writeFile(path.join(root, 'unexpected.txt'), 'not attested');
      await expect(verifyRelayPackageFiles(portablePayload, root)).rejects.toThrow('unexpected file set');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideTarball, { force: true });
      await rm(outsidePayload, { force: true });
    }
  });
});
