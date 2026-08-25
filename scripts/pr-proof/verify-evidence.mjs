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

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function verifyEvidenceFiles({ inputPath, arm, artifactRoot = ARTIFACT_ROOT }) {
  const input = validateProofInput(await readJson(inputPath));
  const base = validateEvidence(await readJson(path.join(artifactRoot, 'base.json')), input, 'base');
  if (arm === 'base') return { input, base, head: null };

  const head = validateEvidence(await readJson(path.join(artifactRoot, 'head.json')), input, 'head');
  if (base.sandboxId === head.sandboxId) {
    throw new PrProofContractError('Base and head proofs did not run in distinct sandboxes', [
      `both evidence files report sandbox ${base.sandboxId}`,
    ]);
  }
  return { input, base, head };
}

async function main() {
  const arm = option('--arm', 'both');
  if (arm !== 'base' && arm !== 'both') throw new Error('--arm must be base or both');
  const inputPath = option('--input', process.env.RELAY_PR_PROOF_INPUT ?? INPUT_PATH);
  const artifactRoot = option('--artifacts', ARTIFACT_ROOT);
  const { input, base, head } = await verifyEvidenceFiles({ inputPath, arm, artifactRoot });
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
