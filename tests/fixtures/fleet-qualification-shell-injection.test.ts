import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { argument, readQualificationParams } from '../../scripts/fleet-qualification/params.mjs';
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

/**
 * The params file is the one thing this run writes before the workflow starts,
 * and its path is derived from the run id — which the operator also supplies.
 * These cover the ways a hostile or careless setup can aim that write at
 * something it must not touch.
 */
describe('fleet qualification params write is not a destructive primitive', () => {
  const RUN_ID = 'inject-probe';
  const ARTIFACT_ROOT = `.workflow-artifacts/fleet-qualification/${RUN_ID}`;

  function envFor(overrides: Record<string, string>) {
    const { files } = maliciousInputs();
    return {
      FLEET_QUALIFICATION_RUN_ID: RUN_ID,
      FLEET_QUALIFICATION_RAW_EVIDENCE: files.rawEvidence,
      FLEET_QUALIFICATION_CANDIDATE_ARTIFACT: files.candidateArtifact,
      FLEET_QUALIFICATION_CANDIDATE_MANIFEST: files.candidateManifest,
      FLEET_QUALIFICATION_EXPECTED_HEAD: HEAD,
      ...overrides,
    };
  }

  function resolveInSandbox(overrides: Record<string, string> = {}) {
    return resolveQualificationInputs(envFor(overrides), { cwd: sandbox });
  }

  it('blocks an input that is a directory rather than a regular file', () => {
    const directory = path.join(sandbox, 'evidence-dir');
    mkdirSync(directory);
    for (const key of [
      'FLEET_QUALIFICATION_RAW_EVIDENCE',
      'FLEET_QUALIFICATION_CANDIDATE_ARTIFACT',
      'FLEET_QUALIFICATION_CANDIDATE_MANIFEST',
    ]) {
      expect(() => resolveInSandbox({ [key]: directory })).toThrow(QualificationBlockedError);
    }
  });

  it('blocks an input that is a FIFO instead of blocking the run on it', () => {
    const fifo = path.join(sandbox, 'evidence-fifo');
    execFileSync('mkfifo', [fifo]);
    expect(() => resolveInSandbox({ FLEET_QUALIFICATION_RAW_EVIDENCE: fifo })).toThrow(
      QualificationBlockedError
    );
  });

  it('blocks an input path that aliases the params or verdict file', () => {
    for (const name of ['params.json', 'verdict.json']) {
      const alias = path.join(sandbox, ARTIFACT_ROOT, name);
      mkdirSync(path.dirname(alias), { recursive: true });
      writeFileSync(alias, 'OPERATOR EVIDENCE\n');
      expect(() => resolveInSandbox({ FLEET_QUALIFICATION_RAW_EVIDENCE: alias })).toThrow(
        QualificationBlockedError
      );
      // The caller's own file is still intact — nothing truncated it.
      expect(readFileSync(alias, 'utf8')).toBe('OPERATOR EVIDENCE\n');
      rmSync(alias);
    }
  });

  it('does not follow a symlink planted at the params path', () => {
    const victim = path.join(sandbox, 'victim.json');
    writeFileSync(victim, 'DO NOT OVERWRITE\n');
    const paramsPath = path.join(sandbox, ARTIFACT_ROOT, 'params.json');
    mkdirSync(path.dirname(paramsPath), { recursive: true });
    symlinkSync(victim, paramsPath);

    const inputs = resolveInSandbox();
    expect(() => writeQualificationParams(inputs, { cwd: sandbox })).toThrow(QualificationBlockedError);
    expect(readFileSync(victim, 'utf8')).toBe('DO NOT OVERWRITE\n');
  });

  it('does not follow a symlinked artifact root', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'fleet-qual-victim-'));
    const root = path.join(sandbox, ARTIFACT_ROOT);
    mkdirSync(path.dirname(root), { recursive: true });
    symlinkSync(elsewhere, root);

    const inputs = resolveInSandbox();
    expect(() => writeQualificationParams(inputs, { cwd: sandbox })).toThrow(QualificationBlockedError);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('resolves a symlinked input to its target before accepting it', () => {
    // `path.resolve` alone would compare the link's own name and let this pass.
    for (const name of ['params.json', 'verdict.json']) {
      const output = path.join(sandbox, ARTIFACT_ROOT, name);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, 'OPERATOR EVIDENCE\n');
      const link = path.join(sandbox, `link-to-${name}`);
      symlinkSync(output, link);

      expect(() => resolveInSandbox({ FLEET_QUALIFICATION_RAW_EVIDENCE: link })).toThrow(
        QualificationBlockedError
      );
      expect(readFileSync(output, 'utf8')).toBe('OPERATOR EVIDENCE\n');
      rmSync(link);
      rmSync(output);
    }
  });

  it('blocks an input the run cannot read', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits.
    const unreadable = path.join(sandbox, 'unreadable.json');
    writeFileSync(unreadable, '{}\n');
    chmodSync(unreadable, 0o000);
    try {
      expect(() => resolveInSandbox({ FLEET_QUALIFICATION_RAW_EVIDENCE: unreadable })).toThrow(
        QualificationBlockedError
      );
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });

  it('does not follow a symlink planted on a shared parent directory', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'fleet-qual-victim-'));
    const parent = path.join(sandbox, '.workflow-artifacts', 'fleet-qualification');
    mkdirSync(path.dirname(parent), { recursive: true });
    symlinkSync(elsewhere, parent);

    const inputs = resolveInSandbox();
    expect(() => writeQualificationParams(inputs, { cwd: sandbox })).toThrow(QualificationBlockedError);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('blocks a stale artifact root that holds a verdict but no params', () => {
    // The params write would have succeeded here; the run would only have
    // failed later, on verify-evidence.mjs's own exclusive verdict write.
    const root = path.join(sandbox, ARTIFACT_ROOT);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'verdict.json'), '{"verdict":"PASS"}\n');

    const inputs = resolveInSandbox();
    expect(() => writeQualificationParams(inputs, { cwd: sandbox })).toThrow(QualificationBlockedError);
    expect(existsSync(path.join(root, 'params.json'))).toBe(false);
  });

  it('blocks a reused run id rather than overwriting its params file', () => {
    const inputs = resolveInSandbox();
    writeQualificationParams(inputs, { cwd: sandbox });
    expect(() => writeQualificationParams(inputs, { cwd: sandbox })).toThrow(QualificationBlockedError);
  });
});

describe('fleet qualification argv parsing', () => {
  it("does not accept a known flag as another flag's value", () => {
    const argv = ['node', 'verify-evidence.mjs', '--input', '--expected-head', 'a'.repeat(40)];
    expect(argument(argv, '--input')).toBeUndefined();
    expect(argument(argv, '--expected-head')).toBe('a'.repeat(40));
  });

  it('does not read past the end of the command line', () => {
    expect(argument(['node', 'verify-evidence.mjs', '--params'], '--params')).toBeUndefined();
  });

  it('rejects a present-but-valueless --params instead of falling back', () => {
    // Returning undefined here would let verify-evidence.mjs silently verify
    // the direct --input/--output flags instead of the params file it was told
    // to use.
    expect(() =>
      readQualificationParams(['node', 'verify-evidence.mjs', '--params', '--input', 'e.json'])
    ).toThrow(/--params requires a file path/);
    expect(() => readQualificationParams(['node', 'verify-evidence.mjs', '--params'])).toThrow(
      /--params requires a file path/
    );
  });

  it('leaves a genuinely absent --params as a direct invocation', () => {
    expect(readQualificationParams(['node', 'verify-evidence.mjs', '--input', 'e.json'])).toBeUndefined();
  });

  it('still reads a well-formed value', () => {
    expect(argument(['node', 'x.mjs', '--params', 'a/params.json'], '--params')).toBe('a/params.json');
  });
});
