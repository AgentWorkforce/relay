import { describe, expect, it } from 'vitest';

import { assessQualificationCapabilities } from '../../scripts/verify-features/qualification-capabilities.mjs';

const commands = {
  selector: ['fleet', 'spawn', '--help'],
  create: ['cloud', 'workspace', 'create', '--help'],
  delete: ['cloud', 'workspace', 'delete', '--help'],
};
const workspaceIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const effects = {
  'candidate-snapshot-selector': {
    status: 'PASS',
    requestedSnapshotId: 'snap_qualified_71',
    observedSnapshotId: 'snap_qualified_71',
    sourceGitSha: 'a'.repeat(40),
    snapshotManifestSha256: 'b'.repeat(64),
    candidateMode: true,
  },
  'ephemeral-cloud-workspace-create': {
    status: 'PASS',
    workspaceIds,
    credentialFiles: workspaceIds.map((workspaceId) => ({ workspaceId, mode: '0600' })),
  },
  'qualified-relayfile-cloud-binding': {
    status: 'PASS',
    requestedDeploymentId: 'rfcloud-candidate-71',
    observedDeploymentId: 'rfcloud-candidate-71',
    sourceGitSha: 'e'.repeat(40),
    attestationSha256: 'c'.repeat(64),
  },
  'relayfile-258-mib-fleet-auto-mount': {
    status: 'PASS',
    sandboxIds: [
      '11111111-1111-4111-8111-111111111111',
      '21111111-1111-4111-8111-111111111111',
      '31111111-1111-4111-8111-111111111111',
    ],
    deploymentId: 'rfcloud-candidate-71',
    sourceGitSha: 'e'.repeat(40),
    attestationSha256: 'c'.repeat(64),
    endpointIdentitySha256: 'd'.repeat(64),
    mountEntrypoint: 'agent-relay fleet spawn --sandbox',
    mountMode: 'fleet-auto-mount',
    scaleFiles: 851,
    scaleDirectories: 454,
    scaleBytes: 270_532_608,
    scaleManifestSha256: '905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a',
    totalBulkRequests: 84,
    totalPointRequests: 0,
    maxCpuMs: 3_403,
    maxPeakRssBytes: 66 * 1024 * 1024,
    exactMarkerHashes: ['e'.repeat(64), 'f'.repeat(64), '9'.repeat(64)],
    exactCleanup: true,
  },
  'ephemeral-cloud-workspace-delete': {
    status: 'PASS',
    workspaceIds,
    cloudAbsent: true,
    relayfileAbsent: true,
    relaycastAbsent: true,
    fleetAbsent: true,
    credentialsAbsent: true,
    registryAbsent: true,
    elapsedSeconds: 37,
  },
};

describe('release qualification capability gate', () => {
  it('passes only when snapshot selection and ephemeral workspace lifecycle are explicit', () => {
    expect(
      assessQualificationCapabilities(
        [
          {
            args: commands.selector,
            status: 0,
            output:
              '--sandbox --sandbox-snapshot <id> --sandbox-snapshot-manifest-sha256 <sha256> --sandbox-relayfile-path <path> --no-sandbox-relayfile',
          },
          {
            args: commands.create,
            status: 0,
            output: '--ephemeral --ttl <duration> --credential-file <path> --relayfile-cloud-deployment <id>',
          },
          { args: commands.delete, status: 0, output: '--confirm <id> --verify-cascade' },
        ],
        effects
      ).ready
    ).toBe(true);
  });

  it('never treats matching help output as runtime qualification', () => {
    const assessment = assessQualificationCapabilities([
      {
        args: commands.selector,
        status: 0,
        output:
          '--sandbox --sandbox-snapshot <id> --sandbox-snapshot-manifest-sha256 <sha256> --sandbox-relayfile-path <path> --no-sandbox-relayfile',
      },
      {
        args: commands.create,
        status: 0,
        output: '--ephemeral --ttl <duration> --credential-file <path> --relayfile-cloud-deployment <id>',
      },
      { args: commands.delete, status: 0, output: '--confirm <id> --verify-cascade' },
    ]);
    expect(assessment.availabilityReady).toBe(true);
    expect(assessment.ready).toBe(false);
    expect(assessment.results.every(({ effectStatus }) => effectStatus === 'BLOCKED')).toBe(true);
  });

  it('rejects mutable snapshot-name equality when no immutable provider id was observed', () => {
    const nameOnlyEffects = structuredClone(effects);
    nameOnlyEffects['candidate-snapshot-selector'] = {
      status: 'PASS',
      requestedSnapshot: 'relay-candidate-71',
      observedSnapshot: 'relay-candidate-71',
      sourceGitSha: 'a'.repeat(40),
      snapshotManifestSha256: 'b'.repeat(64),
      candidateMode: true,
    } as never;

    const assessment = assessQualificationCapabilities(
      [
        {
          args: commands.selector,
          status: 0,
          output:
            '--sandbox --sandbox-snapshot <id> --sandbox-snapshot-manifest-sha256 <sha256> --sandbox-relayfile-path <path> --no-sandbox-relayfile',
        },
        {
          args: commands.create,
          status: 0,
          output: '--ephemeral --ttl <duration> --credential-file <path> --relayfile-cloud-deployment <id>',
        },
        { args: commands.delete, status: 0, output: '--confirm <id> --verify-cascade' },
      ],
      nameOnlyEffects
    );

    expect(assessment.results.find(({ id }) => id === 'candidate-snapshot-selector')?.status).toBe('BLOCKED');
  });

  it('fails closed when a help command is missing or only partially implements the contract', () => {
    const assessment = assessQualificationCapabilities([
      { args: commands.selector, status: 0, output: 'fleet spawn --sandbox' },
      { args: commands.create, status: 1, output: 'unknown command' },
      { args: commands.delete, status: 0, output: '--confirm <id>' },
    ]);

    expect(assessment.ready).toBe(false);
    expect(assessment.results.every(({ status }) => status === 'BLOCKED')).toBe(true);
  });

  it('matches the exact command and exact option tokens independently of help ordering', () => {
    const reorderedHelp = assessQualificationCapabilities(
      [
        {
          args: commands.selector,
          status: 0,
          output:
            '--no-sandbox-relayfile, --sandbox-relayfile-path=<path> --sandbox-snapshot-manifest-sha256=<sha256> --sandbox-snapshot=<id> --sandbox',
        },
        {
          args: commands.create,
          status: 0,
          output: '--credential-file=<path>, --ttl=<duration> --relayfile-cloud-deployment=<id> --ephemeral',
        },
        { args: commands.delete, status: 0, output: '--verify-cascade, --confirm=<id>' },
      ],
      effects
    );
    expect(reorderedHelp.ready).toBe(true);

    const wrongCommand = assessQualificationCapabilities([
      {
        args: ['spawn', 'fleet', '--help'],
        status: 0,
        output:
          '--sandbox --sandbox-snapshot <id> --sandbox-snapshot-manifest-sha256 <sha256> --sandbox-relayfile-path <path> --no-sandbox-relayfile',
      },
    ]);
    expect(wrongCommand.availabilityReady).toBe(false);

    const prefixOnly = assessQualificationCapabilities([
      { args: commands.selector, status: 0, output: '--sandbox' },
    ]);
    expect(prefixOnly.results.find(({ id }) => id === 'candidate-snapshot-selector')?.available).toBe(false);
  });

  it('rejects duplicate workspace and credential identities', () => {
    const duplicateEffects = structuredClone(effects);
    duplicateEffects['ephemeral-cloud-workspace-create'] = {
      status: 'PASS',
      workspaceIds: [workspaceIds[0], workspaceIds[0]],
      credentialFiles: [
        { workspaceId: workspaceIds[0], mode: '0600' },
        { workspaceId: workspaceIds[0], mode: '0600' },
      ],
    };
    const assessment = assessQualificationCapabilities(
      [
        {
          args: commands.create,
          status: 0,
          output: '--ephemeral --ttl <duration> --credential-file <path> --relayfile-cloud-deployment <id>',
        },
      ],
      duplicateEffects
    );
    expect(assessment.results.find(({ id }) => id === 'ephemeral-cloud-workspace-create')?.effectStatus).toBe(
      'BLOCKED'
    );
  });

  it('blocks a production data-plane substitution even when workspace lifecycle exists', () => {
    const assessment = assessQualificationCapabilities(
      [
        {
          args: commands.selector,
          status: 0,
          output:
            '--sandbox --sandbox-snapshot <id> --sandbox-snapshot-manifest-sha256 <sha256> --sandbox-relayfile-path <path> --no-sandbox-relayfile',
        },
        {
          args: commands.create,
          status: 0,
          output: '--ephemeral --ttl <duration> --credential-file <path>',
        },
        { args: commands.delete, status: 0, output: '--confirm <id> --verify-cascade' },
      ],
      effects
    );
    expect(assessment.ready).toBe(false);
    expect(assessment.results.find(({ id }) => id === 'qualified-relayfile-cloud-binding')?.status).toBe(
      'BLOCKED'
    );
  });
});
