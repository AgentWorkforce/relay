import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS_FILES = Object.freeze({
  infra: 'escalation-infra.json',
  posthog: 'escalation-posthog.json',
  github_issue: 'escalation-github-issue.json',
  draft_pr: 'escalation-draft-pr.json',
  slack_primary: 'escalation-slack-primary.json',
  slack_followup: 'escalation-slack-followup.json',
});

const LABELS = Object.freeze({
  infra: 'NightCTO infra alert',
  posthog: 'PostHog',
  github_issue: 'GitHub issue',
  draft_pr: 'Draft fix PR',
  slack_primary: 'Slack primary alert',
  slack_followup: 'Slack escalation follow-up',
});

const VALID_STATES = new Set(['delivered', 'failed', 'disabled', 'not_applicable', 'pending']);

export function redactAlertText(value) {
  return String(value)
    .replace(
      /\b(?:rk_live_|rjt_live_|at_live_|nt_live_|ot_live_|cld_at_|rth_at_|ocl_node_enr_|br_)[A-Za-z0-9_%-]+(?:\.[A-Za-z0-9_%-]+)*/g,
      '[REDACTED_RELAY_CREDENTIAL]'
    )
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_CREDENTIAL]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK_CREDENTIAL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth(?:orization)?)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
      '$1[REDACTED]'
    );
}

function assertChannel(channel) {
  if (!Object.hasOwn(STATUS_FILES, channel)) {
    throw new Error(`unknown escalation channel: ${channel}`);
  }
}

export function statusPath(artifacts, channel) {
  assertChannel(channel);
  return path.join(artifacts, STATUS_FILES[channel]);
}

export function writeEscalationStatus(artifacts, channel, state, detail, url = '') {
  assertChannel(channel);
  if (!VALID_STATES.has(state)) {
    throw new Error(`invalid escalation state for ${channel}: ${state}`);
  }

  const record = {
    schemaVersion: 1,
    channel,
    state,
    detail: redactAlertText(detail || '').slice(0, 1000),
    ...(url ? { url: redactAlertText(url).slice(0, 1000) } : {}),
  };
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(statusPath(artifacts, channel), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function writeAlertEnvelope(artifacts, { kind, runId, channel, text, sourceStatusChannel }) {
  if (!['primary', 'followup'].includes(kind)) {
    throw new Error(`invalid alert envelope kind: ${kind}`);
  }
  if (!/^[CG][A-Z0-9]+$/.test(channel)) {
    throw new Error('alert envelope requires an explicit Slack channel ID');
  }
  const sourceDelivery = readEscalationStatus(artifacts, sourceStatusChannel);
  const envelope = {
    schemaVersion: 'relay-alert-envelope/1',
    idempotencyKey: `relay-verify-features:${runId}:${kind}`,
    producer: 'relay-verify-features',
    runId,
    kind,
    severity: 'critical',
    destination: { provider: 'slack', channel },
    text: redactAlertText(text).slice(0, 12_000),
    sourceDelivery,
    postbackRequired: sourceDelivery.state !== 'delivered',
    receiptRequired: true,
  };
  const outputPath = path.join(artifacts, `alert-${kind}-envelope.json`);
  writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

export function resetEscalationArtifacts(artifacts) {
  const runScopedFiles = [
    ...Object.values(STATUS_FILES),
    'alert-primary-envelope.json',
    'alert-followup-envelope.json',
    'verdict.json',
    'provenance.env',
    'caps.env',
    'autofix.env',
    'issue-url.txt',
    'pr-url.txt',
    'failure-assessment.json',
    'fix-integrity.env',
    'fix-summary.md',
  ];
  for (const file of runScopedFiles) {
    rmSync(path.join(artifacts, file), { force: true });
  }
}

export function readEscalationStatus(artifacts, channel) {
  assertChannel(channel);
  try {
    const record = JSON.parse(readFileSync(statusPath(artifacts, channel), 'utf8'));
    if (
      record?.schemaVersion !== 1 ||
      record.channel !== channel ||
      !VALID_STATES.has(record.state) ||
      typeof record.detail !== 'string' ||
      (record.url !== undefined && typeof record.url !== 'string')
    ) {
      throw new Error('invalid record');
    }
    return record;
  } catch {
    return {
      schemaVersion: 1,
      channel,
      state: 'failed',
      detail: `no valid ${STATUS_FILES[channel]} was produced`,
    };
  }
}

function statusLine(record) {
  const suffix = record.url ? ` — ${record.url}` : record.detail ? ` — ${record.detail}` : '';
  return `• *${LABELS[record.channel]}:* ${record.state.toUpperCase()}${suffix}`;
}

function readAssessment(artifacts) {
  try {
    const assessments = JSON.parse(readFileSync(path.join(artifacts, 'failure-assessment.json'), 'utf8'));
    if (!Array.isArray(assessments)) throw new Error('assessment is not an array');
    if (
      assessments.some(
        (assessment) =>
          !assessment.tier ||
          !assessment.check ||
          !assessment.category ||
          !String(assessment.evidence || '').trim() ||
          !String(assessment.reasoning || '').trim()
      )
    ) {
      throw new Error('incomplete assessment');
    }
    const counts = new Map();
    for (const assessment of assessments) {
      const category = String(assessment.category || 'unknown');
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    const summary = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category}=${count}`)
      .join(', ');
    if (assessments.length === 0) {
      return {
        summary: 'no individual check failures',
        details: ['    ↳ the failed verdict contained no per-check failure records'],
      };
    }
    const details = assessments.slice(0, 20).map((assessment) => {
      const evidence = redactAlertText(String(assessment.evidence || 'no evidence'))
        .replace(/\s+/g, ' ')
        .slice(0, 180);
      return `    ↳ ${assessment.tier}/${assessment.check}: ${assessment.category} — ${evidence}`;
    });
    if (assessments.length > details.length) {
      details.push(
        `    ↳ ${assessments.length - details.length} more assessment(s) in failure-assessment.json`
      );
    }
    return { summary, details };
  } catch {
    return {
      summary: 'UNAVAILABLE — the fixer did not provide a valid per-failure evidence assessment',
      details: [],
    };
  }
}

export function renderInitialEscalationStatus(artifacts) {
  const infra = readEscalationStatus(artifacts, 'infra');
  const issue = readEscalationStatus(artifacts, 'github_issue');
  const posthog = readEscalationStatus(artifacts, 'posthog');
  const lines = [
    '*Escalation delivery at first alert:*',
    statusLine(infra),
    statusLine(issue),
    '• *Draft fix PR:* PENDING — the automated fix and integrity gate have not finished yet',
    statusLine(posthog),
  ];
  if (issue.state === 'failed') {
    lines.push('*No GitHub issue was filed for this FAIL run. Human action is required.*');
  }
  return lines.join('\n');
}

export function renderFinalEscalationStatus(artifacts) {
  const records = ['infra', 'slack_primary', 'github_issue', 'draft_pr', 'posthog'].map((channel) =>
    readEscalationStatus(artifacts, channel)
  );
  const issue = records.find((record) => record.channel === 'github_issue');
  const pr = records.find((record) => record.channel === 'draft_pr');
  const assessment = readAssessment(artifacts);
  const lines = [
    ':warning: *Final escalation delivery status*',
    ...records.map(statusLine),
    `• *Autofix classification:* ${assessment.summary}`,
    ...assessment.details,
  ];
  if (issue?.state !== 'delivered') {
    lines.push('*NO GITHUB ISSUE WAS FILED FOR THIS FAIL RUN.*');
  }
  if (pr?.state !== 'delivered') {
    lines.push('*NO DRAFT FIX PR WAS OPENED. Human follow-up is required.*');
  }
  return lines.join('\n');
}

export function escalationAuditFailures(artifacts, { autofixEnabled = true } = {}) {
  const infra = readEscalationStatus(artifacts, 'infra');
  const primarySlack = readEscalationStatus(artifacts, 'slack_primary');
  const followupSlack = readEscalationStatus(artifacts, 'slack_followup');
  const posthog = readEscalationStatus(artifacts, 'posthog');
  const failures = [];

  if (infra.state !== 'delivered' && infra.state !== 'not_applicable') {
    failures.push(`NightCTO infra alert ${infra.state}: ${infra.detail}`);
  }

  if (primarySlack.state !== 'delivered') {
    failures.push(`Slack primary alert ${primarySlack.state}: ${primarySlack.detail}`);
  }
  if (followupSlack.state !== 'delivered') {
    failures.push(`Slack escalation follow-up ${followupSlack.state}: ${followupSlack.detail}`);
  }
  if (posthog.state !== 'delivered') {
    failures.push(`PostHog ${posthog.state}: ${posthog.detail}`);
  }

  if (autofixEnabled) {
    for (const channel of ['github_issue', 'draft_pr']) {
      const record = readEscalationStatus(artifacts, channel);
      if (record.state !== 'delivered') {
        failures.push(`${LABELS[channel]} ${record.state}: ${record.detail}`);
      }
    }
  }

  return failures;
}

export function escalationChannelAuditFailure(
  artifacts,
  channel,
  { required = true, allowNotApplicable = false } = {}
) {
  assertChannel(channel);
  if (!required) return null;
  const record = readEscalationStatus(artifacts, channel);
  if (record.state === 'delivered') return null;
  if (allowNotApplicable && record.state === 'not_applicable') return null;
  return `${LABELS[channel]} ${record.state}: ${record.detail}`;
}

function usage() {
  return [
    'Usage:',
    '  escalation-status.mjs write <artifacts> <channel> <state> <detail> [url]',
    '  escalation-status.mjs render-initial <artifacts>',
    '  escalation-status.mjs render-final <artifacts>',
    '  escalation-status.mjs audit <artifacts> <autofix:0|1>',
    '  escalation-status.mjs audit-channel <artifacts> <channel> <required:0|1> [allow-not-applicable:0|1]',
    '  escalation-status.mjs envelope <artifacts> <kind> <runId> <channel> <textFile> <sourceStatusChannel>',
    '  escalation-status.mjs reset <artifacts>',
    '  escalation-status.mjs redact-file <path>',
  ].join('\n');
}

function main(argv) {
  const [command, artifacts, ...args] = argv;
  if (command === 'write') {
    const [channel, state, detail, url] = args;
    writeEscalationStatus(artifacts, channel, state, detail, url);
    return;
  }
  if (command === 'render-initial') {
    process.stdout.write(`${renderInitialEscalationStatus(artifacts)}\n`);
    return;
  }
  if (command === 'render-final') {
    process.stdout.write(`${renderFinalEscalationStatus(artifacts)}\n`);
    return;
  }
  if (command === 'audit') {
    const failures = escalationAuditFailures(artifacts, { autofixEnabled: args[0] !== '0' });
    if (failures.length === 0) {
      console.log('ESCALATION_AUDIT_OK: all required channels delivered');
      return;
    }
    console.error('ESCALATION_AUDIT_FAIL:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (command === 'audit-channel') {
    const [channel, required, allowNotApplicable] = args;
    const failure = escalationChannelAuditFailure(artifacts, channel, {
      required: required !== '0',
      allowNotApplicable: allowNotApplicable === '1',
    });
    if (!failure) {
      console.log(`ESCALATION_CHANNEL_AUDIT_OK: ${channel}`);
      return;
    }
    console.error(`ESCALATION_CHANNEL_AUDIT_FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (command === 'envelope') {
    const [kind, runId, channel, textFile, sourceStatusChannel] = args;
    writeAlertEnvelope(artifacts, {
      kind,
      runId,
      channel,
      text: readFileSync(textFile, 'utf8'),
      sourceStatusChannel,
    });
    console.log(`ALERT_ENVELOPE_READY: ${kind} postback`);
    return;
  }
  if (command === 'reset') {
    resetEscalationArtifacts(artifacts);
    console.log('ESCALATION_ARTIFACTS_RESET');
    return;
  }
  if (command === 'redact-file') {
    const target = artifacts;
    writeFileSync(target, redactAlertText(readFileSync(target, 'utf8')));
    return;
  }
  throw new Error(usage());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
