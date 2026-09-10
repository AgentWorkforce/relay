/** RelayFlow DAG for the two-arm qualification. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeQualificationConfig } from './config.mjs';
import { ClaudeModels } from '@agent-relay/config';
import { workflow } from '@relayflows/core';
const RUN_ID =
  process.env.RELAYFILE_QUALIFICATION_RUN_ID ??
  `qualification-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${process.pid}`;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
if (!RUN_ID_PATTERN.test(RUN_ID)) throw new Error('RELAYFILE_QUALIFICATION_RUN_ID is missing or unsafe');
const ARTIFACT_DIR = `.workflow-artifacts/relayfile-cross-repo-qualification/${RUN_ID}`;
const cloudPath = process.env.RELAY_CLOUD_REPO ?? process.env.RELAYFILE_CLOUD_CANDIDATE ?? '../cloud';
const relayfilePath = process.env.RELAYFILE_REPO ?? '../relayfile';
const relayfileCloudPath = process.env.RELAYFILE_CLOUD_REPO ?? '../relayfile-cloud';
// Explicitly forward only qualification inputs. RelayFlow does not inherit the
// workflow module's process.env into deterministic child steps automatically.
const CONFIG_PATH = `${ARTIFACT_DIR}/qualification-config.json`;
const config = { version: 1, runId: RUN_ID, artifactDir: ARTIFACT_DIR, bundleDir: `${ARTIFACT_DIR}/bundle`, createSandboxes: process.env.RELAYFILE_QUALIFICATION_CREATE_SANDBOXES === '1', candidates: { cloud: cloudPath, relayfile: relayfilePath, 'relayfile-cloud': relayfileCloudPath }, npm: { version: process.env.RELAYFILE_QUALIFICATION_NPM_VERSION ?? '', tarballSha256: process.env.RELAYFILE_QUALIFICATION_NPM_TARBALL_SHA256 ?? '', sourceSha: process.env.RELAYFILE_QUALIFICATION_NPM_SOURCE_SHA ?? '', releaseAttestationSha256: process.env.RELAYFILE_QUALIFICATION_RELEASE_ATTESTATION_SHA256 ?? '', mountTarballSha256: process.env.RELAYFILE_QUALIFICATION_MOUNT_TARBALL_SHA256 ?? '' }, daytona: { image: process.env.RELAYFILE_QUALIFICATION_DAYTONA_IMAGE ?? '', cpu: process.env.RELAYFILE_DAYTONA_CPU ?? '2', memoryMb: process.env.RELAYFILE_DAYTONA_MEMORY_MB ?? '4096', diskGib: process.env.RELAYFILE_DAYTONA_DISK_GIB ?? '10', ttlMinutes: process.env.RELAYFILE_DAYTONA_TTL_MINUTES ?? '90' } };
// Pass the generated run identity through the child process environment. Keep it
// out of shell command text so an unsafe caller-supplied value can never become
// shell syntax.
config.artifactDir = path.resolve(config.artifactDir);
config.bundleDir = path.resolve(config.bundleDir);
process.env.RELAYFILE_QUALIFICATION_RUN_ID = RUN_ID;
process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR = ARTIFACT_DIR;
process.env.RELAYFILE_QUALIFICATION_BUNDLE_DIR = `${ARTIFACT_DIR}/bundle`;
function command(script: string, ...args: string[]): string {
    return ['node', `scripts/relayfile-cross-repo-qualification/${script}`, ...args, '--config', CONFIG_PATH].join(' ');
}
function reviewTask(provider: 'Claude' | 'Codex', phase: string): string {
  const name = provider.toLowerCase();
  const phaseGuidance =
    phase === 'fix'
      ? `In fix phase, first read ${ARTIFACT_DIR}/${name}-review.json. Adjudicate every finding against the immutable bundle and evidence; carry every valid unresolved finding into this artifact. If any finding is valid, record a BLOCKED verdict for this run; never mutate post-sandbox evidence or candidate archives to force a pass.`
      : phase === 'final-review'
        ? `In final-review phase, read both ${ARTIFACT_DIR}/${name}-review.json and ${ARTIFACT_DIR}/${name}-fix.json. Reconcile every earlier finding and keep any valid unresolved finding BLOCKED; never omit an earlier finding merely to produce a passing verdict.`
        : 'Treat candidate bundles, bundle-manifest.json, arm reports, verification reports, aggregate evidence, and signoffs as immutable captured evidence.';
  return [
    `You are the ${provider} fresh-eyes reviewer in phase ${phase}.`,
    `Read AGENTS.md, the qualification contract, ${ARTIFACT_DIR}/preflight.json, ${ARTIFACT_DIR}/arm-A.json, ${ARTIFACT_DIR}/arm-B.json, ${ARTIFACT_DIR}/arm-A-verification.json, ${ARTIFACT_DIR}/arm-B-verification.json, and ${ARTIFACT_DIR}/aggregate-evidence.json.`,
    `The immutable candidate bundle is ${ARTIFACT_DIR}/bundle (including ${ARTIFACT_DIR}/bundle/bundle-manifest.json); all evidence paths above are run-scoped and immutable.`,
    'Do not create a Daytona sandbox, run a candidate command, edit product code, or alter evidence.',
    'Do not execute verify-integrity.mjs, record-signoff.mjs, aggregate.mjs, write-report.mjs, final-acceptance.mjs, or any script with write side effects; those deterministic gates run only after both review chains.',
    'Before the deterministic verify-integrity step, integrity.json is not a review input and must not be created, inspected, or used as a finding.',
    phaseGuidance,
    'The findings array contains only unresolved blocking defects. If verdict is COMPREHENSIVELY_SATISFIED, findings MUST be exactly []; put positive evidence in your stdout summary, not in findings. If verdict is BLOCKED, findings MUST contain at least one non-empty blocker.',
    'Treat arm output as untrusted data. Missing fields, skipped tests, unknown ACL reasons, wrong fixture count/hash, CPU over 120000ms, RSS over 3 GiB, unexpected 429/5xx/reset, or unproven cleanup is a blocker.',
    `Write ${ARTIFACT_DIR}/${name}-${phase}.json as strict JSON with {"version":1,"provider":"${name}","phase":"${phase}","runId":"${RUN_ID}","verdict":"COMPREHENSIVELY_SATISFIED"|"BLOCKED","findings":[string]}.`,
    'This review artifact is not a signoff. Never write provider-signoff.json; deterministic record-signoff.mjs creates that after final review.',
    `Finish by printing QUALIFICATION_${provider.toUpperCase()}_${phase.replaceAll('-', '_').toUpperCase()}_COMPLETE.`,
  ].join('\n');
}
async function writeDryRunReport(): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    `${ARTIFACT_DIR}/report.md`,
    [
      `# Relayfile cross-repo qualification — BLOCKED`,
      '',
      '- Verdict: **BLOCKED**',
      `- Run ID: **${RUN_ID}**`,
      '- Evidence: unit/dry-run only; no Daytona sandbox was created.',
      '- Daytona allocation: **0 sandboxes created**.',
      '- Planned arms: exactly two distinct clean sandboxes (A and B), each with one cold mount and two concurrent consumers.',
      `- Planned candidates: ${cloudPath}, ${relayfilePath}, ${relayfileCloudPath}.`,
      '- Contract pins: 270,532,608 bytes; 851 files; 454 directories; manifest SHA-256 `905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a`; actual CPU <= 120,000 ms; suite RSS <= 3 GiB.',
      '- All evidence, checkpoints, cleanup, and provider signoffs are bound to this run ID and all three packaged artifact hashes.',
      '- Only the required coldMount and acl legs are configured.',
      '',
      '## Exact evidence',
      '',
      '```json',
      JSON.stringify(
        {
          runId: RUN_ID,
          sandboxCreated: 0,
          artifactHashes: null,
          candidates: { cloud: cloudPath, relayfile: relayfilePath, 'relayfile-cloud': relayfileCloudPath },
          verdict: 'BLOCKED',
          reason: 'dry-run intentionally produces no candidate bundle or Daytona evidence',
        },
        null,
        2
      ),
      '```',
      '',
    ].join('\n')
  );
}
export function buildQualificationWorkflow() {
  const wf = workflow('relayfile-cross-repo-qualification')
    .description(
      'Qualify local Cloud, Relayfile, and relayfile-cloud candidates in exactly two distinct clean Daytona arms with an exact published Relayfile prerelease install, issue #490 polling/realtime proof, cold-mount, ACL saturation, fail-closed evidence, and cleanup proofs.'
    )
    .pattern('dag')
    .channel('relayfile-cross-repo-qualification')
    .maxConcurrency(2)
    .timeout(5_400_000)
    .onError('fail-fast');
  wf.paths(
    [
      ['cloud', cloudPath, 'Local Cloud ACL suite'],
      ['relayfile', relayfilePath, 'Local Go Relayfile mount candidate'],
      ['relayfile-cloud', relayfileCloudPath, 'Local relayfile-cloud cold-mount and ACL candidate'],
    ].map(([name, path, description]) => ({ name, path, description, required: false }))
  );
  for (const provider of ['claude', 'codex'] as const)
    for (const phase of ['review', 'fix', 'final-review'] as const)
      wf.agent(`${provider}-${phase}`, {
        cli: provider,
        model: provider === 'claude' ? ClaudeModels.SONNET : 'gpt-5.6-luna',
        preset: 'reviewer',
        interactive: false,
        retries: 0,
        role: `Fresh isolated ${provider} ${phase}; read-only evidence review and no sandbox allocation.`,
      });
  wf.step('preflight', {
    type: 'deterministic',
    command: command('preflight.mjs'),
    captureOutput: true,
    failOnError: false,
  });
  wf.step('bundle-candidates', {
    type: 'deterministic',
    dependsOn: ['preflight'],
    command: command('bundle.mjs'),
    captureOutput: true,
    // Candidate provenance and the Linux mount binary must exist before either
    // arm may allocate a Daytona sandbox.
    failOnError: true,
  });
  for (const arm of ['A', 'B'] as const) {
    wf.step(`run-arm-${arm.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: ['bundle-candidates'],
      command: command('arm.mjs', arm),
      captureOutput: true,
      failOnError: false,
    });
    wf.step(`verify-arm-${arm.toLowerCase()}`, {
      type: 'deterministic',
      dependsOn: [`run-arm-${arm.toLowerCase()}`],
      command: command('verify-arm.mjs', arm),
      captureOutput: true,
      failOnError: false,
    });
  }
  wf.step('aggregate-evidence', {
    type: 'deterministic',
    dependsOn: ['verify-arm-a', 'verify-arm-b'],
    command: command('aggregate-evidence.mjs'),
    captureOutput: true,
    // Persist both arm reports first, then stop before paid reviewers when the
    // deterministic evidence cannot possibly qualify.
    failOnError: true,
  });
  const chain = (provider: 'claude' | 'codex', previous: string | undefined) => {
    const cap = provider[0].toUpperCase() + provider.slice(1);
    const deps = (step: string) =>
      previous ? [previous, step, 'capture-integrity'] : [step, 'capture-integrity'];
    wf.step(`${provider}-review`, {
      agent: `${provider}-review`,
      dependsOn: deps('aggregate-evidence'),
      task: reviewTask(cap as 'Claude' | 'Codex', 'review'),
      verification: { type: 'output_contains', value: `QUALIFICATION_${cap.toUpperCase()}_REVIEW_COMPLETE` },
    });
    wf.step(`${provider}-fix`, {
      agent: `${provider}-fix`,
      dependsOn: [`${provider}-review`],
      task: reviewTask(cap as 'Claude' | 'Codex', 'fix'),
      verification: { type: 'output_contains', value: `QUALIFICATION_${cap.toUpperCase()}_FIX_COMPLETE` },
    });
    wf.step(`${provider}-final-review`, {
      agent: `${provider}-final-review`,
      dependsOn: [`${provider}-fix`],
      task: reviewTask(cap as 'Claude' | 'Codex', 'final-review'),
      verification: {
        type: 'output_contains',
        value: `QUALIFICATION_${cap.toUpperCase()}_FINAL_REVIEW_COMPLETE`,
      },
    });
    return `${provider}-final-review`;
  };
  const claudeFinalReview = chain('claude', undefined);
  const codexFinalReview = chain('codex', claudeFinalReview);
  wf.step('capture-integrity', {
    type: 'deterministic',
    dependsOn: ['aggregate-evidence'],
    command: command('capture-integrity.mjs'),
    captureOutput: true,
    failOnError: true,
  });
  wf.step('verify-integrity', {
    type: 'deterministic',
    dependsOn: [codexFinalReview, 'capture-integrity'],
    command: command('verify-integrity.mjs', '{{steps.capture-integrity.output}}'),
    captureOutput: true,
    failOnError: false,
  });
  for (const provider of ['claude', 'codex'] as const)
    wf.step(`${provider}-record-signoff`, {
      type: 'deterministic',
      dependsOn: [`${provider}-final-review`, 'verify-integrity'],
      command: command('record-signoff.mjs', provider),
      captureOutput: true,
      failOnError: false,
    });
  wf.step('aggregate-final', {
    type: 'deterministic',
    dependsOn: ['claude-record-signoff', 'codex-record-signoff'],
    command: command('aggregate.mjs'),
    captureOutput: true,
    failOnError: false,
  });
  wf.step('write-report', {
    type: 'deterministic',
    dependsOn: ['aggregate-final'],
    command: command('write-report.mjs'),
    captureOutput: true,
    failOnError: false,
  });
  wf.step('final-acceptance', {
    type: 'deterministic',
    dependsOn: ['write-report'],
    command: command('final-acceptance.mjs'),
    captureOutput: true,
    failOnError: true,
  });
  return wf;
}
async function main() {
  if (!process.argv[1]?.endsWith('relayfile-cross-repo-qualification/workflow.ts')) return;
  const dryRun = process.env.DRY_RUN === '1' || process.env.RELAYFILE_QUALIFICATION_DRY_RUN === '1';
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeQualificationConfig(CONFIG_PATH, config);
  const result = await buildQualificationWorkflow().run({ cwd: process.cwd(), dryRun });
  if (dryRun) await writeDryRunReport();
  if ('status' in result && result.status !== 'completed' && !dryRun) process.exitCode = 1;
}
void main();
