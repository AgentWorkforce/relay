import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildQualificationCommands,
  QualificationBlockedError,
  resolveQualificationInputs,
  shellInertLiteral,
  writeQualificationParams,
} from '../../scripts/fleet-qualification/preflight.mjs';

const HEAD = 'a'.repeat(40);

let sandbox: string;
let markers: string[];

/**
 * Operator-supplied paths whose *names* carry shell payloads. These are real
 * files on disk, so they survive existence validation and reach every place the
 * Relayflow uses them — which is exactly where a quoting bug would fire.
 */
function maliciousInputs() {
  // Payload targets are bare names so they stay inside a single path segment;
  // the sandbox is the cwd for every shell invocation under test.
  const names = ['pwned-evidence', 'pwned-artifact', 'pwned-manifest'];
  markers = names.map((name) => path.join(sandbox, name));

  const files = {
    rawEvidence: path.join(sandbox, `evidence$(touch ${names[0]}).json`),
    candidateArtifact: path.join(sandbox, `artifact\`touch ${names[1]}\`.tgz`),
    candidateManifest: path.join(sandbox, `manifest';touch ${names[2]};'.json`),
  };
  for (const file of Object.values(files)) writeFileSync(file, '{}\n');
  return { files };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'fleet-qual-inject-'));
  markers = [];
});

afterEach(() => {
  for (const marker of markers) rmSync(marker, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
});

describe('fleet qualification shell injection', () => {
  it('keeps every operator-supplied value out of the deterministic commands', () => {
    const { files } = maliciousInputs();
    const inputs = resolveQualificationInputs({
      FLEET_QUALIFICATION_RUN_ID: 'inject-probe',
      FLEET_QUALIFICATION_RAW_EVIDENCE: files.rawEvidence,
      FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: files.candidateArtifact,
      FLEET_QUALIFICATION_CANDIDATE_MANIFEST: files.candidateManifest,
      FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
    });

    const rendered = Object.values(buildQualificationCommands(inputs)).join('\n');
    for (const value of Object.values(files)) {
      expect(rendered).not.toContain(value);
    }
    expect(rendered).not.toContain('touch ');

    // The commands must depend only on the charset-restricted run id, so
    // swapping the operator inputs for benign ones changes nothing.
    const benign = path.join(sandbox, 'benign.json');
    writeFileSync(benign, '{}\n');
    const benignInputs = resolveQualificationInputs({
      FLEET_QUALIFICATION_RUN_ID: 'inject-probe',
      FLEET_QUALIFICATION_RAW_EVIDENCE: benign,
      FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: benign,
      FLEET_QUALIFICATION_CANDIDATE_MANIFEST: benign,
      FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
    });
    expect(rendered).toBe(Object.values(buildQualificationCommands(benignInputs)).join('\n'));
  });

  it('does not execute a $(...), backtick or quote-break payload from the evidence paths', () => {
    const { files } = maliciousInputs();
    const inputs = resolveQualificationInputs({
      FLEET_QUALIFICATION_RUN_ID: 'inject-probe',
      FLEET_QUALIFICATION_RAW_EVIDENCE: files.rawEvidence,
      FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: files.candidateArtifact,
      FLEET_QUALIFICATION_CANDIDATE_MANIFEST: files.candidateManifest,
      FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
    });
    writeQualificationParams(inputs, { cwd: sandbox });

    for (const command of Object.values(buildQualificationCommands(inputs))) {
      try {
        execFileSync('/bin/sh', ['-c', command], { cwd: sandbox, stdio: 'pipe' });
      } catch {
        // A blocked/failing step is expected here; only the side effect matters.
      }
    }

    for (const marker of markers) {
      expect(existsSync(marker), `payload executed and created ${marker}`).toBe(false);
    }
  });

  it('round-trips the exact operator paths through the params file', () => {
    const { files } = maliciousInputs();
    const inputs = resolveQualificationInputs({
      FLEET_QUALIFICATION_RUN_ID: 'inject-probe',
      FLEET_QUALIFICATION_RAW_EVIDENCE: files.rawEvidence,
      FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: files.candidateArtifact,
      FLEET_QUALIFICATION_CANDIDATE_MANIFEST: files.candidateManifest,
      FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
    });
    const paramsPath = writeQualificationParams(inputs, { cwd: sandbox });
    const params = JSON.parse(readFileSync(paramsPath, 'utf8'));

    expect(params.rawEvidence).toBe(files.rawEvidence);
    expect(params.candidateArtifact).toBe(files.candidateArtifact);
    expect(params.candidateManifest).toBe(files.candidateManifest);
    expect(params.expectedHead).toBe(HEAD);
  });

  it('rejects a shell-active literal rather than escaping it', () => {
    for (const value of [
      'a$(touch x)',
      'a`touch x`',
      "a';touch x;'",
      'a;touch x',
      'a touch x',
      'a\ntouch x',
      'a|touch x',
      'a&touch x',
      'a>x',
      'a\\x',
      'a*x',
      'a~x',
      '',
    ]) {
      expect(() => shellInertLiteral(value, 'probe')).toThrow(QualificationBlockedError);
    }
    expect(shellInertLiteral('.workflow-artifacts/fleet-qualification/run-1/params.json', 'probe')).toBe(
      '.workflow-artifacts/fleet-qualification/run-1/params.json'
    );
  });

  it('blocks a run id that could escape the artifacts path', () => {
    const { files } = maliciousInputs();
    for (const runId of ['../../etc', 'run$(touch x)', 'run id', '-run', 'a'.repeat(129)]) {
      expect(() =>
        resolveQualificationInputs({
          FLEET_QUALIFICATION_RUN_ID: runId,
          FLEET_QUALIFICATION_RAW_EVIDENCE: files.rawEvidence,
          FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: files.candidateArtifact,
          FLEET_QUALIFICATION_CANDIDATE_MANIFEST: files.candidateManifest,
          FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
        })
      ).toThrow(QualificationBlockedError);
    }
  });

  it('blocks absent evidence, artifact, manifest and malformed heads', () => {
    const { files } = maliciousInputs();
    const base = {
      FLEET_QUALIFICATION_RUN_ID: 'inject-probe',
      FLEET_QUALIFICATION_RAW_EVIDENCE: files.rawEvidence,
      FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: files.candidateArtifact,
      FLEET_QUALIFICATION_CANDIDATE_MANIFEST: files.candidateManifest,
      FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
    };
    const absent = path.join(sandbox, 'missing');
    for (const override of [
      { FLEET_QUALIFICATION_RAW_EVIDENCE: '' },
      { FLEET_QUALIFICATION_RAW_EVIDENCE: absent },
      { FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: absent },
      { FLEET_QUALIFICATION_CANDIDATE_MANIFEST: absent },
      { FLEET_QUALIFICATION_EXPECTED_HEAD: 'not-a-sha' },
      { FLEET_QUALIFICATION_EXPECTED_HEAD: `${'a'.repeat(39)}g` },
    ]) {
      expect(() => resolveQualificationInputs({ ...base, ...override })).toThrow(QualificationBlockedError);
    }
  });
});
