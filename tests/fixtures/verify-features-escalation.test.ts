import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  escalationAuditFailures,
  escalationChannelAuditFailure,
  redactAlertText,
  resetEscalationArtifacts,
  renderFinalEscalationStatus,
  renderInitialEscalationStatus,
  writeAlertEnvelope,
  writeEscalationStatus,
} from '../../scripts/verify-features/escalation-status.mjs';
import {
  markRunArtifactsComplete,
  prepareRunArtifacts,
  pruneRunArtifacts,
} from '../../scripts/verify-features/run-artifacts.mjs';
import { prepareRunWorktree, removeRunWorktree } from '../../scripts/verify-features/run-worktree.mjs';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const workflowPath = fileURLToPath(new URL('../../workflows/verify-features.ts', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowSourcePromise = readFile(workflowPath, 'utf8');
const slackAlertPath = fileURLToPath(
  new URL('../../scripts/verify-features/slack-alert.sh', import.meta.url)
);
const slackAlertSourcePromise = readFile(slackAlertPath, 'utf8');
const infraEscalationPath = fileURLToPath(
  new URL('../../scripts/verify-features/escalate-infra.sh', import.meta.url)
);
const infraEscalationSourcePromise = readFile(infraEscalationPath, 'utf8');

function workflowStep(source: string, name: string): string {
  const start = source.indexOf(`wf.step('${name}', {`);
  if (start === -1) throw new Error(`workflow step not found: ${name}`);
  const next = source.indexOf("\n  wf.step('", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function plannedWave(plan: string, step: string): number {
  let currentWave = 0;
  for (const line of plan.split('\n')) {
    const wave = /^\s*Wave\s+(\d+):/.exec(line);
    if (wave) currentWave = Number(wave[1]);
    if (line.includes(`${step} (`)) return currentWave;
  }
  throw new Error(`planned workflow step not found: ${step}`);
}

async function artifacts() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verify-features-escalation-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('verify-features escalation status', () => {
  it('bounds capability probes and fails closed on invalid provenance', async () => {
    const source = await workflowSourcePromise;
    const capabilities = workflowStep(source, 'capabilities');
    expect(capabilities).toMatch(/timeout:\s*10_000|timeout:\s*10000/);
    expect(capabilities).toContain('detached: process.platform !== "win32"');
    expect(capabilities).toContain('process.kill(-result.pid, "SIGKILL")');
    expect(capabilities).toContain('ARTIFACTS="${ARTIFACTS}"');
    expect(capabilities).toContain("if ! grep -q '^VERIFY_PROVENANCE_VALID=1$'");
    expect(source).toContain('abort_for_invalid_provenance');
    expect(source).toContain("if ! grep -q '^VERIFY_PROVENANCE_VALID=1$'");
    expect(source).toContain('verdict.runId !== RUN_ID');
  });

  it('audits every mandatory escalation independently of the workflow DAG', async () => {
    const source = await workflowSourcePromise;
    const followup = workflowStep(source, 'slack-followup');

    expect(workflowStep(source, 'enforce-escalations')).toContain(
      'node "$STATUS_TOOL" audit "$ARTIFACTS" "$AUTOFIX"'
    );
    expect(source).toMatch(/step:\s*['"]enforce-slack-primary-delivery['"]/);
    expect(source).toMatch(/step:\s*['"]enforce-infra-delivery['"]/);
    expect(source).toMatch(/step:\s*['"]enforce-github-issue-delivery['"]/);
    expect(source).toMatch(/step:\s*['"]enforce-draft-pr-delivery['"]/);
    expect(followup).toMatch(/dependsOn:\s*\[\s*['"]open-pr['"]\s*,\s*['"]slack-alert['"]\s*\]/);
    expect(source).toContain('failure-assessment.json');
    expect(source).toContain('relay-alert-envelope/1');
    expect(source).toContain("[ESCALATION_STATUS_TOOL, 'audit', ARTIFACTS");
  });

  it('registers every delivery step and terminal leaf gate in the executable workflow graph', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', workflowPath], {
      cwd: repositoryRoot,
      env: { ...process.env, DRY_RUN: '1' },
      timeout: 15_000,
    });

    for (const step of [
      'emit-posthog',
      'escalate-infra',
      'file-issue',
      'slack-alert',
      'open-pr',
      'slack-followup',
      'enforce-infra-delivery',
      'enforce-posthog-delivery',
      'enforce-github-issue-delivery',
      'enforce-draft-pr-delivery',
      'enforce-slack-primary-delivery',
      'enforce-slack-followup-delivery',
      'enforce-escalations',
      'enforce-verdict',
    ]) {
      expect(stdout).toContain(step);
    }
    for (const [delivery, gate] of [
      ['escalate-infra', 'enforce-infra-delivery'],
      ['emit-posthog', 'enforce-posthog-delivery'],
      ['file-issue', 'enforce-github-issue-delivery'],
      ['slack-alert', 'enforce-slack-primary-delivery'],
      ['open-pr', 'enforce-draft-pr-delivery'],
      ['slack-followup', 'enforce-slack-followup-delivery'],
      ['slack-followup', 'enforce-escalations'],
    ]) {
      expect(plannedWave(stdout, gate)).toBeGreaterThan(plannedWave(stdout, delivery));
    }
    expect(stdout).toContain('Validation: PASS');
  });

  it('records explicit failed receipts for every delivery primitive', async () => {
    const source = await workflowSourcePromise;
    const primaryAlert = workflowStep(source, 'slack-alert');
    const primaryAlertExecutable = await slackAlertSourcePromise;
    const infraEscalationExecutable = await infraEscalationSourcePromise;
    const emitPosthog = workflowStep(source, 'emit-posthog');
    const fileIssue = workflowStep(source, 'file-issue');
    const openPr = workflowStep(source, 'open-pr');
    const followup = workflowStep(source, 'slack-followup');

    expect(fileIssue).toContain('ISSUE_RC=$?');
    expect(fileIssue).toContain('[ "$ISSUE_RC" -eq 0 ] && [ -n "$ISSUE_URL" ]');
    expect(openPr).toContain('PR_RC=$?');
    expect(openPr).toContain('[ "$PR_RC" -eq 0 ] && [ -n "$PR_URL" ]');
    expect(primaryAlert).toContain('bash "${SLACK_ALERT_TOOL}"');
    expect(primaryAlertExecutable).toContain('ALERT_ENVELOPE_FAILED: primary envelope write failed');
    expect(followup).toContain('ALERT_ENVELOPE_FAILED: followup envelope write failed');
    expect(emitPosthog).toContain('if [ "$TOTAL" -eq 0 ]');
    expect(emitPosthog).toContain('POSTHOG_DEADLINE_EPOCH=$(( $(date +%s) + 30 ))');
    expect(source).toContain('_remaining=$((POSTHOG_DEADLINE_EPOCH - $(date +%s)))');
    expect(primaryAlertExecutable).toContain('if [ "$SLACK_POSTED" -ne 1 ]');
    expect(infraEscalationExecutable).toContain('infra failed');
    expect(infraEscalationExecutable).not.toContain('escalation skipped');
    expect(followup).toContain('if [ "$SLACK_POSTED" -ne 1 ]');
    expect(source).toContain('out.channel !== channel');
    expect(source).toContain("typeof out.ts !== 'string'");
    expect(source).toContain("error.code = 'invalid_slack_receipt'");
    expect(source).not.toContain('ISSUE_SKIPPED: gh is not authenticated');
    expect(source).not.toContain('PR_SKIPPED: gh unavailable or unauthenticated');
    expect(source).not.toContain('FOLLOWUP_SKIPPED: no issue or PR to report');
  });

  it('executes the production Slack step and records a failed receipt when delivery throws', async () => {
    const directory = await artifacts();
    await writeFile(
      path.join(directory, 'verdict.json'),
      JSON.stringify({
        runId: 'verify-slack-executable-test',
        verdict: 'FAIL',
        provenance: {
          VERIFY_CLI_VERSION: 'test',
          VERIFY_REPO_VERSION: 'test',
          VERIFY_GIT_SHA: 'test',
        },
        totals: { pass: 0, fail: 1, skip: 0 },
        tiers: {
          tier1: {
            pass: 0,
            fail: 1,
            skip: 0,
            failures: [{ check: 'delivery', reason: 'forced missing auth' }],
          },
        },
        tiersNotRun: [],
      })
    );
    writeEscalationStatus(directory, 'infra', 'not_applicable', 'no harness failure');
    writeEscalationStatus(directory, 'github_issue', 'failed', 'gh is not authenticated');
    writeEscalationStatus(directory, 'posthog', 'failed', 'API key missing');

    const { stdout, stderr } = await execFileAsync('bash', [slackAlertPath], {
      env: {
        ...process.env,
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-slack-executable-test',
        VERIFY_SLACK_CHANNEL: 'C0AEKNLDNKW',
        CLOUD_API_URL: 'https://cloud.invalid',
        CLOUD_API_TOKEN: '',
        RELAY_CLOUD_API_TOKEN: '',
        CLOUD_API_ACCESS_TOKEN: '',
      },
      timeout: 10_000,
    });
    const receipt = JSON.parse(await readFile(path.join(directory, 'escalation-slack-primary.json'), 'utf8'));

    expect(receipt).toMatchObject({ channel: 'slack_primary', state: 'failed' });
    expect(`${stdout}\n${stderr}`).toContain('SLACK_UNDELIVERED to C0AEKNLDNKW');
    expect(escalationChannelAuditFailure(directory, 'slack_primary')).toContain('Slack primary alert failed');
  });

  it('fails closed before Slack delivery when verdict.json is structurally malformed', async () => {
    const directory = await artifacts();
    await writeFile(
      path.join(directory, 'verdict.json'),
      JSON.stringify({
        runId: 'verify-malformed-verdict',
        verdict: 'FAIL',
        provenance: {},
        totals: { pass: 0, fail: 1, skip: 0 },
        tiers: { tier1: { pass: 0, fail: 1, skip: 0, failures: [null] } },
        tiersNotRun: [],
      })
    );

    const { stdout, stderr } = await execFileAsync('bash', [slackAlertPath], {
      env: {
        ...process.env,
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-malformed-verdict',
        VERIFY_SLACK_CHANNEL: 'C0AEKNLDNKW',
      },
      timeout: 10_000,
    });
    const receipt = JSON.parse(await readFile(path.join(directory, 'escalation-slack-primary.json'), 'utf8'));

    expect(receipt).toMatchObject({ channel: 'slack_primary', state: 'failed' });
    expect(`${stdout}\n${stderr}`).toContain('SLACK_FAILED: verdict.json is malformed or incomplete');
    expect(`${stdout}\n${stderr}`).not.toContain('SLACK_POSTED');
  });

  it('rejects an array provenance value before Slack delivery', async () => {
    const directory = await artifacts();
    await writeFile(
      path.join(directory, 'verdict.json'),
      JSON.stringify({
        runId: 'verify-array-provenance',
        verdict: 'FAIL',
        provenance: [],
        totals: { pass: 0, fail: 1, skip: 0 },
        tiers: { tier1: { pass: 0, fail: 1, skip: 0, failures: [] } },
        tiersNotRun: [],
      })
    );

    const { stdout } = await execFileAsync('bash', [slackAlertPath], {
      env: {
        ...process.env,
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-array-provenance',
        VERIFY_SLACK_CHANNEL: 'C0AEKNLDNKW',
      },
      timeout: 10_000,
    });
    const receipt = JSON.parse(await readFile(path.join(directory, 'escalation-slack-primary.json'), 'utf8'));

    expect(receipt).toMatchObject({ channel: 'slack_primary', state: 'failed' });
    expect(stdout).toContain('SLACK_FAILED: verdict.json is malformed or incomplete');
  });

  it('preserves an explicitly empty Slack channel as a failed delivery', async () => {
    const directory = await artifacts();
    await writeFile(
      path.join(directory, 'verdict.json'),
      JSON.stringify({
        runId: 'verify-empty-channel',
        verdict: 'FAIL',
        provenance: {},
        totals: { pass: 0, fail: 1, skip: 0 },
        tiers: { tier1: { pass: 0, fail: 1, skip: 0, failures: [] } },
        tiersNotRun: [],
      })
    );

    const { stdout } = await execFileAsync('bash', [slackAlertPath], {
      env: {
        ...process.env,
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-empty-channel',
        VERIFY_SLACK_CHANNEL: '',
      },
      timeout: 10_000,
    });
    const receipt = JSON.parse(await readFile(path.join(directory, 'escalation-slack-primary.json'), 'utf8'));

    expect(receipt).toMatchObject({ channel: 'slack_primary', state: 'failed' });
    expect(stdout).toContain('ALERT_ENVELOPE_FAILED: VERIFY_SLACK_CHANNEL is required');
    expect(stdout).not.toContain('C0AEKNLDNKW');
  });

  it('records non-2xx HTTP responses from the production infra step and emits valid JSON', async () => {
    const directory = await artifacts();
    const bin = path.join(directory, 'bin');
    const capturedBody = path.join(directory, 'captured-body.json');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'curl'),
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; printf '%s' "$1" > "$INFRA_CAPTURE"; fi
  shift
done
printf '%s' "$FAKE_CURL_HTTP_STATUS"
exit "$FAKE_CURL_EXIT_STATUS"
`,
      { mode: 0o755 }
    );
    await writeFile(path.join(directory, 'provenance.env'), 'VERIFY_CLI_VERSION=proof\n');
    await writeFile(path.join(directory, 'caps.env'), 'provider_any=0\n');
    await writeFile(path.join(directory, 'verdict.json'), '{"tiersNotRun":[]}\n');

    const { stdout } = await execFileAsync('bash', [infraEscalationPath], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        INFRA_CAPTURE: capturedBody,
        FAKE_CURL_HTTP_STATUS: '302',
        FAKE_CURL_EXIT_STATUS: '0',
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-infra-http-failure',
        VERIFY_ENVIRONMENT: 'sandbox "quoted"',
        NIGHTCTO_EVIDENCE_URL: 'https://nightcto.invalid/evidence',
        NIGHTCTO_EVIDENCE_TOKEN: 'test-token',
      },
      timeout: 10_000,
    });
    const receipt = JSON.parse(await readFile(path.join(directory, 'escalation-infra.json'), 'utf8'));
    const payload = JSON.parse(await readFile(capturedBody, 'utf8'));

    expect(receipt).toMatchObject({ channel: 'infra', state: 'failed' });
    expect(stdout).toContain('DELIVERY_FAILED: POST returned HTTP 302');
    expect(stdout).toContain('INFRA_ESCALATION_FAILED: no_provider_cli');
    expect(payload).toMatchObject({
      environment: 'sandbox "quoted"',
      requestId: 'verify-infra-http-failure',
      errorCode: 'no_provider_cli',
    });

    const { stdout: transportStdout } = await execFileAsync('bash', [infraEscalationPath], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        INFRA_CAPTURE: capturedBody,
        FAKE_CURL_HTTP_STATUS: '000',
        FAKE_CURL_EXIT_STATUS: '7',
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-infra-transport-failure',
        NIGHTCTO_EVIDENCE_URL: 'https://nightcto.invalid/evidence',
        NIGHTCTO_EVIDENCE_TOKEN: 'test-token',
      },
      timeout: 10_000,
    });
    expect(transportStdout).toContain('DELIVERY_FAILED: POST transport failed (curl exit 7)');

    const blockedCapture = path.join(directory, 'non-https-body.json');
    const { stdout: nonHttpsStdout } = await execFileAsync('bash', [infraEscalationPath], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        INFRA_CAPTURE: blockedCapture,
        FAKE_CURL_HTTP_STATUS: '204',
        FAKE_CURL_EXIT_STATUS: '0',
        VERIFY_ARTIFACTS: directory,
        VERIFY_RUN_ID: 'verify-infra-non-https',
        NIGHTCTO_EVIDENCE_URL: 'http://nightcto.invalid/evidence',
        NIGHTCTO_EVIDENCE_TOKEN: 'must-not-be-sent',
      },
      timeout: 10_000,
    });
    expect(nonHttpsStdout).toContain('NIGHTCTO_EVIDENCE_URL must use HTTPS');
    await expect(stat(blockedCapture)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates artifacts and all mutating fix steps per invocation', async () => {
    const source = await workflowSourcePromise;
    const setup = workflowStep(source, 'setup');
    const fixIntegrity = workflowStep(source, 'fix-integrity');
    const openPr = workflowStep(source, 'open-pr');
    const followup = workflowStep(source, 'slack-followup');

    expect(setup).toContain('reset "${ARTIFACTS}"');
    expect(setup).toContain('if ! node "${ESCALATION_STATUS_TOOL}" reset "${ARTIFACTS}"');
    expect(source).toContain('prepareRunArtifacts(ARTIFACTS_ROOT, RUN_ID, RUN_NONCE)');
    expect(source).toContain('await prepareRunWorktree(REPO_ROOT, WORKTREE_ROOT, RUN_ID)');
    expect(source).toContain('await removeRunWorktree(REPO_ROOT, RUN_WORKTREE)');
    expect(source).toContain('const result = await wf.run({ dryRun, cwd: REPO_ROOT })');
    for (const mutatingStep of ['attempt-fix', 'fix-integrity', 'open-pr']) {
      expect(workflowStep(source, mutatingStep)).toContain('cwd: RUN_WORKTREE');
    }
    expect(fixIntegrity).toContain('VERIFY_ARTIFACTS="$ARTIFACTS" node');
    expect(fixIntegrity).toContain('[ "$CURRENT" = "main" ] || [ "$CURRENT" = "HEAD" ]');
    expect(openPr).toContain('[ "$BRANCH" = "main" ] || [ "$BRANCH" = "HEAD" ]');
    expect(followup).toContain('if ! node "$STATUS_TOOL" redact-file "$FOLLOWUP"; then');
    expect(followup).toContain('refusing to post unredacted evidence');
    expect(source).toContain('const ARTIFACTS = `${ARTIFACTS_ROOT}/runs/${RUN_ID}`');
    expect(source).not.toContain('INVOCATION_LOCK');
    expect(source).toContain('[verify-features] worktree cleanup failed:');
    expect(source).toContain('[verify-features] artifact completion marker failed:');
  });

  it('preserves the required Slack target and dry-run/run identity controls', async () => {
    const source = await workflowSourcePromise;

    expect(source).toContain('VERIFY_SLACK_CHANNEL="C0AEKNLDNKW"');
    expect(source).toContain("const dryRun = process.env.DRY_RUN === '1'");
    expect(source).toMatch(/const RUN_ID = `verify-\$\{TIMESTAMP\}-\$\{RUN_NONCE\}`/);
  });

  it('puts a failed issue delivery in the first Slack alert', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'github_issue', 'failed', 'gh is not authenticated');
    writeEscalationStatus(directory, 'posthog', 'failed', '13 events dropped: POSTHOG_API_KEY unset');

    const message = renderInitialEscalationStatus(directory);

    expect(message).toContain('*GitHub issue:* FAILED — gh is not authenticated');
    expect(message).toContain('*No GitHub issue was filed for this FAIL run. Human action is required.*');
    expect(message).toContain('*PostHog:* FAILED — 13 events dropped');
  });

  it('renders intentionally disabled autofix channels without false human-action warnings', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'github_issue', 'disabled', 'VERIFY_AUTOFIX=0');
    writeEscalationStatus(directory, 'draft_pr', 'disabled', 'VERIFY_AUTOFIX=0');

    const initial = renderInitialEscalationStatus(directory);
    const final = renderFinalEscalationStatus(directory);

    expect(initial).toContain('*GitHub issue:* DISABLED');
    expect(initial).toContain('*Draft fix PR:* DISABLED — autofix is disabled for this run');
    expect(initial).not.toContain('Human action is required');
    expect(final).not.toContain('NO GITHUB ISSUE');
    expect(final).not.toContain('NO DRAFT FIX PR');
  });

  it('renders final delivery state and evidence-based fixer categories', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'slack_primary', 'delivered', 'posted');
    writeEscalationStatus(directory, 'github_issue', 'failed', 'gh is not authenticated');
    writeEscalationStatus(directory, 'draft_pr', 'failed', 'no validated fix commit');
    writeEscalationStatus(directory, 'posthog', 'failed', '13/13 events dropped');
    await writeFile(
      path.join(directory, 'failure-assessment.json'),
      JSON.stringify([
        {
          tier: 'provenance',
          check: 'cli-belongs-to-checkout',
          category: 'provenance',
          evidence: 'CLI resolved outside checkout',
          reasoning: 'The tested artifact is not this checkout.',
        },
        {
          tier: 'tier2',
          check: 'broker start',
          category: 'identity',
          evidence: 'Recovery authority identity mismatch',
          reasoning: 'The workspace authority rejected the expected identity.',
        },
        {
          tier: 'tier5',
          check: 'cloud auth',
          category: 'environmental',
          evidence: 'relay cloud whoami reported no login',
          reasoning: 'The required external login is absent.',
        },
      ])
    );

    const message = renderFinalEscalationStatus(directory);

    expect(message).toContain('*NO GITHUB ISSUE WAS FILED FOR THIS FAIL RUN.*');
    expect(message).toContain('*NO DRAFT FIX PR WAS OPENED. Human follow-up is required.*');
    expect(message).toContain('environmental=1, identity=1, provenance=1');
    expect(message).toContain('provenance/cli-belongs-to-checkout: provenance');
  });

  it('reports a valid empty fixer assessment without calling it unavailable', async () => {
    const directory = await artifacts();
    await writeFile(path.join(directory, 'failure-assessment.json'), '[]\n');

    const message = renderFinalEscalationStatus(directory);

    expect(message).toContain('no individual check failures');
    expect(message).toContain('failed verdict contained no per-check failure records');
    expect(message).not.toContain('Fixer assessment unavailable');
  });

  it('redacts credentials from fixer evidence in the final alert', async () => {
    const directory = await artifacts();
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz123456';
    await writeFile(
      path.join(directory, 'failure-assessment.json'),
      JSON.stringify([
        {
          tier: 'tier2',
          check: 'broker auth',
          category: 'identity',
          evidence: `broker rejected ${token}`,
          reasoning: 'The supplied identity was rejected.',
        },
      ])
    );

    const message = renderFinalEscalationStatus(directory);

    expect(message).not.toContain(token);
    expect(message).toContain('[REDACTED_GITHUB_CREDENTIAL]');
  });

  it('fails the audit when GitHub and PostHog silently degrade', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'infra', 'not_applicable', 'no harness failure');
    writeEscalationStatus(directory, 'slack_primary', 'delivered', 'posted');
    writeEscalationStatus(directory, 'slack_followup', 'delivered', 'posted');
    writeEscalationStatus(directory, 'github_issue', 'failed', 'gh is not authenticated');
    writeEscalationStatus(directory, 'draft_pr', 'failed', 'gh is not authenticated');
    writeEscalationStatus(directory, 'posthog', 'failed', '13 events dropped');

    expect(escalationAuditFailures(directory)).toEqual([
      'PostHog failed: 13 events dropped',
      'GitHub issue failed: gh is not authenticated',
      'Draft fix PR failed: gh is not authenticated',
    ]);
    expect(escalationChannelAuditFailure(directory, 'github_issue')).toBe(
      'GitHub issue failed: gh is not authenticated'
    );
    expect(escalationChannelAuditFailure(directory, 'slack_primary')).toBeNull();
  });

  it('fails closed when infra delivery has no receipt and accepts an explicit non-applicable receipt', async () => {
    const directory = await artifacts();

    expect(escalationChannelAuditFailure(directory, 'infra', { allowNotApplicable: true })).toBe(
      'NightCTO infra alert failed: no valid escalation-infra.json was produced'
    );
    expect(escalationAuditFailures(directory)).toContain(
      'NightCTO infra alert failed: no valid escalation-infra.json was produced'
    );

    writeEscalationStatus(directory, 'infra', 'not_applicable', 'no harness failure');
    expect(escalationChannelAuditFailure(directory, 'infra', { allowNotApplicable: true })).toBeNull();
  });

  it('accepts a fully delivered FAIL escalation contract', async () => {
    const directory = await artifacts();
    for (const channel of [
      'infra',
      'slack_primary',
      'slack_followup',
      'github_issue',
      'draft_pr',
      'posthog',
    ] as const) {
      writeEscalationStatus(directory, channel, 'delivered', 'delivered');
    }

    expect(escalationAuditFailures(directory)).toEqual([]);
  });

  it('fails when the final status follow-up is missing even if the first Slack alert arrived', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'infra', 'not_applicable', 'no harness failure');
    writeEscalationStatus(directory, 'slack_primary', 'delivered', 'posted');
    writeEscalationStatus(directory, 'github_issue', 'delivered', 'created');
    writeEscalationStatus(directory, 'draft_pr', 'delivered', 'created');
    writeEscalationStatus(directory, 'posthog', 'delivered', 'delivered');

    expect(escalationAuditFailures(directory)).toContain(
      'Slack escalation follow-up failed: no valid escalation-slack-followup.json was produced'
    );
  });

  it('hands an undelivered alert to a trusted postback boundary without embedding credentials', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'slack_primary', 'failed', 'auth_token_missing');

    const envelope = writeAlertEnvelope(directory, {
      kind: 'primary',
      runId: 'verify-2026-09-02T03-01',
      channel: 'C0123456789',
      text: 'failure payload',
      sourceStatusChannel: 'slack_primary',
    });

    expect(envelope).toMatchObject({
      schemaVersion: 'relay-alert-envelope/1',
      idempotencyKey: 'relay-verify-features:verify-2026-09-02T03-01:primary',
      destination: { provider: 'slack', channel: 'C0123456789' },
      postbackRequired: true,
      receiptRequired: true,
      sourceDelivery: { state: 'failed', detail: 'auth_token_missing' },
    });
    expect(envelope).not.toHaveProperty('token');
    expect(envelope).not.toHaveProperty('credentials');
  });

  it('accepts a private Slack conversation ID for trusted postback', async () => {
    const directory = await artifacts();
    writeEscalationStatus(directory, 'slack_primary', 'failed', 'auth_token_missing');

    const envelope = writeAlertEnvelope(directory, {
      kind: 'primary',
      runId: 'verify-private-channel',
      channel: 'G0123456789',
      text: 'failure payload',
      sourceStatusChannel: 'slack_primary',
    });

    expect(envelope.destination.channel).toBe('G0123456789');
  });

  it('clears stale delivery receipts before a new run', async () => {
    const directory = await artifacts();
    for (const file of ['verdict.json', 'provenance.env', 'caps.env', 'autofix.env']) {
      await writeFile(path.join(directory, file), 'stale run');
    }
    for (const channel of [
      'infra',
      'slack_primary',
      'slack_followup',
      'github_issue',
      'draft_pr',
      'posthog',
    ] as const) {
      writeEscalationStatus(directory, channel, 'delivered', 'old run');
    }
    expect(escalationAuditFailures(directory)).toEqual([]);

    resetEscalationArtifacts(directory);

    expect(escalationAuditFailures(directory)).toHaveLength(6);
    for (const file of ['verdict.json', 'provenance.env', 'caps.env', 'autofix.env']) {
      await expect(readFile(path.join(directory, file), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('isolates overlapping runs while atomically advancing canonical artifact paths', async () => {
    const root = await artifacts();
    const runA = prepareRunArtifacts(root, 'verify-run-a', 'nonce-a');
    await writeFile(path.join(runA, 'checks.jsonl'), '{"run":"a"}\n');
    await writeFile(path.join(runA, 'verdict.json'), '{"runId":"a"}\n');

    const runB = prepareRunArtifacts(root, 'verify-run-b', 'nonce-b');
    await writeFile(path.join(runB, 'checks.jsonl'), '{"run":"b"}\n');

    expect(await readFile(path.join(runA, 'checks.jsonl'), 'utf8')).toContain('"a"');
    expect(await readFile(path.join(root, 'checks.jsonl'), 'utf8')).toContain('"b"');
    await expect(readFile(path.join(root, 'verdict.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeFile(path.join(runB, 'verdict.json'), '{"runId":"b"}\n');
    expect(await readFile(path.join(root, 'verdict.json'), 'utf8')).toContain('"b"');
  });

  it('replaces existing canonical symlinks through the Windows-safe path', async () => {
    const root = await artifacts();
    prepareRunArtifacts(root, 'verify-windows-a', 'windows-a', { platform: 'win32' });
    const runB = prepareRunArtifacts(root, 'verify-windows-b', 'windows-b', { platform: 'win32' });
    await writeFile(path.join(runB, 'checks.jsonl'), 'windows-b\n');

    expect(await readlink(path.join(root, 'current'))).toBe('runs/verify-windows-b');
    expect(await readFile(path.join(root, 'checks.jsonl'), 'utf8')).toBe('windows-b\n');
  });

  it('keeps every run intact when independent processes publish concurrently', async () => {
    const root = await artifacts();
    const moduleUrl = new URL('../../scripts/verify-features/run-artifacts.mjs', import.meta.url).href;
    const runIds = Array.from({ length: 8 }, (_, index) => `verify-concurrent-${index}`);
    const childScript = `
      const { writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { prepareRunArtifacts } = await import(${JSON.stringify(moduleUrl)});
      const artifacts = prepareRunArtifacts(process.argv[1], process.argv[2], process.argv[3]);
      writeFileSync(path.join(artifacts, 'checks.jsonl'), process.argv[2]);
    `;

    await Promise.all(
      runIds.map((runId, index) =>
        execFileAsync(
          process.execPath,
          ['--input-type=module', '--eval', childScript, root, runId, `nonce-${index}`],
          { timeout: 10_000 }
        )
      )
    );

    for (const runId of runIds) {
      expect(await readFile(path.join(root, 'runs', runId, 'checks.jsonl'), 'utf8')).toBe(runId);
    }
    expect(runIds).toContain(await readFile(path.join(root, 'checks.jsonl'), 'utf8'));
  });

  it('prunes only completed excess and long-abandoned runs', async () => {
    const root = await artifacts();
    for (let index = 0; index < 4; index += 1) {
      const runId = `verify-completed-${index}`;
      const directory = prepareRunArtifacts(root, runId, `completed-${index}`);
      markRunArtifactsComplete(directory, runId);
    }
    const active = prepareRunArtifacts(root, 'verify-active', 'active');
    const abandoned = path.join(root, 'runs', 'verify-abandoned');
    await mkdir(abandoned);

    const removed = pruneRunArtifacts(root, {
      currentRunId: 'verify-active',
      keepCompleted: 2,
      incompleteMaxAgeMs: 0,
      now: Date.now() + 1_000,
    });

    expect(removed).toHaveLength(3);
    expect(await readlink(path.join(root, 'current'))).toBe('runs/verify-active');
    expect(
      (await readdir(path.join(root, 'runs'))).filter((name) => name.startsWith('verify-completed-'))
    ).toHaveLength(2);
    await expect(readFile(path.join(active, '.complete'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(active)).resolves.toBeDefined();
    await expect(stat(abandoned)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('protects the canonical completed run without an explicit run id', async () => {
    const root = await artifacts();
    for (let index = 0; index < 4; index += 1) {
      const runId = `verify-canonical-${index}`;
      const directory = prepareRunArtifacts(root, runId, `canonical-${index}`);
      markRunArtifactsComplete(directory, runId);
    }

    pruneRunArtifacts(root, { keepCompleted: 1 });

    const remaining = await readdir(path.join(root, 'runs'));
    expect(remaining.filter((name) => name.startsWith('verify-canonical-'))).toHaveLength(2);
    await expect(stat(path.join(root, 'runs', 'verify-canonical-3'))).resolves.toBeDefined();
  });

  it('protects an absolute canonical symlink target during pruning', async () => {
    const root = await artifacts();
    for (let index = 0; index < 3; index += 1) {
      const runId = `verify-absolute-${index}`;
      const directory = prepareRunArtifacts(root, runId, `absolute-${index}`);
      markRunArtifactsComplete(directory, runId);
    }
    const canonical = path.join(root, 'runs', 'verify-absolute-0');
    await unlink(path.join(root, 'current'));
    await symlink(canonical, path.join(root, 'current'), 'dir');

    pruneRunArtifacts(root, { keepCompleted: 1 });

    await expect(stat(canonical)).resolves.toBeDefined();
  });

  it('rejects invalid incomplete-run retention windows', async () => {
    const root = await artifacts();
    for (const incompleteMaxAgeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => pruneRunArtifacts(root, { incompleteMaxAgeMs })).toThrow(
        'incompleteMaxAgeMs must be a non-negative integer'
      );
    }
  });

  it('reserves the internal pruning marker from run ids', async () => {
    const root = await artifacts();
    expect(() => prepareRunArtifacts(root, 'verify.pruning-live', 'nonce')).toThrow(
      'runId must be a single safe path segment'
    );
  });

  it('bounds completed history when independent pruners race', async () => {
    const root = await artifacts();
    for (let index = 0; index < 12; index += 1) {
      const runId = `verify-history-${index}`;
      const directory = prepareRunArtifacts(root, runId, `history-${index}`);
      markRunArtifactsComplete(directory, runId);
    }
    const active = prepareRunArtifacts(root, 'verify-current', 'current');
    const moduleUrl = new URL('../../scripts/verify-features/run-artifacts.mjs', import.meta.url).href;
    const childScript = `
      const { pruneRunArtifacts } = await import(${JSON.stringify(moduleUrl)});
      pruneRunArtifacts(process.argv[1], { currentRunId: process.argv[2], keepCompleted: 3 });
    `;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileAsync(
          process.execPath,
          ['--input-type=module', '--eval', childScript, root, 'verify-current'],
          { timeout: 10_000 }
        )
      )
    );

    const remaining = await readdir(path.join(root, 'runs'));
    expect(remaining.filter((name) => name.startsWith('verify-history-'))).toHaveLength(3);
    expect(remaining).toContain('verify-current');
    expect(remaining.some((name) => name.includes('.pruning-'))).toBe(false);
    await expect(stat(active)).resolves.toBeDefined();
  });

  it('runs autofix git operations in an isolated detachable worktree', async () => {
    const repo = await artifacts();
    await execFileAsync('git', ['-C', repo, 'init']);
    await writeFile(path.join(repo, 'fixture.txt'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'fixture.txt']);
    await execFileAsync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Relay Test',
      '-c',
      'user.email=relay@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    const workspace = await artifacts();
    const worktreeA = await prepareRunWorktree(repo, workspace, 'verify-worktree-a');
    const worktreeB = await prepareRunWorktree(repo, workspace, 'verify-worktree-b');
    await writeFile(path.join(worktreeA, 'fixture.txt'), 'isolated-a\n');
    await writeFile(path.join(worktreeB, 'fixture.txt'), 'isolated-b\n');

    expect(await readFile(path.join(repo, 'fixture.txt'), 'utf8')).toBe('base\n');
    expect(await readFile(path.join(worktreeA, 'fixture.txt'), 'utf8')).toBe('isolated-a\n');
    expect(await readFile(path.join(worktreeB, 'fixture.txt'), 'utf8')).toBe('isolated-b\n');

    await removeRunWorktree(repo, worktreeA);
    await removeRunWorktree(repo, worktreeB);
  });

  it('does not remove a pre-existing worktree when a duplicate add fails', async () => {
    const repo = await artifacts();
    await execFileAsync('git', ['-C', repo, 'init']);
    await writeFile(path.join(repo, 'fixture.txt'), 'base\n');
    await execFileAsync('git', ['-C', repo, 'add', 'fixture.txt']);
    await execFileAsync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Relay Test',
      '-c',
      'user.email=relay@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    const workspace = await artifacts();
    const existing = await prepareRunWorktree(repo, workspace, 'verify-existing');
    await writeFile(path.join(existing, 'uncommitted.txt'), 'must survive\n');

    await expect(prepareRunWorktree(repo, workspace, 'verify-existing')).rejects.toThrow('git worktree add');

    expect(await readFile(path.join(existing, 'uncommitted.txt'), 'utf8')).toBe('must survive\n');
    const { stdout: worktreeList } = await execFileAsync('git', ['-C', repo, 'worktree', 'list']);
    expect(worktreeList).toContain(existing);
    await removeRunWorktree(repo, existing);
  });

  it.skipIf(process.platform === 'win32')(
    'kills checkout-filter descendants when worktree creation times out',
    async ({ skip }) => {
      const repo = await artifacts();
      await execFileAsync('git', ['-C', repo, 'init']);
      await writeFile(path.join(repo, 'fixture.txt'), 'base\n');
      await writeFile(path.join(repo, '.gitattributes'), 'fixture.txt filter=slow\n');
      await execFileAsync('git', ['-C', repo, 'add', 'fixture.txt', '.gitattributes']);
      await execFileAsync('git', [
        '-C',
        repo,
        '-c',
        'user.name=Relay Test',
        '-c',
        'user.email=relay@example.invalid',
        'commit',
        '-m',
        'fixture',
      ]);
      const pidFile = path.join(repo, 'filter.pid');
      await execFileAsync('git', [
        '-C',
        repo,
        'config',
        'filter.slow.smudge',
        `sh -c 'echo $$ > "${pidFile}"; sleep 30'`,
      ]);

      const workspace = await artifacts();
      await expect(prepareRunWorktree(repo, workspace, 'verify-timeout', { timeoutMs: 200 })).rejects.toThrow(
        'timed out after 200ms'
      );
      await expect(stat(path.join(workspace, 'worktrees', 'verify-timeout'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const { stdout: worktreeList } = await execFileAsync('git', ['-C', repo, 'worktree', 'list']);
      expect(worktreeList).not.toContain('verify-timeout');

      let pidText;
      try {
        pidText = await readFile(pidFile, 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          skip('git did not start the checkout filter before the timeout');
          return;
        }
        throw error;
      }
      const filterPid = Number(pidText.trim());
      expect(Number.isSafeInteger(filterPid)).toBe(true);
      let processState = '';
      const settleDeadline = Date.now() + 2_000;
      while (Date.now() < settleDeadline) {
        try {
          const result = await execFileAsync('ps', ['-o', 'stat=', '-p', String(filterPid)]);
          processState = result.stdout.trim();
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
          processState = '';
        }
        if (processState === '' || processState.startsWith('Z')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processState === '' || processState.startsWith('Z')).toBe(true);
    }
  );

  it('rejects worktree timeouts beyond the Node timer limit', async () => {
    await expect(
      prepareRunWorktree(await artifacts(), await artifacts(), 'verify-timeout-overflow', {
        timeoutMs: 2_147_483_648,
      })
    ).rejects.toThrow('timeoutMs must be an integer between 1 and 2147483647');
  });

  it('rejects prototype names and incomplete delivery receipts', async () => {
    const directory = await artifacts();

    expect(() =>
      writeEscalationStatus(directory, 'toString' as never, 'delivered', 'invalid channel')
    ).toThrow('unknown escalation channel: toString');

    await writeFile(
      path.join(directory, 'escalation-slack-primary.json'),
      JSON.stringify({ channel: 'slack_primary', state: 'delivered' })
    );
    expect(escalationChannelAuditFailure(directory, 'slack_primary')).toBe(
      'Slack primary alert failed: no valid escalation-slack-primary.json was produced'
    );
  });

  it('redacts credentials from stored escalation URLs', async () => {
    const directory = await artifacts();
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz123456';
    const status = writeEscalationStatus(
      directory,
      'github_issue',
      'delivered',
      'created',
      `https://github.com/example/repo/issues/1?token=${token}`
    );

    expect(status.url).not.toContain(token);
    expect(status.url).toContain('[REDACTED_GITHUB_CREDENTIAL]');
  });

  it('redacts common Relay, GitHub, Slack, and bearer credentials from alert payloads', () => {
    const text = redactAlertText(
      'rk_live_secret123 at_live_secret456 nt_live_secret789 br_secret987 ' +
        'ghp_abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz123456 ' +
        'xoxb-123-secret Bearer abc.def'
    );

    expect(text).not.toContain('secret123');
    expect(text).not.toContain('secret456');
    expect(text).not.toContain('secret789');
    expect(text).not.toContain('secret987');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('xoxb-123-secret');
    expect(text).not.toContain('abc.def');
  });
});
