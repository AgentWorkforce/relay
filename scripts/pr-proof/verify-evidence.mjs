#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ARTIFACT_ROOT,
  INPUT_PATH,
  PR_PROOF_VERSION,
  PrProofContractError,
  validateEvidence,
  validateProofInput,
} from './contract.mjs';
import { downloadCloudEvidence } from './cloud-storage.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function verifyEvidenceFiles({ inputPath, arm, artifactRoot = ARTIFACT_ROOT }) {
  const input = validateProofInput(await readJson(inputPath));
  const base = await readJson(path.join(artifactRoot, 'base.json'));
  const head = arm === 'base' ? null : await readJson(path.join(artifactRoot, 'head.json'));
  return verifyEvidenceRecords({ input, arm, base, head });
}

export function verifyEvidenceRecords({ input, arm, base: baseRecord, head: headRecord }) {
  const base = validateEvidence(baseRecord, input, 'base');
  if (arm === 'base') return { input, base, head: null };

  const head = validateEvidence(headRecord, input, 'head');
  if (base.sandboxId === head.sandboxId) {
    throw new PrProofContractError('Base and head proofs did not run in distinct sandboxes', [
      `both evidence files report sandbox ${base.sandboxId}`,
    ]);
  }
  return { input, base, head };
}

export async function verifyCloudEvidence({ inputPath, arm, env = process.env, fetchImpl = fetch }) {
  const input = validateProofInput(await readJson(inputPath));
  const base = await downloadCloudEvidence(input, 'base', { env, fetchImpl });
  const head = arm === 'base' ? null : await downloadCloudEvidence(input, 'head', { env, fetchImpl });
  return verifyEvidenceRecords({ input, arm, base, head });
}

async function main() {
  const arm = option('--arm', 'both');
  if (arm !== 'base' && arm !== 'both') throw new Error('--arm must be base or both');
  const inputPath = option('--input', process.env.RELAY_PR_PROOF_INPUT ?? INPUT_PATH);
  const artifactRoot = option('--artifacts', ARTIFACT_ROOT);
  const source = option('--source', 'files');
  if (source !== 'files' && source !== 'cloud') throw new Error('--source must be files or cloud');
  const { input, base, head } =
    source === 'cloud'
      ? await verifyCloudEvidence({ inputPath, arm })
      : await verifyEvidenceFiles({ inputPath, arm, artifactRoot });
  console.log(`PR_PROOF_BASE_VALID case=${input.caseId} outcome=${base.outcome} sandbox=${base.sandboxId}`);
  if (!head) return;

  const verdict = {
    version: PR_PROOF_VERSION,
    verdict: 'PASS',
    caseId: input.caseId,
    pullRequest: input.pullRequest,
    base: {
      sha: base.targetSha,
      outcome: base.outcome,
      signature: base.signature,
      sandboxId: base.sandboxId,
    },
    head: {
      sha: head.targetSha,
      outcome: head.outcome,
      signature: head.signature,
      sandboxId: head.sandboxId,
    },
    completedAt: new Date().toISOString(),
  };
  await mkdir(artifactRoot, { recursive: true });
  // artifactRoot is trusted workflow configuration; all Cloud-derived verdict
  // fields passed the exact nonce/SHA/signature/sandbox evidence contract.
  // codeql[js/http-to-file-access]
  await writeFile(path.join(artifactRoot, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(
    `PR_PROOF_PASS case=${input.caseId} base_sandbox=${base.sandboxId} head_sandbox=${head.sandboxId}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    if (error instanceof PrProofContractError) {
      for (const detail of error.details) console.error(`- ${detail}`);
    }
    process.exitCode = 1;
  });
}
