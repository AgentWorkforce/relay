import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Action-facing code intentionally stays dependency-free ESM so GitHub can run
// it before npm install. Vitest can import it directly for contract coverage.
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  PrProofContractError,
  changedRelayFlowCaseIds,
  classifyPullRequest,
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
import { assertSamePullRequestSnapshot, pullRequestSnapshot } from '../../scripts/pr-proof/prepare.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  boundedDuration,
  createPreparedRunProgressParser,
  createCliApiKeyEnvironment,
  preparedRunIdFromOutput,
} from '../../scripts/pr-proof/run-cloud.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { runProcess } from '../../scripts/pr-proof/run-arm.mjs';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const CASE_ID = '1591-application-ack-reconnect';
const HANDOFF_NONCE = 'a'.repeat(32);
const PS_PATH = ['/bin/ps', '/usr/bin/ps'].find((candidate) => existsSync(candidate));

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
        // This timeout measures when cleanup begins, not child startup. Leave
        // enough room for a contended runner to spawn and report the descendant
        // PID so the assertions exercise process-group termination itself.
        timeoutMs: 500,
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
    expect(source).not.toContain('github.event.pull_request.head.sha }}');
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
  });

  it('records the per-step Cloud sandbox id instead of the orchestrator id', async () => {
    const source = await readFile('scripts/pr-proof/run-arm.mjs', 'utf8');
    expect(source).toContain('process.env.SANDBOX_ID');
    expect(source).not.toContain('process.env.DAYTONA_SANDBOX_ID');
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
