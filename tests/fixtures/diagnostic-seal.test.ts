import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  diagnosisSealPayload,
  runDiagnosticCommand,
  validateDiagnosisSeal,
  validateFinalDiagnosisReview,
} from '../../scripts/verify-features/relay-orchestration-diagnostic-gates.mjs';

const sealFiles = [
  'context.json',
  'relay-boundary.md',
  'cloud-boundary.md',
  'relayfile-boundary.md',
  'relayfile-cloud-boundary.md',
  'static-gates.json',
  'bug-ledger.json',
  'coverage-contract.json',
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-seal-test-'));
  temporaryDirectories.push(directory);
  await Promise.all(
    sealFiles.map((file, index) => writeFile(path.join(directory, file), `fixture-${index}\n`))
  );
  const payload = await diagnosisSealPayload(directory);
  await writeFile(
    path.join(directory, 'diagnosis-seal.json'),
    JSON.stringify({ ...payload, runId: 'fixture', createdAt: new Date().toISOString() })
  );
  return { directory, payload };
}

describe('diagnosis artifact sealing', () => {
  it('records byte counts and fails closed when command evidence is truncated', async () => {
    const result = await runDiagnosticCommand(
      process.execPath,
      ['-e', "process.stdout.write('a'.repeat(1024)); process.stderr.write('b'.repeat(513))"],
      { maxOutputBytes: 128, timeoutMs: 10_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(1024);
    expect(result.stderrBytes).toBe(513);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdout).toContain('[TRUNCATED]');
    expect(result.stderr).toContain('[TRUNCATED]');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128);
  });

  it('rejects any sealed artifact mutation', async () => {
    const { directory, payload } = await fixture();
    expect((await validateDiagnosisSeal(directory)).artifactSetSha256).toBe(payload.artifactSetSha256);

    await writeFile(path.join(directory, 'bug-ledger.json'), 'changed\n');
    await expect(validateDiagnosisSeal(directory)).rejects.toThrow(/does not match/);
  });

  it('seals generated reproduction dependencies, not only the fixed core file list', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-seal-dependency-test-'));
    temporaryDirectories.push(directory);
    await Promise.all(
      sealFiles.map((file, index) => writeFile(path.join(directory, file), `fixture-${index}\n`))
    );
    await writeFile(path.join(directory, 'reproduce.mjs'), 'export const expected = true;\n');
    const payload = await diagnosisSealPayload(directory);
    expect(payload.files.map(({ name }) => name)).toContain('reproduce.mjs');
    await writeFile(
      path.join(directory, 'diagnosis-seal.json'),
      JSON.stringify({ ...payload, runId: 'fixture', createdAt: new Date().toISOString() })
    );
    await writeFile(path.join(directory, 'reproduce.mjs'), 'export const expected = false;\n');
    await expect(validateDiagnosisSeal(directory)).rejects.toThrow(/does not match/);
  });

  it('accepts final review only when it signs the exact seal with zero findings', async () => {
    const { directory, payload } = await fixture();
    const reviewFile = 'diagnosis-final-codex.json';
    const review: {
      version: number;
      kind: string;
      role: string;
      artifactSetSha256: string;
      verdict: string;
      evidenceIntegrity: string;
      coverageAssessment: string;
      remainingProductRisk: string;
      findings: Array<{ id: string }>;
    } = {
      version: 1,
      kind: 'diagnosis-final-review',
      role: 'fresh-codex-signoff',
      artifactSetSha256: payload.artifactSetSha256,
      verdict: 'pass',
      evidenceIntegrity: 'The files and deterministic evidence are internally consistent.',
      coverageAssessment: 'Every required diagnosis category remains represented.',
      remainingProductRisk: 'Product RED findings remain release blocking.',
      findings: [],
    };
    await writeFile(path.join(directory, reviewFile), JSON.stringify(review));
    const seal = await validateDiagnosisSeal(directory);
    expect(await validateFinalDiagnosisReview(directory, reviewFile, review.role, seal)).toEqual(review);

    review.findings.push({ id: 'open' });
    review.verdict = 'findings';
    await writeFile(path.join(directory, reviewFile), JSON.stringify(review));
    await expect(validateFinalDiagnosisReview(directory, reviewFile, review.role, seal)).rejects.toThrow(
      /finding-free/
    );
  });
});
