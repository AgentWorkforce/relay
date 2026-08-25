import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  validateProofInput,
} from '../../scripts/pr-proof/contract.mjs';
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { verifyEvidenceFiles } from '../../scripts/pr-proof/verify-evidence.mjs';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const CASE_ID = '1591-application-ack-reconnect';

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

describe('trusted dispatcher source contract', () => {
  it('never checks out PR head code on the credential-bearing GitHub runner', async () => {
    const source = await readFile('.github/workflows/relayflow-pr-proof.yml', 'utf8');
    expect(source).toContain('pull_request_target:');
    expect(source).toContain('ref: ${{ github.event.pull_request.base.sha || github.sha }}');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('git add -f -- .relayflow/pr-proof-input.json');
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
  });

  it('records the per-step Cloud sandbox id instead of the orchestrator id', async () => {
    const source = await readFile('scripts/pr-proof/run-arm.mjs', 'utf8');
    expect(source).toContain('process.env.SANDBOX_ID');
    expect(source).not.toContain('process.env.DAYTONA_SANDBOX_ID');
  });
});
