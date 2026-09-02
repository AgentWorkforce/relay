import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const temporaryDirectories: string[] = [];

function workflowStep(source: string, name: string): string {
  const start = source.indexOf(`wf.step('${name}', {`);
  if (start === -1) throw new Error(`workflow step not found: ${name}`);
  const next = source.indexOf("\n  wf.step('", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
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
  it('wires loud delivery enforcement and bounded provenance-safe probes', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../workflows/verify-features.ts', import.meta.url)),
      'utf8'
    );

    const capabilities = workflowStep(source, 'capabilities');
    const setup = workflowStep(source, 'setup');
    const primaryAlert = workflowStep(source, 'slack-alert');
    const fileIssue = workflowStep(source, 'file-issue');
    const openPr = workflowStep(source, 'open-pr');
    const followup = workflowStep(source, 'slack-followup');

    expect(workflowStep(source, 'enforce-escalations')).toContain(
      'node "$STATUS_TOOL" audit "$ARTIFACTS" "$AUTOFIX"'
    );
    expect(source).toMatch(/step:\s*['"]enforce-slack-primary-delivery['"]/);
    expect(source).toMatch(/step:\s*['"]enforce-github-issue-delivery['"]/);
    expect(source).toMatch(/step:\s*['"]enforce-draft-pr-delivery['"]/);
    expect(followup).toMatch(/dependsOn:\s*\[\s*['"]open-pr['"]\s*,\s*['"]slack-alert['"]\s*\]/);
    expect(capabilities).toMatch(/timeout:\s*10_000|timeout:\s*10000/);
    expect(source).toContain('abort_for_invalid_provenance');
    expect(source).toContain('failure-assessment.json');
    expect(source).toContain('relay-alert-envelope/1');
    expect(source).toContain('VERIFY_SLACK_CHANNEL="C0AEKNLDNKW"');
    expect(setup).toContain('reset "${ARTIFACTS}"');
    expect(fileIssue).toContain('ISSUE_RC=$?');
    expect(fileIssue).toContain('[ "$ISSUE_RC" -eq 0 ] && [ -n "$ISSUE_URL" ]');
    expect(openPr).toContain('PR_RC=$?');
    expect(openPr).toContain('[ "$PR_RC" -eq 0 ] && [ -n "$PR_URL" ]');
    expect(primaryAlert).toContain('ALERT_ENVELOPE_FAILED: primary envelope write failed');
    expect(followup).toContain('ALERT_ENVELOPE_FAILED: followup envelope write failed');
    expect(source).toContain("const dryRun = process.env.DRY_RUN === '1'");
    expect(source).toContain("[ESCALATION_STATUS_TOOL, 'audit', ARTIFACTS");
    expect(source).toMatch(/const RUN_ID = `verify-\$\{TIMESTAMP\}-\$\{RUN_NONCE\}`/);
    expect(source).not.toContain('ISSUE_SKIPPED: gh is not authenticated');
    expect(source).not.toContain('PR_SKIPPED: gh unavailable or unauthenticated');
    expect(source).not.toContain('FOLLOWUP_SKIPPED: no issue or PR to report');
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

  it('fails the audit when GitHub and PostHog silently degrade', async () => {
    const directory = await artifacts();
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

  it('accepts a fully delivered FAIL escalation contract', async () => {
    const directory = await artifacts();
    for (const channel of [
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
    for (const channel of [
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

    expect(escalationAuditFailures(directory)).toHaveLength(5);
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
