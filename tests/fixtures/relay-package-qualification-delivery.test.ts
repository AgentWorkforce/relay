import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  ATTESTATION_ARTIFACT_NAME,
  REQUEST_ARTIFACT_NAME,
  REQUEST_FILE_NAME,
  expectedCloudDispatch,
  readBoundedRequestFile,
  selectQualificationArtifacts,
  validateCloudDispatchRequest,
  validateRequestArtifactDirectory,
  validateWorkflowRunEvent,
} from '../../scripts/verify-features/relay-package-qualification-delivery.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const ATTESTATION_DIGEST = `sha256:${'b'.repeat(64)}`;
const REQUEST_DIGEST = `sha256:${'c'.repeat(64)}`;

function workflowRunEvent(overrides: Record<string, unknown> = {}) {
  return {
    repository: { full_name: 'AgentWorkforce/relay' },
    workflow_run: {
      id: 123456,
      run_attempt: 2,
      name: 'Relay package qualification',
      path: '.github/workflows/relay-package-qualification.yml',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'qualification/relay-11.10.4-cleanroom.20260906.1665.6',
      head_sha: SOURCE_SHA,
      head_repository: { full_name: 'AgentWorkforce/relay' },
      ...overrides,
    },
  };
}

const CONTEXT = validateWorkflowRunEvent(workflowRunEvent());

function artifact(id: number, name: string, digest: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    expired: false,
    size_in_bytes: 2048,
    digest,
    workflow_run: { id: CONTEXT.runId },
    ...overrides,
  };
}

function artifactPages(overrides: Record<string, unknown> = {}) {
  return [
    {
      total_count: 3,
      artifacts: [
        artifact(10, REQUEST_ARTIFACT_NAME, REQUEST_DIGEST),
        artifact(11, ATTESTATION_ARTIFACT_NAME, ATTESTATION_DIGEST),
        artifact(12, 'relay-package-qualification', `sha256:${'d'.repeat(64)}`),
      ],
      ...overrides,
    },
  ];
}

describe('trusted Relay package qualification delivery', () => {
  it('derives producer identity only from an exact successful qualification workflow run', () => {
    expect(CONTEXT).toEqual({
      repository: 'AgentWorkforce/relay',
      workflowName: 'Relay package qualification',
      workflowPath: '.github/workflows/relay-package-qualification.yml',
      runId: 123456,
      runAttempt: 2,
      sourceGitSha: SOURCE_SHA,
      sourceBranch: 'qualification/relay-11.10.4-cleanroom.20260906.1665.6',
    });
  });

  it('accepts the Actions API path form with a ref suffix while keeping the path exact', () => {
    expect(
      validateWorkflowRunEvent(
        workflowRunEvent({
          path: `${CONTEXT.workflowPath}@${CONTEXT.sourceBranch}`,
        })
      )
    ).toEqual(CONTEXT);
  });

  it.each([
    ['main', { head_branch: 'main' }],
    ['an attacker-controlled nested qualification ref', { head_branch: 'qualification/attacker/payload' }],
    ['a traversal-shaped qualification ref', { head_branch: 'qualification/../main' }],
    ['a fork producer', { head_repository: { full_name: 'attacker/relay' } }],
    ['the wrong workflow path', { path: '.github/workflows/attacker.yml' }],
    [
      'the wrong workflow path with a trusted-looking ref suffix',
      { path: '.github/workflows/attacker.yml@qualification/candidate' },
    ],
    [
      'a workflow path with multiple ref suffixes',
      { path: `${CONTEXT.workflowPath}@main@qualification/candidate` },
    ],
    ['a non-manual event', { event: 'push' }],
    ['an incomplete run', { status: 'in_progress' }],
    ['a failed run', { conclusion: 'failure' }],
    ['an invalid SHA', { head_sha: 'not-a-sha' }],
    ['an invalid run attempt', { run_attempt: 0 }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateWorkflowRunEvent(workflowRunEvent(overrides))).toThrow();
  });

  it('rejects a workflow event delivered to the wrong repository', () => {
    const event = workflowRunEvent();
    event.repository.full_name = 'attacker/relay';
    expect(() => validateWorkflowRunEvent(event)).toThrow(/event.repository.full_name/);
  });

  it('selects one bounded request and attestation artifact from the triggering run', () => {
    expect(selectQualificationArtifacts(CONTEXT, artifactPages())).toEqual({
      requestArtifactId: 10,
      requestArtifactDigest: REQUEST_DIGEST,
      attestationArtifactDigest: ATTESTATION_DIGEST,
    });
  });

  it.each([
    ['a duplicate request', [artifact(13, REQUEST_ARTIFACT_NAME, REQUEST_DIGEST)]],
    ['an expired request', [], { expired: true }],
    ['an oversized request', [], { size_in_bytes: 65 * 1024 }],
    ['a request from another run', [], { workflow_run: { id: CONTEXT.runId + 1 } }],
    ['a request without a v4 digest', [], { digest: 'not-a-digest' }],
  ])('rejects %s artifact', (_label, extras, requestOverrides = {}) => {
    const pages = artifactPages();
    pages[0].artifacts[0] = artifact(10, REQUEST_ARTIFACT_NAME, REQUEST_DIGEST, requestOverrides);
    pages[0].artifacts.push(...extras);
    expect(() => selectQualificationArtifacts(CONTEXT, pages)).toThrow();
  });

  it('requires the uploaded request payload to exactly match the trusted run and attestation identity', () => {
    const selection = selectQualificationArtifacts(CONTEXT, artifactPages());
    const expected = expectedCloudDispatch(CONTEXT, selection);
    expect(validateCloudDispatchRequest(structuredClone(expected), CONTEXT, selection)).toEqual(expected);

    const injected = structuredClone(expected);
    (injected.client_payload as Record<string, unknown>).attacker = true;
    expect(() => validateCloudDispatchRequest(injected, CONTEXT, selection)).toThrow(/exactly match/);

    const redirected = structuredClone(expected);
    redirected.client_payload.relay.sourceGitSha = 'e'.repeat(40);
    expect(() => validateCloudDispatchRequest(redirected, CONTEXT, selection)).toThrow(/exactly match/);
  });

  it('requires a bounded single-file request artifact with no symlink', async () => {
    const selection = selectQualificationArtifacts(CONTEXT, artifactPages());
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-cloud-request-'));
    await writeFile(
      path.join(directory, REQUEST_FILE_NAME),
      JSON.stringify(expectedCloudDispatch(CONTEXT, selection))
    );
    await expect(validateRequestArtifactDirectory(directory, CONTEXT, selection)).resolves.toEqual(
      expectedCloudDispatch(CONTEXT, selection)
    );

    await writeFile(path.join(directory, 'unexpected.txt'), 'unexpected');
    await expect(validateRequestArtifactDirectory(directory, CONTEXT, selection)).rejects.toThrow(
      /exactly one/
    );

    const symlinkDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-cloud-request-link-'));
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-cloud-request-target-'));
    await mkdir(path.join(targetDirectory, 'nested'));
    await writeFile(
      path.join(targetDirectory, 'nested', REQUEST_FILE_NAME),
      JSON.stringify(expectedCloudDispatch(CONTEXT, selection))
    );
    await symlink(
      path.join(targetDirectory, 'nested', REQUEST_FILE_NAME),
      path.join(symlinkDirectory, REQUEST_FILE_NAME)
    );
    await expect(validateRequestArtifactDirectory(symlinkDirectory, CONTEXT, selection)).rejects.toThrow(
      /regular file/
    );
    await expect(readBoundedRequestFile(path.join(symlinkDirectory, REQUEST_FILE_NAME))).rejects.toThrow();
  });

  it('closes the no-follow request handle after a successful read', async () => {
    let closed = false;
    const handle = {
      stat: async () => ({ isFile: () => true, size: 3 }),
      readFile: async () => '{}\n',
      close: async () => {
        closed = true;
      },
    };

    await expect(readBoundedRequestFile('/not-opened', async () => handle)).resolves.toBe('{}\n');
    expect(closed).toBe(true);
  });

  it.each(['stat', 'readFile'])('closes the no-follow request handle after a %s failure', async (failure) => {
    let closed = false;
    const handle = {
      stat: async () => {
        if (failure === 'stat') throw new Error('stat failed');
        return { isFile: () => true, size: 10 };
      },
      readFile: async () => {
        throw new Error('read failed');
      },
      close: async () => {
        closed = true;
      },
    };

    await expect(readBoundedRequestFile('/not-opened', async () => handle)).rejects.toThrow(
      new RegExp(`${failure === 'stat' ? 'stat' : 'read'} failed`)
    );
    expect(closed).toBe(true);
  });

  it('keeps Cloud credentials and dispatch code in a no-checkout trusted second job', async () => {
    const file = path.resolve('.github/workflows/relay-package-qualification-delivery.yml');
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8'));
    const workflow = parse(source) as Record<string, any>;

    expect(workflow.name).toBe('Relay package qualification Cloud delivery');
    expect(workflow.on).toEqual({
      workflow_run: {
        workflows: ['Relay package qualification'],
        types: ['completed'],
      },
    });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['verify-request', 'deliver-request']);

    const verify = workflow.jobs['verify-request'];
    expect(verify.if).toBe("${{ github.event.workflow_run.conclusion == 'success' }}");
    expect(verify.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(JSON.stringify(verify)).not.toContain('secrets.');
    expect(JSON.stringify(verify)).toContain('${{ github.workflow_sha }}');
    expect(JSON.stringify(verify)).toContain('persist-credentials');
    expect(JSON.stringify(verify)).toContain('request_artifact_id');

    const deliver = workflow.jobs['deliver-request'];
    expect(deliver.needs).toBe('verify-request');
    expect(deliver.permissions).toEqual({});
    expect(deliver.environment).toBe('snapshot-qualification');
    expect(JSON.stringify(deliver)).not.toContain('actions/checkout');
    expect(JSON.stringify(deliver)).not.toContain('scripts/verify-features');
    expect(JSON.stringify(deliver)).toContain(
      'actions/create-github-app-token@a8d616148505b5069dccd32f177bb87d7f39123b'
    );
    expect(JSON.stringify(deliver)).toContain('repos/AgentWorkforce/cloud/dispatches');
    expect(JSON.stringify(deliver)).toContain('permission-contents');
  });
});
