import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// Action-facing code intentionally stays dependency-free ESM so GitHub can run
// it before npm install. Vitest can import it directly for contract coverage.
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  PrProofContractError,
  changedRelayFlowCaseIds,
  classifyPullRequest,
  runtimeSurfaceChanged,
  validateCaseManifest,
  validateEvidence,
  validateObservation,
  validateProofInput,
} from '../../scripts/pr-proof/contract.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { verifyEvidenceFiles } from '../../scripts/pr-proof/verify-evidence.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  downloadCloudEvidence,
  uploadCloudEvidence,
  validateCloudEvidenceEnvironment,
} from '../../scripts/pr-proof/cloud-storage.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  publishCommitStatus,
  publishOwnedCommitStatus,
  resolvePullRequest,
} from '../../scripts/pr-proof/report-status.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  assertSamePullRequestSnapshot,
  main as prepareMain,
  pullRequestFiles,
  pullRequestSnapshot,
} from '../../scripts/pr-proof/prepare.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  boundedDuration,
  createPreparedRunProgressParser,
  createCliApiKeyEnvironment,
  preparedRunIdFromOutput,
} from '../../scripts/pr-proof/run-cloud.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  openVerifiedBrokerExecutable,
  probeLandlockedProcessSupport,
  runLandlockedProcess,
  runProcess,
  verifyProtectedBrokerExecutable,
} from '../../scripts/pr-proof/run-arm.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  resolveBrokerArtifact,
  resolveBrokerArtifactPair,
} from '../../scripts/pr-proof/resolve-broker-artifacts.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { inspectBrokerArtifact } from '../../scripts/pr-proof/stage-broker-artifacts.mjs';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const CASE_ID = '1591-application-ack-reconnect';
const HANDOFF_NONCE = 'a'.repeat(32);
const PS_PATH = ['/bin/ps', '/usr/bin/ps'].find((candidate) => existsSync(candidate));
const HAS_TRUSTED_LANDLOCK_RUNTIME = probeLandlockedProcessSupport();

function proofBody(type = 'bugfix', caseId = CASE_ID) {
  return [
    '## RelayFlow Proof',
    '',
    `- Change type: \`${type}\` <!-- relay-pr-proof:type -->`,
    `- RelayFlow case: \`${caseId}\` <!-- relay-pr-proof:case -->`,
  ].join('\n');
}

function manifest(kind = 'bugfix') {
  return {
    version: 1,
    id: CASE_ID,
    kind,
    title: 'Reconnect when application acknowledgements stop',
    runner: {
      command: ['node', `tests/relayflows/cases/${CASE_ID}/run.mjs`],
    },
    requirements: [],
    timeoutSeconds: 900,
    expected: {
      base: {
        outcome: kind === 'feature' ? 'absent' : 'bug',
        signature: 'application_ack_stall_not_detected',
      },
      head: {
        outcome: 'fixed',
        signature: 'application_ack_stall_reconnects',
      },
    },
  };
}

function input() {
  return validateProofInput({
    version: 1,
    repository: 'AgentWorkforce/relay',
    pullRequest: 1610,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    caseId: CASE_ID,
    kind: 'bugfix',
    handoffNonce: HANDOFF_NONCE,
    manifest: manifest(),
  });
}

function evidence(arm: 'base' | 'head', sandboxId: string) {
  const proofInput = input();
  const expected = proofInput.manifest.expected[arm];
  return {
    version: 1,
    caseId: CASE_ID,
    arm,
    repository: 'AgentWorkforce/relay',
    pullRequest: 1610,
    targetSha: arm === 'base' ? BASE_SHA : HEAD_SHA,
    harnessSha: HEAD_SHA,
    handoffNonce: HANDOFF_NONCE,
    sandboxId,
    runnerExitCode: 0,
    outcome: expected.outcome,
    signature: expected.signature,
  };
}

describe('RelayFlow PR proof classification', () => {
  it('requires proof metadata for a conventional fix PR', () => {
    const result = classifyPullRequest({ title: 'fix(broker): reconnect dead links', body: '' });
    expect(result.required).toBe(true);
    expect(result.errors).toContainEqual(
      expect.stringContaining('must declare a RelayFlow Proof change type')
    );
  });

  it('requires explicit classification even without a conventional title', () => {
    const result = classifyPullRequest({ title: 'Update reconnect documentation', body: '' });
    expect(result.required).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('must declare a RelayFlow Proof change type')
    );
    expect(result.errors).toContainEqual(expect.stringContaining('must declare a RelayFlow Proof case'));
  });

  it('selects exactly one declared bug-fix case', () => {
    const result = classifyPullRequest({
      title: 'fix(broker): reconnect dead links',
      body: proofBody(),
    });
    expect(result).toMatchObject({ required: true, kind: 'bugfix', caseId: CASE_ID, errors: [] });
  });

  it('passes a non-functional PR without Cloud work', () => {
    const result = classifyPullRequest({
      title: 'docs: explain reconnect behavior',
      body: proofBody('non-functional', 'n/a'),
    });
    expect(result).toMatchObject({ required: false, caseId: null, errors: [] });
  });

  it('rejects attempts to mark a fix title non-functional', () => {
    const result = classifyPullRequest({
      title: 'fix(broker): reconnect dead links',
      body: proofBody('non-functional', 'n/a'),
    });
    expect(result.errors).toContainEqual(expect.stringContaining('cannot be non-functional'));
  });

  it('rejects duplicate proof selectors', () => {
    const result = classifyPullRequest({
      title: 'fix(broker): reconnect dead links',
      body: `${proofBody()}\n${proofBody()}`,
    });
    expect(result.errors).toContainEqual(expect.stringContaining('exactly one RelayFlow Proof case'));
    expect(result.errors).toContainEqual(expect.stringContaining('exactly one RelayFlow Proof change type'));
  });
});

describe('RelayFlow case manifest', () => {
  it('identifies case directories without treating shared case docs as cases', () => {
    expect(
      changedRelayFlowCaseIds([
        'tests/relayflows/cases/README.md',
        `tests/relayflows/cases/${CASE_ID}/case.json`,
        `tests/relayflows/cases/${CASE_ID}/run.mjs`,
      ])
    ).toEqual([CASE_ID]);
  });

  it('keeps malformed sibling case directories visible so selection fails closed', () => {
    expect(
      changedRelayFlowCaseIds([
        `tests/relayflows/cases/${CASE_ID}/case.json`,
        'tests/relayflows/cases/INVALID CASE/run.mjs',
      ])
    ).toEqual([CASE_ID, 'INVALID CASE']);
  });

  it('accepts a structured external case runner', () => {
    expect(validateCaseManifest(manifest(), { caseId: CASE_ID, kind: 'bugfix' })).toEqual(manifest());
  });

  it('rejects a runner outside its case directory', () => {
    const invalid = manifest();
    invalid.runner.command = ['node', 'scripts/untrusted.mjs'];
    expect(() => validateCaseManifest(invalid, { caseId: CASE_ID, kind: 'bugfix' })).toThrow(
      PrProofContractError
    );
  });

  it('requires an explicit absent outcome for feature bases', () => {
    const invalid = manifest('feature');
    invalid.expected.base.outcome = 'bug';
    expect(() => validateCaseManifest(invalid, { caseId: CASE_ID, kind: 'feature' })).toThrow(
      /Invalid RelayFlow case manifest/
    );
  });

  it('accepts only the exact broker runtime requirement', () => {
    const brokerManifest = { ...manifest(), requirements: ['broker-linux-x64'] };
    expect(validateCaseManifest(brokerManifest, { caseId: CASE_ID, kind: 'bugfix' })).toEqual(brokerManifest);
    expect(() =>
      validateCaseManifest(
        { ...manifest(), requirements: ['broker-linux-x64', 'arbitrary-tool'] },
        { caseId: CASE_ID, kind: 'bugfix' }
      )
    ).toThrow(PrProofContractError);
  });
});

describe('RelayFlow evidence gates', () => {
  it('rejects coercible non-numeric pull request provenance', () => {
    const invalid = {
      ...input(),
      pullRequest: true,
    };
    try {
      validateProofInput(invalid);
      throw new Error('expected invalid proof input to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PrProofContractError);
      expect((error as { details: string[] }).details).toContain(
        'proof input pullRequest must be a positive integer'
      );
    }
  });

  it('accepts exact SHA, outcome, and signature provenance', () => {
    const proofInput = input();
    expect(validateEvidence(evidence('base', 'sandbox-base'), proofInput, 'base')).toMatchObject({
      targetSha: BASE_SHA,
      outcome: 'bug',
    });
  });

  it('rejects a base crash masquerading as expected red', () => {
    const invalid = { ...evidence('base', 'sandbox-base'), runnerExitCode: 1 };
    try {
      validateEvidence(invalid, input(), 'base');
      throw new Error('expected invalid evidence to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PrProofContractError);
      expect((error as { details: string[] }).details).toContainEqual(
        expect.stringContaining('runner exit code')
      );
    }
  });

  it('rejects evidence from a stale or different handoff', () => {
    const invalid = { ...evidence('base', 'sandbox-base'), handoffNonce: 'b'.repeat(32) };
    expect(() => validateEvidence(invalid, input(), 'base')).toThrow(/Invalid base evidence/);
  });

  it('bounds PR-authored observation details before evidence upload', () => {
    expect(() =>
      validateObservation(
        {
          version: 1,
          caseId: CASE_ID,
          arm: 'base',
          outcome: 'bug',
          signature: manifest().expected.base.signature,
          details: 'x'.repeat(4_001),
        },
        { caseId: CASE_ID, arm: 'base', expected: manifest().expected.base }
      )
    ).toThrow(/Invalid case observation/);
  });

  it('rejects base and head evidence from the same sandbox', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-test-'));
    const inputPath = path.join(root, 'input.json');
    await writeFile(inputPath, JSON.stringify(input()));
    await writeFile(path.join(root, 'base.json'), JSON.stringify(evidence('base', 'same-sandbox')));
    await writeFile(path.join(root, 'head.json'), JSON.stringify(evidence('head', 'same-sandbox')));
    await expect(verifyEvidenceFiles({ inputPath, arm: 'both', artifactRoot: root })).rejects.toThrow(
      /distinct sandboxes/
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe('Cloud evidence handoff', () => {
  const env = {
    CLOUD_API_URL: 'https://cloud.test/cloud',
    CLOUD_API_ACCESS_TOKEN: 'sandbox-access-token',
    RUN_ID: 'run-123',
  };

  it('uploads evidence to nonce-bound run storage without exposing credentials in the URL', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return Response.json({ ok: true });
    };
    const record = evidence('base', 'sandbox-base');
    await uploadCloudEvidence(input(), 'base', record, { env, fetchImpl });
    expect(requestUrl).toBe(
      `https://cloud.test/cloud/api/v1/workflows/runs/run-123/storage/pr-proof/${HANDOFF_NONCE}/base.json`
    );
    expect(requestUrl).not.toContain('sandbox-access-token');
    expect(requestInit?.method).toBe('PUT');
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(requestInit?.body))).toMatchObject(record);
  });

  it('downloads structured evidence from the same nonce-bound object', async () => {
    const record = evidence('head', 'sandbox-head');
    const fetchImpl = async () => new Response(JSON.stringify(record), { status: 200 });
    await expect(downloadCloudEvidence(input(), 'head', { env, fetchImpl })).resolves.toEqual(record);
  });

  it('accepts the Cloud worker run-id alias and rejects conflicting runtime provenance', async () => {
    let requestUrl = '';
    const fetchImpl = async (url: string | URL | Request) => {
      requestUrl = String(url);
      return Response.json({ ok: true });
    };
    const workerEnv = {
      CLOUD_API_URL: env.CLOUD_API_URL,
      CLOUD_API_ACCESS_TOKEN: env.CLOUD_API_ACCESS_TOKEN,
      AGENT_RELAY_CLOUD_WORKER_RUN_ID: env.RUN_ID,
    };
    await uploadCloudEvidence(input(), 'base', evidence('base', 'sandbox-base'), {
      env: workerEnv,
      fetchImpl,
    });
    expect(requestUrl).toContain('/workflows/runs/run-123/storage/');
    expect(() =>
      validateCloudEvidenceEnvironment(input(), 'base', {
        ...workerEnv,
        RUN_ID: 'different-run',
      })
    ).toThrow(/conflicting workflow run IDs/);
  });

  it('rejects malformed request deadlines instead of disabling or collapsing the timeout', async () => {
    await expect(
      downloadCloudEvidence(input(), 'base', {
        env,
        requestTimeoutMs: Number.NaN,
        fetchImpl: async () => Response.json({}),
      })
    ).rejects.toThrow(/positive finite/);
    await expect(
      downloadCloudEvidence(input(), 'base', {
        env,
        requestTimeoutMs: 0.5,
        fetchImpl: async () => Response.json({}),
      })
    ).rejects.toThrow(/at least one millisecond/);
  });

  it('rejects incomplete Cloud evidence configuration before proof execution', () => {
    expect(() =>
      validateCloudEvidenceEnvironment(input(), 'base', {
        CLOUD_API_URL: env.CLOUD_API_URL,
        RUN_ID: env.RUN_ID,
      })
    ).toThrow(/CLOUD_API_ACCESS_TOKEN/);
  });
});

describe('Cloud dispatcher API key lifecycle', () => {
  const credentialEnv = {
    CLOUD_API_URL: 'https://cloud.test/cloud',
    CLOUD_API_KEY: 'ci-api-key',
  };

  it('requires exactly the Cloud URL and API key before dispatch', () => {
    expect(() => createCliApiKeyEnvironment({ CLOUD_API_URL: credentialEnv.CLOUD_API_URL })).toThrow(
      /CLOUD_API_KEY is required/
    );
    expect(() => createCliApiKeyEnvironment({ CLOUD_API_KEY: credentialEnv.CLOUD_API_KEY })).toThrow(
      /CLOUD_API_URL is required/
    );
  });

  it('rejects unbounded or malformed dispatcher durations', () => {
    const options = { fallback: 15_000, minimum: 100, maximum: 60_000, label: 'poll' };
    expect(boundedDuration(undefined, options)).toBe(15_000);
    expect(() => boundedDuration('not-a-number', options)).toThrow(/between 100 and 60000/);
    expect(() => boundedDuration('60001', options)).toThrow(/between 100 and 60000/);
  });

  it('captures the prepared run before the final Cloud submission response', () => {
    expect(
      preparedRunIdFromOutput(
        `Preparing run...\nAGENT_RELAY_CLOUD_PREPARED_RUN_ID=run-prepared-123\nUploading...\n`
      )
    ).toBe('run-prepared-123');
    expect(() => preparedRunIdFromOutput('AGENT_RELAY_CLOUD_PREPARED_RUN_ID=invalid run\n')).toThrow(
      /invalid run ID/
    );
  });

  it('waits for a complete prepared-run progress line split across stderr chunks', () => {
    const runIds: string[] = [];
    const parser = createPreparedRunProgressParser((runId: string) => runIds.push(runId));
    parser.write('Preparing run...\nAGENT_RELAY_CLOUD_PREPARED_RUN_ID=run-pre');
    expect(runIds).toEqual([]);
    parser.write('pared-123\nUploading...\n');
    parser.end();
    expect(runIds).toEqual(['run-prepared-123']);
  });

  it('passes one API key to every CLI subprocess and removes legacy refresh credentials', () => {
    const auth = createCliApiKeyEnvironment({
      ...credentialEnv,
      CLOUD_API_ACCESS_TOKEN: 'legacy-access',
      CLOUD_API_REFRESH_TOKEN: 'legacy-refresh',
      CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: '2027-08-25T00:00:00.000Z',
      CLOUD_API_REFRESH_TOKEN_EXPIRES_AT: '2027-08-25T00:00:00.000Z',
    });

    expect(auth.cliEnv.CLOUD_API_URL).toBe(credentialEnv.CLOUD_API_URL);
    expect(auth.cliEnv.CLOUD_API_KEY).toBe(credentialEnv.CLOUD_API_KEY);
    expect(auth.cliEnv.CLOUD_API_ACCESS_TOKEN).toBeUndefined();
    expect(auth.cliEnv.CLOUD_API_REFRESH_TOKEN).toBeUndefined();
    expect(auth.cliEnv.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT).toBeUndefined();
    expect(auth.cliEnv.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT).toBeUndefined();
  });
});

describe('exact broker artifact handoff', () => {
  it('requires exact per-arm broker provenance when the case requests it', () => {
    const brokerManifest = { ...manifest(), requirements: ['broker-linux-x64'] };
    const rawInput = {
      version: 1,
      repository: 'AgentWorkforce/relay',
      pullRequest: 1610,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      caseId: CASE_ID,
      kind: 'bugfix',
      handoffNonce: HANDOFF_NONCE,
      manifest: brokerManifest,
    };
    expect(() => validateProofInput(rawInput)).toThrow(PrProofContractError);
    expect(
      validateProofInput({
        ...rawInput,
        runtimeArtifacts: {
          broker: {
            base: {
              path: '.relayflow/pr-proof-binaries/base/agent-relay-broker',
              sha256: '5'.repeat(64),
              sourceSha: BASE_SHA,
            },
            head: {
              path: '.relayflow/pr-proof-binaries/head/agent-relay-broker',
              sha256: '6'.repeat(64),
              sourceSha: HEAD_SHA,
            },
          },
        },
      })
    ).toMatchObject({ runtimeArtifacts: { broker: { base: { sourceSha: BASE_SHA } } } });
  });

  it('resolves only a successful artifact from the dedicated workflow', async () => {
    const sha = '3'.repeat(40);
    const inspectedRunIds: number[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/actions/artifacts?')) {
        return Response.json({
          artifacts: [
            {
              name: `relayflow-broker-${sha}`,
              expired: true,
              updated_at: '2026-09-01T00:04:00Z',
              workflow_run: { id: 46 },
            },
            {
              name: `relayflow-broker-${sha}`,
              expired: false,
              updated_at: '2026-09-01T00:03:00Z',
              workflow_run: { id: 44 },
            },
            {
              name: `relayflow-broker-${sha}`,
              expired: false,
              updated_at: '2026-09-01T00:02:00Z',
              workflow_run: { id: 43 },
            },
            {
              name: `relayflow-broker-${sha}`,
              expired: false,
              updated_at: '2026-09-01T00:00:00Z',
              workflow_run: { id: 42 },
            },
          ],
        });
      }
      const runId = Number(value.split('/').at(-1));
      inspectedRunIds.push(runId);
      return Response.json({
        path:
          runId === 43
            ? '.github/workflows/untrusted-broker.yml'
            : '.github/workflows/relayflow-pr-proof-broker.yml',
        conclusion: runId === 44 ? 'failure' : 'success',
        head_sha: sha,
        event: 'pull_request_target',
        head_branch: 'feature/exact-broker',
      });
    };
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha,
        fetchImpl,
      })
    ).resolves.toEqual({ artifactName: `relayflow-broker-${sha}`, runId: 42 });
    expect(inspectedRunIds).toEqual([44, 43, 42]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 2_147_483_648])(
    'rejects invalid polling interval %s before querying GitHub',
    async (pollIntervalMs) => {
      const fetchImpl = vi.fn();
      await expect(
        resolveBrokerArtifact({
          apiUrl: 'https://api.github.test',
          repository: 'AgentWorkforce/relay',
          token: 'test-token',
          sha: '3'.repeat(40),
          fetchImpl,
          pollIntervalMs,
        })
      ).rejects.toThrow('broker artifact polling bounds are invalid');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('explains how to recover when the only exact artifact has expired', async () => {
    const sha = '3'.repeat(40);
    const fetchImpl = async () =>
      Response.json({
        artifacts: [
          {
            name: `relayflow-broker-${sha}`,
            expired: true,
            updated_at: '2026-05-01T00:00:00Z',
            workflow_run: { id: 42 },
          },
        ],
      });
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha,
        fetchImpl,
        maxAttempts: 1,
      })
    ).rejects.toThrow('expired after the 90-day retention window; update/rebase the PR onto current main');
  });

  it('rejects an artifact whose workflow run belongs to another source SHA', async () => {
    const sha = '3'.repeat(40);
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/actions/artifacts?')) {
        return Response.json({
          artifacts: [
            {
              name: `relayflow-broker-${sha}`,
              expired: false,
              updated_at: '2026-09-01T00:00:00Z',
              workflow_run: { id: 42 },
            },
          ],
        });
      }
      return Response.json({
        path: '.github/workflows/relayflow-pr-proof-broker.yml',
        conclusion: 'success',
        head_sha: '4'.repeat(40),
        event: 'pull_request_target',
        head_branch: 'feature/exact-broker',
      });
    };
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha,
        fetchImpl,
        maxAttempts: 1,
      })
    ).rejects.toThrow(
      `No successful .github/workflows/relayflow-pr-proof-broker.yml artifact named relayflow-broker-${sha} after 1 attempts`
    );
  });

  it.each([
    ['pull_request', 'feature/exact-broker'],
    ['workflow_dispatch', 'main'],
    ['push', 'feature/exact-broker'],
    ['schedule', 'feature/exact-broker'],
  ])('rejects an artifact from untrusted event %s on %s', async (event, headBranch) => {
    const sha = '3'.repeat(40);
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/actions/artifacts?')) {
        return Response.json({
          artifacts: [
            {
              name: `relayflow-broker-${sha}`,
              expired: false,
              updated_at: '2026-09-01T00:00:00Z',
              workflow_run: { id: 42 },
            },
          ],
        });
      }
      return Response.json({
        path: '.github/workflows/relayflow-pr-proof-broker.yml',
        conclusion: 'success',
        head_sha: sha,
        event,
        head_branch: headBranch,
      });
    };
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha,
        fetchImpl,
        maxAttempts: 1,
      })
    ).rejects.toThrow(
      `No successful .github/workflows/relayflow-pr-proof-broker.yml artifact named relayflow-broker-${sha} after 1 attempts`
    );
  });

  it.each(['push', 'schedule'])('accepts an exact artifact from a main %s', async (event) => {
    const sha = '3'.repeat(40);
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/actions/artifacts?')) {
        return Response.json({
          artifacts: [
            {
              name: `relayflow-broker-${sha}`,
              expired: false,
              updated_at: '2026-09-01T00:00:00Z',
              workflow_run: { id: 42 },
            },
          ],
        });
      }
      return Response.json({
        path: '.github/workflows/relayflow-pr-proof-broker.yml',
        conclusion: 'success',
        head_sha: sha,
        event,
        head_branch: 'main',
      });
    };
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha,
        fetchImpl,
      })
    ).resolves.toEqual({ artifactName: `relayflow-broker-${sha}`, runId: 42 });
  });

  it('waits for the exact broker workflow artifact to finish', async () => {
    const sha = '3'.repeat(40);
    let listingCalls = 0;
    let sleeps = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/actions/artifacts?')) {
        listingCalls += 1;
        return Response.json({
          artifacts:
            listingCalls === 1
              ? []
              : [
                  {
                    name: `relayflow-broker-${sha}`,
                    expired: false,
                    updated_at: '2026-09-01T00:00:00Z',
                    workflow_run: { id: 42 },
                  },
                ],
        });
      }
      return Response.json({
        path: '.github/workflows/relayflow-pr-proof-broker.yml',
        conclusion: 'success',
        head_sha: sha,
        event: 'pull_request_target',
        head_branch: 'feature/exact-broker',
      });
    };
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha,
        fetchImpl,
        maxAttempts: 2,
        pollIntervalMs: 25,
        sleepImpl: async (milliseconds: number) => {
          expect(milliseconds).toBe(25);
          sleeps += 1;
        },
      })
    ).resolves.toEqual({ artifactName: `relayflow-broker-${sha}`, runId: 42 });
    expect(listingCalls).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('aborts the sibling exact-SHA lookup when either concurrent resolution fails', async () => {
    const baseSha = '3'.repeat(40);
    const headSha = '4'.repeat(40);
    let beginBaseFailure: (() => void) | undefined;
    const headSleeping = new Promise<void>((resolve) => {
      beginBaseFailure = resolve;
    });
    let siblingAborted = false;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes(`relayflow-broker-${baseSha}`)) {
        await headSleeping;
        return new Response('failed', { status: 500 });
      }
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ artifacts: [] });
    };
    const sleepImpl = async (_milliseconds: number, { signal }: { signal: AbortSignal }) => {
      beginBaseFailure?.();
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          siblingAborted = true;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    await expect(
      resolveBrokerArtifactPair({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        baseSha,
        headSha,
        fetchImpl,
        maxAttempts: 2,
        pollIntervalMs: 10_000,
        sleepImpl,
      })
    ).rejects.toThrow('GitHub API 500');
    expect(siblingAborted).toBe(true);
  });

  it('waits through producer queue headroom and the broker timeout by default', async () => {
    let elapsedMs = 0;
    let listingCalls = 0;
    const fetchImpl = async () => {
      listingCalls += 1;
      return Response.json({ artifacts: [] });
    };
    await expect(
      resolveBrokerArtifact({
        apiUrl: 'https://api.github.test',
        repository: 'AgentWorkforce/relay',
        token: 'test-token',
        sha: '3'.repeat(40),
        fetchImpl,
        sleepImpl: async (milliseconds: number) => {
          elapsedMs += milliseconds;
        },
      })
    ).rejects.toThrow(
      'allows 10 minutes for Actions queue/start delay and 30 minutes for producer execution'
    );
    expect(listingCalls).toBe(243);
    expect(elapsedMs).toBe(40 * 60_000 + 20_000);
  });

  it('verifies exact source provenance and binary digest before staging', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-broker-'));
    const sha = '4'.repeat(40);
    const directory = path.join(root, '.relayflow', 'pr-proof-binaries', 'base');
    const binary = Buffer.from('exact broker fixture');
    const sha256 = createHash('sha256').update(binary).digest('hex');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'agent-relay-broker'), binary);
    await writeFile(
      path.join(directory, 'broker-manifest.json'),
      JSON.stringify({ version: 1, sourceSha: sha, sha256 })
    );
    await expect(inspectBrokerArtifact({ arm: 'base', expectedSha: sha, root })).resolves.toEqual({
      path: '.relayflow/pr-proof-binaries/base/agent-relay-broker',
      sha256,
      sourceSha: sha,
    });
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(!HAS_TRUSTED_LANDLOCK_RUNTIME)(
    'keeps the exact launcher probe eligible under a caller controlling TTY',
    () => {
      const moduleUrl = pathToFileURL(path.resolve('scripts/pr-proof/run-arm.mjs')).href;
      const probeScript = [
        "import { closeSync, openSync } from 'node:fs';",
        "const tty = openSync('/dev/tty', 'w');",
        'closeSync(tty);',
        `const { probeLandlockedProcessSupport } = await import(${JSON.stringify(moduleUrl)});`,
        'process.exit(probeLandlockedProcessSupport() ? 0 : 1);',
      ].join('\n');
      const ptyScript = [
        'import os',
        'import pty',
        'import sys',
        'pid, master = pty.fork()',
        'if pid == 0:',
        '    os.execv(sys.argv[1], [sys.argv[1], "--input-type=module", "-e", sys.argv[2]])',
        '_, status = os.waitpid(pid, 0)',
        'os.close(master)',
        'if not os.WIFEXITED(status):',
        '    sys.exit(125)',
        'sys.exit(os.WEXITSTATUS(status))',
      ].join('\n');

      expect(() =>
        execFileSync('/usr/bin/python3', ['-c', ptyScript, process.execPath, probeScript], {
          stdio: 'ignore',
          timeout: 15_000,
        })
      ).not.toThrow();
    }
  );

  it.skipIf(!HAS_TRUSTED_LANDLOCK_RUNTIME)(
    'isolates trusted bootstrap imports from the case working directory',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-bootstrap-import-'));
      const importAttackMarker = path.join(root, 'root-import-attack');
      try {
        await writeFile(
          path.join(root, 'ctypes.py'),
          `open(${JSON.stringify(importAttackMarker)}, "w").write("root import escaped")\n`
        );
        const result = await runLandlockedProcess('/bin/true', [], {
          writableRoots: [root],
          cwd: root,
          echo: false,
          timeoutMs: 2_000,
        });
        expect(
          result,
          `isolated bootstrap failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        ).toMatchObject({ exitCode: 0, timedOut: false });
        expect(existsSync(importAttackMarker)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!HAS_TRUSTED_LANDLOCK_RUNTIME)(
    'allows private PTY allocation only after dropping bootstrap privileges',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-openpty-'));
      try {
        const result = await runLandlockedProcess(
          '/usr/bin/python3',
          [
            '-c',
            [
              'import ctypes',
              'import errno',
              'import os',
              'import pty',
              'status = {}',
              'with open("/proc/self/status", encoding="utf-8") as status_file:',
              '    for line in status_file:',
              '        if ":" in line:',
              '            key, value = line.split(":", 1)',
              '            status[key] = value.strip()',
              'for capability_set in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):',
              '    assert int(status[capability_set], 16) == 0',
              'assert status["NoNewPrivs"] == "1"',
              'for fd in range(3, 256):',
              '    try:',
              '        os.fstat(fd)',
              '    except OSError as error:',
              '        assert error.errno == errno.EBADF',
              '    else:',
              '        raise AssertionError(f"inherited file descriptor {fd}")',
              'assert not [entry for entry in os.listdir("/dev/pts") if entry.isdecimal()]',
              'libc = ctypes.CDLL(None, use_errno=True)',
              'mount_result = libc.mount(None, b"/", None, 0, None)',
              'assert mount_result == -1 and ctypes.get_errno() == errno.EPERM',
              'ctypes.set_errno(0)',
              'unshare_result = libc.syscall(272, 0x00020000)',
              'assert unshare_result == -1 and ctypes.get_errno() == errno.EPERM',
              'try:',
              '    controlling_tty = os.open("/dev/tty", os.O_WRONLY | os.O_CLOEXEC)',
              'except OSError as error:',
              '    assert error.errno in (errno.ENXIO, errno.ENODEV, errno.ENOENT, errno.EACCES)',
              'else:',
              '    os.close(controlling_tty)',
              '    raise AssertionError("case inherited a writable controlling TTY")',
              'assert os.path.samefile("/dev/ptmx", "/dev/pts/ptmx")',
              'master, slave = pty.openpty()',
              'try:',
              '    assert os.ttyname(slave).startswith("/dev/pts/")',
              'finally:',
              '    os.close(slave)',
              '    os.close(master)',
            ].join('\n'),
          ],
          {
            writableRoots: [root],
            cwd: root,
            echo: false,
            timeoutMs: 2_000,
          }
        );
        expect(
          result,
          `private PTY launcher failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        ).toMatchObject({ exitCode: 0, timedOut: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!HAS_TRUSTED_LANDLOCK_RUNTIME)(
    'isolates case PTYs from an occupied outer devpts namespace',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-occupied-devpts-'));
      const holder = spawn(
        '/usr/bin/python3',
        [
          '-c',
          [
            'import os',
            'import pty',
            'import select',
            'import sys',
            'master, slave = pty.openpty()',
            'print(os.ttyname(slave), flush=True)',
            'data = b""',
            'while True:',
            '    readable, _, _ = select.select([master, sys.stdin.buffer], [], [])',
            '    if master in readable:',
            '        data += os.read(master, 4096)',
            '    if sys.stdin.buffer in readable:',
            '        if sys.stdin.buffer.read(1) != b"D":',
            '            raise RuntimeError("PTY holder lost its completion signal")',
            '        while select.select([master], [], [], 0)[0]:',
            '            data += os.read(master, 4096)',
            '        break',
            'attacked = b"OUTER_PTY_ATTACK" in data',
            'print("OUTER_PTY_ATTACKED" if attacked else "OUTER_PTY_UNTOUCHED", flush=True)',
            'os.close(slave)',
            'os.close(master)',
            'sys.exit(9 if attacked else 0)',
          ].join('\n'),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let holderStdout = '';
      const holderExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        holder.once('exit', (code, signal) => {
          resolve({ code, signal });
        })
      );
      try {
        const slavePath = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('PTY holder did not start')), 2_000);
          holder.stdout.on('data', (chunk) => {
            holderStdout += chunk.toString();
            const newline = holderStdout.indexOf('\n');
            if (newline < 0) return;
            clearTimeout(timer);
            resolve(holderStdout.slice(0, newline));
          });
          holder.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`PTY holder exited before readiness (${signal ?? code ?? 'unknown'})`));
          });
          holder.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        expect(slavePath).toMatch(/^\/dev\/pts\/\d+$/);

        const result = await runLandlockedProcess(
          '/usr/bin/python3',
          [
            '-c',
            [
              'import os',
              'import pty',
              'import sys',
              'assert not [entry for entry in os.listdir("/dev/pts") if entry.isdecimal()]',
              'master, slave = pty.openpty()',
              'try:',
              '    outer_path = sys.argv[1]',
              '    if os.path.exists(outer_path):',
              '        with open(outer_path, "wb", buffering=0) as outer_candidate:',
              '            outer_candidate.write(b"OUTER_PTY_ATTACK\\n")',
              'finally:',
              '    os.close(slave)',
              '    os.close(master)',
            ].join('\n'),
            slavePath,
          ],
          {
            writableRoots: [root],
            cwd: root,
            echo: false,
            timeoutMs: 5_000,
          }
        );
        holder.stdin.end('D');
        expect(result).toMatchObject({ exitCode: 0, timedOut: false });
        const outerResult = await holderExit;
        expect(outerResult).toEqual({ code: 0, signal: null });
        expect(holderStdout).toContain('OUTER_PTY_UNTOUCHED');
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) {
          holder.kill('SIGTERM');
          await holderExit;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!HAS_TRUSTED_LANDLOCK_RUNTIME)(
    'prevents the case from reacquiring sudo after no_new_privs',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-no-sudo-'));
      try {
        const result = await runLandlockedProcess('/usr/bin/sudo', ['-n', '/bin/true'], {
          writableRoots: [root],
          cwd: root,
          echo: false,
          timeoutMs: 2_000,
        });
        expect(result.exitCode).not.toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!HAS_TRUSTED_LANDLOCK_RUNTIME)(
    'keeps a stable self-spawning broker immutable under the case Landlock policy',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-broker-exec-'));
      const sha = '4'.repeat(40);
      const directory = path.join(root, '.relayflow', 'pr-proof-binaries', 'base');
      const binaryPath = path.join(directory, 'agent-relay-broker');
      const privateRoot = path.join(root, 'private');
      const writableRoot = path.join(root, 'writable');
      await mkdir(directory, { recursive: true });
      await mkdir(privateRoot);
      await mkdir(writableRoot);
      await copyFile('/bin/sh', binaryPath);
      const binary = await readFile(binaryPath);
      const sha256 = createHash('sha256').update(binary).digest('hex');
      await writeFile(
        path.join(directory, 'broker-manifest.json'),
        JSON.stringify({ version: 1, sourceSha: sha, sha256 })
      );

      const executable = await openVerifiedBrokerExecutable({
        input: {
          baseSha: sha,
          headSha: '5'.repeat(40),
          runtimeArtifacts: {
            broker: {
              base: {
                path: '.relayflow/pr-proof-binaries/base/agent-relay-broker',
                sha256,
                sourceSha: sha,
              },
            },
          },
        },
        arm: 'base',
        privateRoot,
        root,
      });
      try {
        expect(executable).not.toBeNull();
        await copyFile('/bin/false', binaryPath);
        const processOptions = {
          writableRoots: [writableRoot],
          cwd: writableRoot,
          echo: false,
          timeoutMs: 2_000,
        };
        const chmodAttack = await runLandlockedProcess(
          '/bin/chmod',
          ['u+w', executable!.path],
          processOptions
        );
        expect(chmodAttack).toMatchObject({ exitCode: 0, timedOut: false });
        await expect(
          verifyProtectedBrokerExecutable({
            brokerPath: executable!.path,
            expectedSha256: executable!.sha256,
            expectedSize: executable!.size,
          })
        ).rejects.toThrow('protected broker inode metadata changed');

        const writeAttack = await runLandlockedProcess(
          '/bin/sh',
          ['-c', 'cat /bin/false > "$1"', 'broker-write-attack', executable!.path],
          processOptions
        );
        expect(writeAttack.exitCode).not.toBe(0);
        await chmod(executable!.path, 0o500);

        for (const attack of ['truncate -s 0 "$1"', 'rm "$1"', 'mv "$1" "$2/moved"', 'ln "$1" "$2/alias"']) {
          const attackResult = await runLandlockedProcess(
            '/bin/sh',
            ['-c', attack, 'broker-path-attack', executable!.path, writableRoot],
            processOptions
          );
          expect(attackResult.exitCode).not.toBe(0);
        }
        const allowedWrite = await runLandlockedProcess(
          '/bin/sh',
          ['-c', 'printf allowed > "$1/allowed"', 'allowed-write', writableRoot],
          processOptions
        );
        expect(allowedWrite).toMatchObject({ exitCode: 0, timedOut: false });

        const selfSpawn = await runLandlockedProcess(
          executable!.path,
          [
            '-c',
            'actual=$(readlink /proc/$$/exe) && [ "$actual" = "$1" ] && "$actual" -c "exit 0"',
            'broker-self-spawn',
            executable!.path,
          ],
          processOptions
        );
        expect(selfSpawn).toMatchObject({ exitCode: 0, timedOut: false });
        await expect(
          verifyProtectedBrokerExecutable({
            brokerPath: executable!.path,
            expectedSha256: executable!.sha256,
            expectedSize: executable!.size,
          })
        ).resolves.toBeUndefined();
      } finally {
        if (executable) await chmod(executable.directory, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe('process timeout contract', () => {
  it('marks a process timed out even when it exits zero after SIGTERM', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      { timeoutMs: 100 }
    );
    expect(result.timedOut).toBe(true);
  });

  it('terminates descendants that inherit output pipes instead of hanging after the parent exits', async () => {
    const startedAt = Date.now();
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join('');
    const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.skipIf(process.platform === 'win32' || !PS_PATH)(
    'force-kills same-group descendants even when they do not inherit output pipes',
    async () => {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid) + '\\n');",
        "process.on('SIGTERM', () => process.exit(0));",
        'setInterval(() => {}, 1000);',
      ].join('');
      const result = await runProcess(process.execPath, ['-e', script], {
        echo: false,
        timeoutMs: 100,
        terminationGraceMs: 100,
      });
      const descendantPid = Number(result.stdout.trim());
      expect(result.timedOut).toBe(true);
      expect(descendantPid).toBeGreaterThan(0);
      const deadline = Date.now() + 2_000;
      let running = true;
      while (running && Date.now() < deadline) {
        let processState = '';
        try {
          processState = execFileSync(PS_PATH, ['-o', 'stat=', '-p', String(descendantPid)], {
            encoding: 'utf8',
          }).trim();
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 1) throw error;
        }
        running = processState.length > 0 && !processState.startsWith('Z');
        if (running) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (running) process.kill(descendantPid, 'SIGKILL');
      expect(running).toBe(false);
    }
  );

  it('preserves UTF-8 characters split across output chunks', async () => {
    const script = [
      'process.stdout.write(Buffer.from([0xe2]));',
      'setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 25);',
    ].join('');
    const result = await runProcess(process.execPath, ['-e', script], { echo: false });
    expect(result.stdout).toBe('€');
  });

  it('caps captured and live output by UTF-8 bytes', async () => {
    const captured = await runProcess(process.execPath, ['-e', "process.stdout.write('€'.repeat(10))"], {
      echo: false,
      maxCaptureBytes: 5,
    });
    expect(Buffer.byteLength(captured.stdout, 'utf8')).toBeLessThanOrEqual(5);
    expect(captured.stdout).not.toContain('�');

    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runProcess(process.execPath, ['-e', "process.stdout.write('abcdef')"], {
        maxLiveOutputBytes: 4,
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join('')).toContain('abcd');
    expect(writes.join('')).not.toContain('abcdef');
    expect(writes.join('')).toContain('live output truncated');
  });

  it('rejects malformed process bounds before spawning', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: Number.NaN })
    ).rejects.toThrow(/timeoutMs must be an integer/);
    await expect(
      runProcess(process.execPath, ['-e', 'process.exit(0)'], { terminationGraceMs: -1 })
    ).rejects.toThrow(/terminationGraceMs must be an integer/);
  });
});

describe('required head status', () => {
  const statusEnv = {
    GITHUB_REPOSITORY: 'AgentWorkforce/relay',
    GITHUB_TOKEN: 'github-token',
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_SERVER_URL: 'https://github.test',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '2',
  };

  it('publishes the stable proof context on the exact head SHA', async () => {
    let requestUrl = '';
    let requestBody: Record<string, string> = {};
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ id: 1 });
    };
    await publishCommitStatus({
      sha: HEAD_SHA,
      state: 'success',
      description: 'proof passed',
      env: statusEnv,
      fetchImpl,
    });
    expect(requestUrl).toBe(`https://api.github.test/repos/AgentWorkforce/relay/statuses/${HEAD_SHA}`);
    expect(requestBody).toMatchObject({ context: 'RelayFlow PR proof', state: 'success' });
  });

  it('publishes status for a fork head while leaving credential rejection to preparation', async () => {
    await expect(
      resolvePullRequest({
        payload: {
          pull_request: {
            number: 1612,
            head: { sha: HEAD_SHA, repo: { full_name: 'outside/fork' } },
          },
        },
        repository: 'AgentWorkforce/relay',
        apiUrl: 'https://api.github.test',
        token: 'github-token',
        fetchImpl: async () => Response.json({}),
      })
    ).resolves.toEqual({ number: 1612, headSha: HEAD_SHA });
  });

  it('finalizes only the pending status owned by the current workflow run', async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, string> }> = [];
    const ownerTargetUrl = 'https://github.test/AgentWorkforce/relay/actions/runs/12345/attempts/2';
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (!init?.method) {
        return Response.json({
          statuses: [{ context: 'RelayFlow PR proof', state: 'pending', target_url: ownerTargetUrl }],
        });
      }
      return Response.json({ id: 2 });
    };
    await expect(
      publishOwnedCommitStatus({
        sha: HEAD_SHA,
        state: 'error',
        description: 'cancelled',
        env: statusEnv,
        fetchImpl,
      })
    ).resolves.toMatchObject({ published: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toMatchObject({ state: 'error' });
  });

  it('does not let a cancelled predecessor overwrite a newer run', async () => {
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return Response.json({
        statuses: [
          {
            context: 'RelayFlow PR proof',
            state: 'pending',
            target_url: 'https://github.test/AgentWorkforce/relay/actions/runs/newer',
          },
        ],
      });
    };
    await expect(
      publishOwnedCommitStatus({
        sha: HEAD_SHA,
        state: 'error',
        description: 'cancelled',
        env: statusEnv,
        fetchImpl,
      })
    ).resolves.toMatchObject({ published: false });
    expect(requests).toBe(1);
  });

  it('gives each rerun attempt a distinct status owner marker', async () => {
    const targetUrls: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      targetUrls.push(JSON.parse(String(init?.body)).target_url);
      return Response.json({ id: targetUrls.length });
    };
    await publishCommitStatus({
      sha: HEAD_SHA,
      state: 'pending',
      description: 'attempt 1',
      env: { ...statusEnv, GITHUB_RUN_ATTEMPT: '1' },
      fetchImpl,
    });
    await publishCommitStatus({
      sha: HEAD_SHA,
      state: 'pending',
      description: 'attempt 2',
      env: statusEnv,
      fetchImpl,
    });
    expect(targetUrls).toEqual([
      'https://github.test/AgentWorkforce/relay/actions/runs/12345/attempts/1',
      'https://github.test/AgentWorkforce/relay/actions/runs/12345/attempts/2',
    ]);
  });
});

describe('pull request snapshot consistency', () => {
  const pullRequest = {
    number: 1612,
    title: 'feat(ci): prove one case',
    body: proofBody('feature'),
    head: { sha: HEAD_SHA, repo: { full_name: 'AgentWorkforce/relay' } },
    base: { sha: BASE_SHA },
  };

  it('accepts the same live metadata and exact base/head pair', () => {
    expect(() =>
      assertSamePullRequestSnapshot(pullRequestSnapshot(pullRequest), structuredClone(pullRequest))
    ).not.toThrow();
  });

  it('rejects a head or proof-metadata edit during file enumeration', () => {
    const snapshot = pullRequestSnapshot(pullRequest);
    expect(() =>
      assertSamePullRequestSnapshot(snapshot, {
        ...pullRequest,
        head: { ...pullRequest.head, sha: '3'.repeat(40) },
      })
    ).toThrow(/headSha/);
    expect(() =>
      assertSamePullRequestSnapshot(snapshot, { ...pullRequest, body: proofBody('non-functional', 'n/a') })
    ).toThrow(/body/);
  });
});

describe('trusted dispatcher source contract', () => {
  it('never checks out PR head code on the credential-bearing GitHub runner', async () => {
    const source = await readFile('.github/workflows/relayflow-pr-proof.yml', 'utf8');
    expect(source).toContain('pull_request_target:');
    expect(source).toContain('ref: ${{ github.event.pull_request.base.sha || github.sha }}');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('git add -f -- .relayflow/pr-proof-input.json');
    expect(source).toContain('statuses: write');
    expect(source).toContain('report-status.mjs start');
    expect(source).toContain('report-status.mjs finish');
    expect(source).toContain('concurrency:');
    expect(source).toContain('cancel-in-progress: true');
    expect(source).toContain("if: always() && steps.status.outputs.head_sha != ''");
    expect(source).not.toContain('always() && !cancelled()');
    expect(source).toContain('--expected-head-sha "${{ steps.status.outputs.head_sha }}"');
    expect(source).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
    expect(source).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(source).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(source).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
    expect(source).toContain('resolve-broker-artifacts.mjs');
    expect(source).toContain('stage-broker-artifacts.mjs');
    expect(source).toContain('actions: read');
    expect(source).not.toContain('github.event.pull_request.head.sha }}');
  });

  it('fits broker resolution, Cloud execution, and setup inside the dispatcher deadline', async () => {
    const dispatcher = await readFile('.github/workflows/relayflow-pr-proof.yml', 'utf8');
    const resolver = await readFile('scripts/pr-proof/resolve-broker-artifacts.mjs', 'utf8');
    const dispatcherMinutes = Number(dispatcher.match(/timeout-minutes: (\d+)/)?.[1]);
    const cloudTimeoutMs = Number(dispatcher.match(/PR_PROOF_CLOUD_TIMEOUT_MS: '(\d+)'/)?.[1]);
    const brokerProducerMinutes = Number(resolver.match(/BROKER_PRODUCER_TIMEOUT_MS = (\d+) \* 60_000/)?.[1]);
    const brokerQueueMinutes = Number(resolver.match(/BROKER_QUEUE_HEADROOM_MS = (\d+) \* 60_000/)?.[1]);
    const pollIntervalMs = Number(
      resolver.match(/RESOLVE_POLL_INTERVAL_MS = ([\d_]+)/)?.[1]?.replaceAll('_', '')
    );
    const pollSlackAttempts = Number(resolver.match(/RESOLVE_POLL_SLACK_ATTEMPTS = (\d+)/)?.[1]);
    const setupHeadroomMs = 5 * 60_000;
    expect(resolver).toContain('const [base, head] = await Promise.all([');
    expect(dispatcherMinutes * 60_000).toBeGreaterThanOrEqual(
      (brokerProducerMinutes + brokerQueueMinutes) * 60_000 +
        pollSlackAttempts * pollIntervalMs +
        cloudTimeoutMs +
        setupHeadroomMs
    );
  });

  it('builds proof brokers from an attested exact checkout without secrets', async () => {
    const source = await readFile('.github/workflows/relayflow-pr-proof-broker.yml', 'utf8');
    const triggerSection = source.slice(source.indexOf('on:'), source.indexOf('permissions:'));
    const pushSection = source.slice(source.indexOf('  push:'), source.indexOf('  pull_request:'));
    expect(triggerSection).toContain('  schedule:');
    expect(triggerSection).toContain("cron: '17 3 * * 1'");
    expect(triggerSection).toContain(
      "  pull_request:\n    paths:\n      - '.github/workflows/relayflow-pr-proof-broker.yml'"
    );
    expect(triggerSection).toContain('  pull_request_target:');
    expect(triggerSection).toContain('types: [opened, synchronize, reopened, edited, ready_for_review]');
    expect(triggerSection).not.toContain('  workflow_dispatch:');
    expect(source).toContain('SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(source).toContain('ref: ${{ env.SOURCE_SHA }}');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('permissions:\n  contents: read');
    expect(source).toContain(
      'group: relayflow-pr-proof-broker-${{ github.event_name }}-${{ github.event.pull_request.head.sha || github.sha }}'
    );
    expect(source).toContain('cancel-in-progress: true');
    expect(source).toContain(
      "name: ${{ github.event_name == 'pull_request' && 'Validate PR-head Linux broker' || 'Build exact Linux broker' }}"
    );
    expect(source).toContain("github.event_name != 'pull_request_target'");
    expect(source).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(source).toContain('"$CARGO_BIN" build');
    expect(source).not.toContain('Swatinem/rust-cache');
    expect(source).not.toContain('actions/cache');
    expect(source).not.toContain('Cache Rust build');
    expect(source).toContain('--locked --release');
    const cacheCredentialUnset = source.indexOf(
      'unset ACTIONS_CACHE_URL ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ACTIONS_RESULTS_URL'
    );
    expect(cacheCredentialUnset).toBeGreaterThan(0);
    expect(cacheCredentialUnset).toBeLessThan(source.indexOf('"$CARGO_BIN" build'));
    const workflowFileUnset = source.indexOf(
      'unset GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT GITHUB_STEP_SUMMARY'
    );
    const isolatedBuild = source.indexOf('-- env -i', source.indexOf('BUILD_STATUS=0'));
    expect(workflowFileUnset).toBeGreaterThan(cacheCredentialUnset);
    expect(workflowFileUnset).toBeLessThan(isolatedBuild);
    const cargoBuild = source.indexOf('"$CARGO_BIN" build');
    expect(isolatedBuild).toBeLessThan(cargoBuild);
    const isolatedEnvironment = source.slice(isolatedBuild, cargoBuild);
    for (const forbidden of [
      'ACTIONS_CACHE_URL=',
      'ACTIONS_RUNTIME_TOKEN=',
      'ACTIONS_RUNTIME_URL=',
      'ACTIONS_RESULTS_URL=',
      'GITHUB_ENV=',
      'GITHUB_PATH=',
      'GITHUB_OUTPUT=',
      'GITHUB_STEP_SUMMARY=',
    ]) {
      expect(isolatedEnvironment).not.toContain(forbidden);
    }
    expect(source).toContain('useradd --system --user-group --no-create-home');
    expect(source).toContain('BUILD_ROOT="/opt/relay-pr-proof-builder"');
    expect(source).toContain('ISOLATED_SOURCE_ROOT="$BUILD_ROOT/source"');
    expect(source).toContain('-o "$RUNNER_UID" -g "$BUILDER_GID" -m 0710 "$BUILD_ROOT"');
    expect(source).toContain(
      'sudo install -d -o "$RUNNER_UID" -g "$BUILDER_GID" -m 0750 "$ISOLATED_SOURCE_ROOT"'
    );
    expect(source).toContain('git archive --format=tar "$SOURCE_SHA" | tar -xf - -C "$ISOLATED_SOURCE_ROOT"');
    expect(source).toContain(
      'sudo install -d -o "$RUNNER_UID" -g "$BUILDER_GID" -m 0750 "$ISOLATED_TOOLCHAIN_ROOT"'
    );
    expect(source).toContain('cp -a --reflink=auto "$HOST_TOOLCHAIN_ROOT/." "$ISOLATED_TOOLCHAIN_ROOT/"');
    expect(source).toContain('TOOLCHAIN_BIN="$ISOLATED_TOOLCHAIN_ROOT/bin"');
    expect(source).toContain('CARGO_BIN="$TOOLCHAIN_BIN/cargo"');
    expect(source).toContain('test -r "$1/Cargo.toml"');
    expect(source).toContain('test -x "$2/bin/cargo"');
    expect(source).toContain('"$2/bin/cargo" --version >/dev/null');
    expect(source).toContain('test ! -w "$2/bin/cargo"');
    const isolatedWorkingDirectory = source.indexOf('cd "$ISOLATED_SOURCE_ROOT"');
    expect(isolatedWorkingDirectory).toBeGreaterThan(0);
    expect(isolatedWorkingDirectory).toBeLessThan(isolatedBuild);
    expect(source).toContain('--manifest-path "$ISOLATED_SOURCE_ROOT/Cargo.toml"');
    for (const flag of [
      '--clear-groups',
      '--no-new-privs',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--ambient-caps=-all',
    ]) {
      expect(source.match(new RegExp(flag, 'g'))).toHaveLength(2);
    }
    expect(source).toContain('chmod -R go-w "$GITHUB_WORKSPACE"');
    expect(source).toContain('test ! -w "$1/Cargo.toml"');
    expect(source).toContain('test "$(id -G | wc -w)" -eq 1');
    expect(source).toContain('for capability_set in CapInh CapPrm CapEff CapBnd CapAmb');
    expect(source).toContain('test "$(status_value NoNewPrivs)" = 1');
    expect(source).toContain('echo "::stop-commands::$WORKFLOW_COMMAND_TOKEN"');
    expect(source).toContain('trap cleanup_on_exit EXIT');
    expect(source).toContain('if [ "$cleanup_status" -ne 0 ]; then\n              exit "$cleanup_status"');
    expect(source).toContain('if [ "$KILL_STATUS" -eq 0 ]; then\n            resume_workflow_commands');
    expect(source).toContain('pkill -KILL -u "$BUILDER_UID"');
    expect(source).toContain('pkill -KILL -U "$BUILDER_UID"');
    expect(source).toContain('sudo --non-interactive env -i');
    expect(source).toContain('PATH=/usr/bin:/bin');
    expect(source).toContain('BUILDER_UID="$BUILDER_UID"');
    expect(source).toContain('/bin/sh -c');
    expect(source).toContain('/usr/bin/pgrep "$1" "$BUILDER_UID"');
    expect(source).toContain('0) exit 10 ;;');
    expect(source).toContain('1) exit 11 ;;');
    expect(source).toContain('*) exit 12 ;;');
    expect(source).toContain('probe_builder_uid -u || effective_probe_status=$?');
    expect(source).toContain('probe_builder_uid -U || real_probe_status=$?');
    expect(source).toContain('11:11) return 0 ;;');
    expect(source).toContain('10:10|10:11|11:10) ;;');
    expect(source).toContain('sudo pgrep -a -u "$BUILDER_UID"');
    expect(source).toContain('sudo pgrep -a -U "$BUILDER_UID"');
    const cleanup = source.indexOf('kill_builder_processes || KILL_STATUS=$?');
    const killStatusBranch = source.indexOf('if [ "$KILL_STATUS" -ne 0 ]; then');
    const buildStatusBranch = source.indexOf('if [ "$BUILD_STATUS" -ne 0 ]; then');
    const stage = source.indexOf('"$BUILDER_BROKER" "$STAGING_DIR/agent-relay-broker"');
    expect(cleanup).toBeGreaterThan(cargoBuild);
    expect(killStatusBranch).toBeGreaterThan(cleanup);
    expect(buildStatusBranch).toBeGreaterThan(killStatusBranch);
    expect(stage).toBeGreaterThan(buildStatusBranch);
    expect(source).toContain('BROKER_SOURCE: /opt/relay-pr-proof-builder/staging/agent-relay-broker');
    expect(source).toContain('name: relayflow-broker-${{ env.SOURCE_SHA }}');
    expect(source).toContain("if: github.event_name != 'pull_request'");
    expect(source).toContain('retention-days: 90');
    expect(source).toContain("- 'tests/relayflows/cases/**'");
    expect(pushSection).not.toContain('paths:');
    expect(source).not.toContain('secrets.');
  });

  it('gates head execution on deterministic base evidence', async () => {
    const source = await readFile('workflows/pr-proof.ts', 'utf8');
    expect(source).toContain(".onError('fail-fast')");
    expect(source).toContain(".step('gate-base'");
    expect(source).toContain("dependsOn: ['gate-base']");
    expect(source).toContain(".step('gate-red-green'");
    expect(source).toContain('PR_PROOF_ARM_COMPLETE arm=base');
    expect(source).toContain('PR_PROOF_ARM_COMPLETE arm=head');
    expect(source).toContain('--source cloud');
    expect(source).toContain("result.status !== 'completed'");
    expect(source).toContain('.timeout(2_700_000)');
    expect(source).not.toContain('.timeout(3_600_000)');
  });

  it('records the per-step Cloud sandbox id instead of the orchestrator id', async () => {
    const source = await readFile('scripts/pr-proof/run-arm.mjs', 'utf8');
    expect(source).toContain('process.env.SANDBOX_ID');
    expect(source).not.toContain('process.env.DAYTONA_SANDBOX_ID');
    expect(source).toContain('SYS_LANDLOCK_CREATE_RULESET = 444');
    expect(source).toContain('SYS_LANDLOCK_RESTRICT_SELF = 446');
    expect(source).toContain('secure broker execution requires Landlock ABI >= 3');
    expect(source).toContain('WRITE_FILE = 1 << 1');
    expect(source).toContain('SYS_UNSHARE = 272');
    expect(source).toContain('SYS_CAPSET = 126');
    expect(source).toContain('newinstance,ptmxmode=0666,mode=0600,max=64');
    expect(source).toContain('secure broker execution refuses an inherited controlling TTY');
    expect(source).toContain('MS_NOSUID | MS_NOEXEC');
    expect(source).toContain('mount("/dev/pts/ptmx", "/dev/ptmx", None, MS_BIND, None)');
    expect(source.match(/os\.path\.samefile\("\/dev\/ptmx", "\/dev\/pts\/ptmx"\)/g)).toHaveLength(2);
    expect(source).toContain('for capability_set in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")');
    expect(source).toContain('SYS_CLOSE_RANGE = 436');
    expect(source).toContain('secure broker execution requires locked non-root securebits');
    expect(source).toContain('secure broker execution requires NoNewPrivs=1');
    expect(source).toContain('("/dev/null", "/dev/ptmx")');
    expect(source).toContain('allow_path("/dev/pts", WRITE_FILE)');
    expect(source).toContain("'/usr/bin/sudo'");
    expect(source).toContain("'-I'");
    expect(source).toContain("'-S'");
    expect(source).toContain('REFER = 1 << 13');
    expect(source).toContain('TRUNCATE = 1 << 14');
    expect(source).toContain('PR_SET_NO_NEW_PRIVS = 38');
    expect(source).toContain('await handle.close();\n    await chmod(privateDirectory, 0o500);');
    expect(source).toContain('writableRoots: [temporaryHome, harnessDir, targetDir, resultDir, scratchDir]');
    expect(source).not.toContain('writableRoots: [temporaryRoot');
    expect(source).not.toContain('memfd_create');
    expect(source).toContain("access('/usr/bin/python3', fsConstants.X_OK)");
    expect(source).toContain("access('/usr/bin/sudo', fsConstants.X_OK)");
    expect(source).toContain('CASE_ENVIRONMENT_KEYS.includes(key)');
    expect(source).toContain('{ ...options, env: caseEnvironment }');
    expect(source).not.toContain('options.env ?? process.env');
  });

  it('uses one non-refreshing API key and cancels remote work on termination', async () => {
    const source = await readFile('scripts/pr-proof/run-cloud.mjs', 'utf8');
    expect(source).toContain("process.once('SIGTERM', signalHandler)");
    expect(source).toContain('activeCommandController?.abort()');
    expect(source).toContain('AGENT_RELAY_CLOUD_REPORT_PREPARED_RUN_ID');
    expect(source).toContain('captureLaunchProgressError(() => launchProgress.write(text))');
    expect(source).toContain("['cloud', 'cancel', runId, '--json']");
    expect(source).toContain("requiredCredential(env, 'CLOUD_API_KEY')");
    expect(source).not.toContain("path.join(authDir, 'cloud-auth.json')");
    expect(source).not.toContain('CLOUD_API_REFRESH_TOKEN=');
  });

  it('emits the prepared Cloud run id before upload and final submission', async () => {
    const source = await readFile('packages/cloud/src/workflows.ts', 'utf8');
    const marker = source.indexOf("if (process.env.AGENT_RELAY_CLOUD_REPORT_PREPARED_RUN_ID === '1')");
    const upload = source.indexOf('Creating tarball...');
    const launch = source.indexOf('Launching workflow...');
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(upload);
    expect(marker).toBeLessThan(launch);
  });
});

describe('classification reads the diff, not the title', () => {
  const nonFunctional = (caseId = 'n/a') =>
    [
      `- Change type: \`non-functional\` <!-- relay-pr-proof:type -->`,
      `- RelayFlow case: \`${caseId}\` <!-- relay-pr-proof:case -->`,
    ].join('\n');

  it('treats a workflow-only change as non-runtime', () => {
    expect(runtimeSurfaceChanged(['workflows/verify-features.ts', 'scripts/pr-proof/contract.mjs'])).toBe(
      false
    );
  });

  it('treats any broker or package source change as runtime', () => {
    expect(runtimeSurfaceChanged(['crates/broker/src/runtime/fleet.rs'])).toBe(true);
    expect(runtimeSurfaceChanged(['packages/cli/src/cli/commands/local-agent.ts'])).toBe(true);
  });

  it('fails closed for a path the allowlist has never seen', () => {
    // A new top-level directory must not become proof-exempt by default.
    expect(runtimeSurfaceChanged(['some-brand-new-top-level/thing.ts'])).toBe(true);
  });

  /**
   * The defect this closes, direction 1: a `fix(` PR that only edits a
   * scheduled workflow was told its change type "cannot be non-functional",
   * so it had to fabricate a runtime proof it could not honestly build.
   */
  it('accepts non-functional on a fix( PR that changes no runtime file', () => {
    const result = classifyPullRequest({
      title: 'fix(workflow): fail loudly on alert delivery',
      body: nonFunctional(),
      changedFiles: ['workflows/verify-features.ts', 'CHANGELOG.md'],
    });
    expect(result.errors).toEqual([]);
    expect(result.required).toBe(false);
  });

  it('still rejects non-functional when the same PR touches runtime code', () => {
    const result = classifyPullRequest({
      title: 'fix(workflow): fail loudly on alert delivery',
      body: nonFunctional(),
      changedFiles: ['workflows/verify-features.ts', 'crates/broker/src/runtime/fleet.rs'],
    });
    expect(result.errors.join(' ')).toContain('changes runtime files');
  });

  /**
   * Direction 2, and the more serious hole: the gate was bypassable by wording.
   * A runtime change titled `chore(` required no proof at all.
   */
  it('requires a proof for a runtime change even when the title is chore(', () => {
    const result = classifyPullRequest({
      title: 'chore(broker): tidy delivery bookkeeping',
      body: '',
      changedFiles: ['crates/broker/src/runtime/delivery.rs'],
    });
    expect(result.required).toBe(true);
  });

  it('does not require a proof for a chore( PR that only touches docs', () => {
    const result = classifyPullRequest({
      title: 'chore(docs): clarify attach modes',
      body: nonFunctional(),
      changedFiles: ['docs/attach.md', 'README.md'],
    });
    expect(result.errors).toEqual([]);
    expect(result.required).toBe(false);
  });

  /**
   * `scripts/` is not exempt wholesale: publish.yml runs
   * scripts/inject-posthog-key.mjs to rewrite the compiled CLI before it
   * ships, so editing it changes what users receive.
   */
  it('treats a publish-time script as runtime', () => {
    expect(runtimeSurfaceChanged(['scripts/inject-posthog-key.mjs'])).toBe(true);
  });

  it('fails closed for a scripts/ subtree the allowlist has never seen', () => {
    expect(runtimeSurfaceChanged(['scripts/some-new-tool/main.mjs'])).toBe(true);
  });

  it('still exempts the CI-only script subtrees', () => {
    expect(runtimeSurfaceChanged(['scripts/pr-proof/prepare.mjs'])).toBe(false);
    expect(runtimeSurfaceChanged(['scripts/evals/run-relay-evals.mjs'])).toBe(false);
  });

  /**
   * A rename reports only its destination path. Moving a runtime file into
   * docs/ must not read as a docs-only change.
   */
  it('treats a runtime file renamed into an exempt directory as runtime', () => {
    expect(runtimeSurfaceChanged(['docs/old-fleet.rs', 'crates/broker/src/runtime/fleet.rs'])).toBe(true);
  });

  /**
   * Without this, a `chore(`-titled runtime change declaring non-functional
   * with a valid case id was silently coerced to `bugfix` and raised nothing.
   */
  it('rejects a non-functional declaration on a runtime change whatever the title says', () => {
    const result = classifyPullRequest({
      title: 'chore(broker): tidy delivery bookkeeping',
      body: nonFunctional('1593-parked-agent-orphaned-receipt'),
      changedFiles: ['crates/broker/src/runtime/delivery.rs'],
    });
    expect(result.errors.join(' ')).toContain('cannot be non-functional');
  });

  it('falls back to title-only behaviour when the diff is unavailable', () => {
    // changedFiles omitted: preserve the previous contract rather than
    // silently exempting a change nobody inspected.
    const result = classifyPullRequest({
      title: 'fix(broker): reconnect dead links',
      body: nonFunctional(),
    });
    expect(result.errors.join(' ')).toContain('cannot be non-functional');
  });
});

describe('RelayFlow proof changed-file collection', () => {
  const withStubbedFetch = async (impl: typeof globalThis.fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  const jsonResponse = (payload: unknown) =>
    ({ ok: true, status: 200, json: async () => payload }) as unknown as Response;

  /**
   * GitHub reports a rename's destination in `filename` and its origin in
   * `previous_filename`. Dropping the latter let a runtime file move into an
   * exempt directory and read as a non-runtime change.
   */
  it('includes the pre-rename path of a renamed file', async () => {
    await withStubbedFetch(
      (async () =>
        jsonResponse([
          {
            filename: 'docs/retired-fleet-notes.md',
            previous_filename: 'crates/broker/src/runtime/fleet.rs',
          },
        ])) as unknown as typeof globalThis.fetch,
      async () => {
        const files = await pullRequestFiles('https://api.github.test', 'o/r', 1, 't');
        expect(files).toContain('crates/broker/src/runtime/fleet.rs');
        expect(runtimeSurfaceChanged(files)).toBe(true);
      }
    );
  });

  /**
   * A short diff returns on the first page, so pagination itself needs its own
   * cover: if accumulation regressed to keeping only the last page, runtime
   * files from earlier pages would silently drop out of the list and the PR
   * could read as non-runtime.
   */
  it('accumulates files across every page of a multi-page diff', async () => {
    const lastPage = 3;
    await withStubbedFetch(
      (async (url: string) => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        // Pages 1 and 2 are full; page 3 is short and ends pagination.
        const size = page < lastPage ? 100 : 40;
        return jsonResponse(Array.from({ length: size }, (_, i) => ({ filename: `docs/p${page}-f${i}.md` })));
      }) as unknown as typeof globalThis.fetch,
      async () => {
        const files = await pullRequestFiles('https://api.github.test', 'o/r', 1, 't');
        expect(files).toHaveLength(240);
        // One from every page, not just the last.
        expect(files).toContain('docs/p1-f0.md');
        expect(files).toContain('docs/p2-f0.md');
        expect(files).toContain('docs/p3-f39.md');
      }
    );
  });

  /**
   * GitHub caps this endpoint at 3,000 files, so a full 30th page cannot be
   * told apart from a truncated diff. Refusing is the only safe answer:
   * classifying on a truncated list would let runtime files past the cap go
   * unseen and the PR read as non-runtime.
   *
   * The stub is page-aware and returns distinct filenames per page, so the
   * test fails if pagination stalls on page 1 instead of advancing.
   */
  it('refuses a diff that reaches the 3,000-file API cap', async () => {
    const pagesRequested: number[] = [];
    await withStubbedFetch(
      (async (url: string) => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        pagesRequested.push(page);
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({
            filename: `packages/cli/src/p${page}-f${i}.ts`,
          }))
        );
      }) as unknown as typeof globalThis.fetch,
      async () => {
        await expect(pullRequestFiles('https://api.github.test', 'o/r', 1, 't')).rejects.toMatchObject({
          ambiguousScope: true,
        });
        // Exactly the 30 capped pages, each requested once and in order.
        expect(pagesRequested).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      }
    );
  });
});

describe('RelayFlow proof preparation with an unreadable diff', () => {
  /**
   * The title-only fallback can legitimately reach the required path with
   * `changedFiles === null`. Downstream, `changedFiles.some(...)` then threw a
   * bare TypeError — a crash instead of a diagnosis. A required proof cannot be
   * validated without the file list, so it must fail closed and say why.
   */
  it('fails closed with a clear error instead of a TypeError', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pr-proof-nulldiff-'));
    const eventPath = path.join(dir, 'event.json');
    const pull = {
      number: 7,
      title: 'fix(broker): reconnect dead links',
      body: [
        '- Change type: `bugfix` <!-- relay-pr-proof:type -->',
        '- RelayFlow case: `1593-parked-agent-orphaned-receipt` <!-- relay-pr-proof:case -->',
      ].join('\n'),
      head: { sha: 'a'.repeat(40), repo: { full_name: 'AgentWorkforce/relay' } },
      base: { sha: 'b'.repeat(40) },
    };
    await writeFile(eventPath, JSON.stringify({ pull_request: pull }), 'utf8');

    const originalFetch = globalThis.fetch;
    const originalArgv = process.argv;
    const env = { ...process.env };
    globalThis.fetch = (async (url: string) => {
      // The files endpoint is down; every other read succeeds.
      if (String(url).includes('/files?')) {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => pull } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    process.argv = ['node', 'prepare.mjs', '--event', eventPath, '--output', path.join(dir, 'out.json')];
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_REPOSITORY = 'AgentWorkforce/relay';
    process.env.GITHUB_API_URL = 'https://api.github.test';
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;

    try {
      await expect(prepareMain()).rejects.toThrow(/cannot be validated without the changed-file list/);
    } finally {
      globalThis.fetch = originalFetch;
      process.argv = originalArgv;
      process.env = env;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
