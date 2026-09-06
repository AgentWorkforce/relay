import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  REQUEST_ARTIFACT_NAME,
  REQUEST_FILE_NAME,
  REQUEST_WORKFLOW_NAME,
  REQUEST_WORKFLOW_PATH,
  readQualificationRequestDirectory,
  selectQualificationRequestArtifact,
  validateQualificationRequest,
  validateQualificationRequestEvent,
} from '../../scripts/verify-features/relay-cleanroom-qualification-request.mjs';

const relaySha = 'a'.repeat(40);
const manifest = {
  manifestVersion: 4,
  releaseId: 42,
  releaseTag: 'v11.11.0-beta.1',
  relaySha,
  cloudSha: 'b'.repeat(40),
  relayfileSha: 'c'.repeat(40),
  relayfileCloudSha: 'd'.repeat(40),
  relayPackageQualification: {
    runId: 303,
    runAttempt: 1,
    payloadArtifactDigest: `sha256:${'8'.repeat(64)}`,
    attestationArtifactDigest: `sha256:${'9'.repeat(64)}`,
    payloadSha256: 'e'.repeat(64),
    attestationSha256: 'f'.repeat(64),
  },
  cloudQualification: {
    runId: 101,
    runAttempt: 2,
    artifactName: 'daytona-snapshot-manifests-101-2',
    artifactDigest: `sha256:${'6'.repeat(64)}`,
    qualificationSha256: '1'.repeat(64),
    snapshotName: 'relay-orchestrator-candidate-42-sdk-11.11.0-beta.1',
    snapshotId: 'snapshot-uuid-42',
    snapshotManifestSha256: '2'.repeat(64),
  },
  cloudSnapshotAcceptance: {
    sourceSha: 'e'.repeat(40),
    runId: 151,
    runAttempt: 1,
    artifactName: 'candidate-cold-concurrent-acceptance-151-1',
    artifactDigest: `sha256:${'4'.repeat(64)}`,
    evidenceSha256: '6'.repeat(64),
  },
  relayfileCloudQualification: {
    runId: 202,
    runAttempt: 1,
    artifactName: 'relayfile-cloud-candidate-202-1',
    artifactDigest: `sha256:${'7'.repeat(64)}`,
    attestationSha256: '3'.repeat(64),
    deploymentId: 'relayfile-cloud-preview-202',
  },
  promotion: 'none',
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    repository: { full_name: 'AgentWorkforce/relay' },
    workflow_run: {
      id: 901,
      run_attempt: 2,
      name: REQUEST_WORKFLOW_NAME,
      path: REQUEST_WORKFLOW_PATH,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'qualification/candidate-a',
      head_sha: relaySha,
      head_repository: { full_name: 'AgentWorkforce/relay' },
      actor: { login: 'approved-operator' },
      triggering_actor: { login: 'approved-operator' },
      ...overrides,
    },
  };
}

function artifact(runId = 901) {
  return {
    id: 77,
    name: REQUEST_ARTIFACT_NAME,
    expired: false,
    size_in_bytes: 4096,
    digest: `sha256:${'7'.repeat(64)}`,
    workflow_run: { id: runId },
  };
}

function request(producer: ReturnType<typeof validateQualificationRequestEvent>) {
  return {
    schemaVersion: 1,
    kind: 'relayCleanroomQualificationRequest',
    producer,
    qualificationManifest: manifest,
  };
}

function expectRejected(operation: () => unknown, message: RegExp) {
  expect(operation).toThrow(message);
}

describe('trusted cleanroom qualification request', () => {
  it('binds an approved manual qualification ref to its exact actor, SHA, artifact, and manifest', () => {
    const context = validateQualificationRequestEvent(event(), '["approved-operator"]');
    const selection = selectQualificationRequestArtifact(context, [
      { total_count: 1, artifacts: [artifact()] },
    ]);
    const normalized = validateQualificationRequest(request(context), context, selection);

    expect(normalized).toMatchObject({
      version: 1,
      kind: 'trustedRelayCleanroomQualification',
      requestArtifactDigest: `sha256:${'7'.repeat(64)}`,
      producer: { runId: 901, runAttempt: 2, actor: 'approved-operator', headSha: relaySha },
      manifest: { relaySha, releaseTag: 'v11.11.0-beta.1' },
    });
  });

  it('lets the trusted consumer fire for an approved malicious candidate ref without executing that ref', () => {
    const context = validateQualificationRequestEvent(
      event({ head_branch: 'qualification/malicious-ref', head_sha: relaySha }),
      '["approved-operator"]'
    );

    expect(context.headBranch).toBe('qualification/malicious-ref');
    expect(context.headSha).toBe(relaySha);
  });

  it('accepts a default-branch repository dispatch while keeping candidate identity in the manifest', () => {
    const context = validateQualificationRequestEvent(
      event({ event: 'repository_dispatch', head_branch: 'main', head_sha: 'f'.repeat(40) }),
      '["approved-operator"]'
    );
    const selection = selectQualificationRequestArtifact(context, [
      { total_count: 1, artifacts: [artifact()] },
    ]);

    expect(validateQualificationRequest(request(context), context, selection).manifest.relaySha).toBe(
      relaySha
    );
  });

  it.each([
    [
      'wrong repository',
      event(),
      (value: any) => (value.repository.full_name = 'attacker/relay'),
      /repository/,
    ],
    ['wrong workflow', event({ name: 'Attacker workflow' }), () => {}, /workflow_run.name/],
    ['wrong path', event({ path: '.github/workflows/attacker.yml' }), () => {}, /workflow_run.path/],
    ['push event', event({ event: 'push' }), () => {}, /workflow_run.event/],
    ['failed run', event({ conclusion: 'failure' }), () => {}, /workflow_run.conclusion/],
    [
      'fork head',
      event(),
      (value: any) => (value.workflow_run.head_repository.full_name = 'attacker/relay'),
      /head_repository/,
    ],
    ['unapproved actor', event({ actor: { login: 'attacker' } }), () => {}, /actor.login is not approved/],
    [
      'unapproved rerunner',
      event({ triggering_actor: { login: 'attacker' } }),
      () => {},
      /triggering_actor.login is not approved/,
    ],
    ['nested branch', event({ head_branch: 'qualification/attacker/nested' }), () => {}, /head_branch/],
    ['default branch manual run', event({ head_branch: 'main' }), () => {}, /head_branch/],
  ])('rejects %s', (_label, source, mutate, message) => {
    const value = structuredClone(source);
    mutate(value);
    expectRejected(() => validateQualificationRequestEvent(value, '["approved-operator"]'), message);
  });

  it('requires both the original and triggering actors to be explicitly configured', () => {
    expectRejected(() => validateQualificationRequestEvent(event(), ''), /JSON array/);
    expectRejected(
      () => validateQualificationRequestEvent(event(), '["approved-operator","approved-operator"]'),
      /unique/
    );
    const bot = validateQualificationRequestEvent(
      event({
        actor: { login: 'qualification-app[bot]' },
        triggering_actor: { login: 'qualification-app[bot]' },
      }),
      '["qualification-app[bot]"]'
    );
    expect(bot.actor).toBe('qualification-app[bot]');
  });

  it('rejects incomplete, duplicated, wrong-run, expired, oversized, or digest-less artifacts', () => {
    const context = validateQualificationRequestEvent(event(), '["approved-operator"]');
    const page = () => [{ total_count: 1, artifacts: [artifact()] }];
    expectRejected(() => selectQualificationRequestArtifact(context, []), /exactly one API page/);
    expectRejected(
      () => selectQualificationRequestArtifact(context, [...page(), ...page()]),
      /exactly one API page/
    );
    expectRejected(
      () => selectQualificationRequestArtifact(context, [{ total_count: 2, artifacts: [artifact()] }]),
      /contain every request artifact/
    );
    expectRejected(
      () =>
        selectQualificationRequestArtifact(context, [
          { total_count: 2, artifacts: [artifact(), artifact()] },
        ]),
      /exactly one artifact/
    );
    for (const [field, value, message] of [
      ['workflow_run', { id: 902 }, /triggering run/],
      ['expired', true, /must be false/],
      ['size_in_bytes', 300_000, /size is invalid/],
      ['digest', '', /digest is invalid/],
      ['name', 'attacker', /artifact.name/],
    ] as const) {
      const changed = { ...artifact(), [field]: value };
      expectRejected(
        () => selectQualificationRequestArtifact(context, [{ total_count: 1, artifacts: [changed] }]),
        message
      );
    }
  });

  it('rejects payload injection, producer substitution, and manual manifest SHA substitution', () => {
    const context = validateQualificationRequestEvent(event(), '["approved-operator"]');
    const selection = selectQualificationRequestArtifact(context, [
      { total_count: 1, artifacts: [artifact()] },
    ]);
    const injected = { ...request(context), attacker: true };
    expectRejected(() => validateQualificationRequest(injected, context, selection), /unexpected shape/);
    const wrongProducer = request({ ...context, runId: 902 });
    expectRejected(() => validateQualificationRequest(wrongProducer, context, selection), /producer/);
    const wrongManifest = request(context);
    wrongManifest.qualificationManifest = { ...manifest, relaySha: 'f'.repeat(40) };
    expectRejected(
      () => validateQualificationRequest(wrongManifest, context, selection),
      /relaySha must match/
    );
  });

  it('reads exactly one regular bounded request file without following symlinks', async () => {
    const context = validateQualificationRequestEvent(event(), '["approved-operator"]');
    const selection = selectQualificationRequestArtifact(context, [
      { total_count: 1, artifacts: [artifact()] },
    ]);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-cleanroom-request-'));
    const outside = path.join(directory, '..', `${path.basename(directory)}-outside.json`);
    try {
      await writeFile(path.join(directory, REQUEST_FILE_NAME), `${JSON.stringify(request(context))}\n`);
      await expect(readQualificationRequestDirectory(directory, context, selection)).resolves.toMatchObject({
        manifest: { relaySha },
      });
      await writeFile(path.join(directory, 'extra.json'), '{}');
      await expect(readQualificationRequestDirectory(directory, context, selection)).rejects.toThrow(
        /exactly one entry/
      );
      await rm(path.join(directory, 'extra.json'));
      await rm(path.join(directory, REQUEST_FILE_NAME));
      await writeFile(outside, `${JSON.stringify(request(context))}\n`);
      await symlink(outside, path.join(directory, REQUEST_FILE_NAME));
      await expect(readQualificationRequestDirectory(directory, context, selection)).rejects.toThrow(
        /regular file/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('keeps the request workflow no-secret and the consumer pinned to trusted workflow source', async () => {
    const requestSource = await readFile(
      '.github/workflows/relay-cleanroom-qualification-request.yml',
      'utf8'
    );
    const consumerSource = await readFile(
      '.github/workflows/relay-cleanroom-qualification-consumer.yml',
      'utf8'
    );
    const requestWorkflow = parse(requestSource) as any;
    const consumer = parse(consumerSource) as any;

    expect(requestWorkflow.permissions).toEqual({});
    expect(Object.keys(requestWorkflow.on)).toEqual(['repository_dispatch', 'workflow_dispatch']);
    expect(Object.keys(requestWorkflow.jobs)).toEqual(['emit-request']);
    expect(requestSource).not.toContain('secrets.');
    expect(requestSource).not.toContain('actions/checkout');
    expect(requestSource).not.toContain('environment:');
    expect(requestSource).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');

    expect(consumer.permissions).toEqual({});
    expect(Object.keys(consumer.on)).toEqual(['workflow_run']);
    expect(consumer.on.workflow_run).toEqual({ workflows: [REQUEST_WORKFLOW_NAME], types: ['completed'] });
    expect(Object.keys(consumer.jobs)).toEqual(['verify-request', 'qualification', 'qualification_cleanup']);
    const verify = consumer.jobs['verify-request'];
    expect(verify.environment).toBeUndefined();
    expect(verify.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(JSON.stringify(verify)).not.toContain('secrets.');
    expect(JSON.stringify(verify)).not.toContain('environment: snapshot-qualification');

    const qualification = consumer.jobs.qualification;
    expect(qualification.env).toEqual({ CLOUD_API_URL: 'https://agentrelay.com/cloud' });
    const fleetStep = qualification.steps.find(
      (step: any) => step.name === 'Run exact candidate Fleet Relayflow'
    );
    expect(fleetStep.env.OPENAI_API_KEY).toBe('${{ secrets.OPENAI_API_KEY }}');
    expect(fleetStep.env.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_API_KEY }}');
    for (const step of qualification.steps.filter((step: any) => step !== fleetStep)) {
      expect(step.env?.OPENAI_API_KEY).toBeUndefined();
      expect(step.env?.ANTHROPIC_API_KEY).toBeUndefined();
    }

    const checkouts = [
      ...verify.steps,
      ...qualification.steps,
      ...consumer.jobs.qualification_cleanup.steps,
    ].filter((step: any) => String(step.uses ?? '').startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(3);
    for (const checkout of checkouts) {
      expect(checkout.with.ref).toBe('${{ github.workflow_sha }}');
      expect(checkout.with['persist-credentials']).toBe(false);
      expect(checkout.with.repository).toBeUndefined();
    }
    expect(consumerSource).not.toContain('ref: ${{ github.sha }}');
    expect(consumerSource).not.toMatch(/ref:\s*\$\{\{ steps\.manifest\.outputs/);
    expect(consumerSource).not.toContain('Check out exact Relay candidate');
    expect(consumerSource).not.toContain('Check out exact Cloud candidate');
    const cleanupSource = JSON.stringify(consumer.jobs.qualification_cleanup);
    expect(consumer.jobs.qualification_cleanup.permissions).toEqual({ contents: 'read' });
    expect(cleanupSource).toContain('relay-cleanup/packages/cli/dist/cli/index.js');
    expect(cleanupSource).not.toContain('relay-candidate-install.mjs hydrate');
    expect(consumerSource).toContain('--source-sha "$RELAY_SHA"');
    expect(consumerSource).toContain('--package-version "$version"');
    expect(consumerSource).toContain('VERIFY_FLEET_EXPECTED_RELAY_SHA');
    expect(consumerSource).toContain('npx relayflows run workflows/verify-fleet-daytona.ts');
  });
});
