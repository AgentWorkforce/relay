/**
 * audit-feature-manifest.ts
 *
 * Keeps .agentworkforce/features/manifest.yaml honest about the CLI's real
 * surface, and files the work when it drifts.
 *
 * ## Why this exists
 *
 * The manifest is the input to every feature-verification run, so a command
 * nobody documented is a command nobody verifies. Coverage does not fail loudly
 * when it shrinks — it just quietly stops covering things.
 *
 * The only pre-existing guard was `manifest-contract.test.ts`, which asserts
 * the manifest contains each entry of a hand-maintained list of ~110 commands.
 * That catches a *deletion* from the manifest but is structurally incapable of
 * noticing a newly *added* CLI command or MCP tool, because a new command is
 * absent from both the manifest and the expected list. On the first run of
 * scripts/audit-feature-manifest.mjs, `fleet spawn` and `fleet release` had
 * been shipping undocumented and therefore unverified.
 *
 * This workflow derives the surface instead of asserting a snapshot of it:
 * it walks `--help` recursively for the Commander tree and performs a
 * `tools/list` JSON-RPC handshake for MCP tools, then diffs against the
 * manifest.
 *
 * Schedule:
 *   relay cloud schedule workflows/audit-feature-manifest.ts --cron "0 2 * * 1"
 *
 * Manually:
 *   relay node workflow run workflows/audit-feature-manifest.ts
 *
 * ## Exit semantics
 *
 * The audit script distinguishes three outcomes, and so does this workflow:
 *   0  manifest matches the derived surface
 *   1  drift — file an issue, update the manifest on a branch, open a draft PR
 *   2  the audit could not run — escalate to NightCTO, because a broken audit
 *      reporting "clean" is worse than no audit at all
 *
 * ## Environment
 *
 *   AUDIT_SLACK_CHANNEL     Slack channel ID for drift. Default C0AEKNLDNKW.
 *   AUDIT_AUTOFIX           "0" disables the issue/manifest-update/PR path.
 *   RELAY_CLI               CLI under audit. Defaults to the repo build.
 *   POSTHOG_API_KEY         Enables PostHog emission. Host: POSTHOG_HOST.
 *   NIGHTCTO_EVIDENCE_URL   Enables escalation when the audit cannot run.
 *   NIGHTCTO_EVIDENCE_TOKEN Bearer token for the above.
 *   CLOUD_API_URL           Required for Slack delivery, which goes through the
 *   CLOUD_API_TOKEN         relayflows Slack primitive's cloud-relay runtime
 *                           (/api/v1/slack/post-message) using the workspace's
 *                           configured Slack integration. No bot token is read.
 */

import { existsSync, readFileSync } from 'node:fs';

import { workflow } from '@relayflows/core';

const ARTIFACTS = '.workflow-artifacts/audit-feature-manifest';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const RUN_ID = `audit-${TIMESTAMP}`;
const REPORT_FILE = `${ARTIFACTS}/audit.json`;
const FIX_BRANCH = `chore/${RUN_ID}-manifest`;

/**
 * Slack destination, as a channel ID. The cloud-relay runtime does not
 * implement channel resolution, so an ID is the only form guaranteed to work.
 */
const SLACK_CHANNEL = process.env.AUDIT_SLACK_CHANNEL ?? 'C0AEKNLDNKW';
const AUTOFIX = process.env.AUDIT_AUTOFIX !== '0';

/** A literal backtick; a raw one would close the template literals below. */
const BT = '`';

/**
 * Optional-environment seeding. `printenv` rather than `${VAR:-default}`
 * because these step bodies are TypeScript template literals — a `${` in the
 * shell source would be parsed as TypeScript interpolation. Also keeps `set -u`
 * from aborting on an unconfigured optional knob.
 */
const ENV_DEFAULTS = String.raw`
POSTHOG_API_KEY="$(printenv POSTHOG_API_KEY || true)"
POSTHOG_HOST="$(printenv POSTHOG_HOST || true)"
NIGHTCTO_EVIDENCE_URL="$(printenv NIGHTCTO_EVIDENCE_URL || true)"
NIGHTCTO_EVIDENCE_TOKEN="$(printenv NIGHTCTO_EVIDENCE_TOKEN || true)"
CLOUD_API_URL="$(printenv CLOUD_API_URL || true)"
CLOUD_API_TOKEN="$(printenv CLOUD_API_TOKEN || true)"
# The cloud sandbox injects CLOUD_API_ACCESS_TOKEN, not CLOUD_API_TOKEN (see
# the launcher's env bundle), but @relayflows/slack-primitive only reads
# CLOUD_API_TOKEN. Without this bridge every scheduled run fails Slack
# delivery with auth_token_missing. github-primitive already falls back the
# same way (RELAY_CLOUD_API_TOKEN -> CLOUD_API_ACCESS_TOKEN); slack does not.
if [ -z "$CLOUD_API_TOKEN" ]; then
  CLOUD_API_TOKEN="$(printenv RELAY_CLOUD_API_TOKEN || true)"
fi
if [ -z "$CLOUD_API_TOKEN" ]; then
  CLOUD_API_TOKEN="$(printenv CLOUD_API_ACCESS_TOKEN || true)"
fi

# These are read by the node children this workflow writes and runs (the Slack
# post script), so they must be exported, not just assigned. Plain assignment
# left the child seeing only the original process env, which silently defeated
# the fallback above.
export CLOUD_API_URL CLOUD_API_TOKEN
RELAY_CLI="$(printenv RELAY_CLI || true)"
VERIFY_ENVIRONMENT="$(printenv VERIFY_ENVIRONMENT || true)"
if [ -z "$POSTHOG_HOST" ]; then POSTHOG_HOST="https://i.agentrelay.com"; fi
if [ -z "$VERIFY_ENVIRONMENT" ]; then VERIFY_ENVIRONMENT="sandbox"; fi
export AUDIT_ARTIFACTS="${ARTIFACTS}"
export AUDIT_RUN_ID="${RUN_ID}"
`;

/**
 * Post to Slack through the relayflows Slack primitive.
 *
 * Pins `runtime: 'cloud-relay'` on purpose: the adapter's auto-detection falls
 * back to a local `SLACK_BOT_TOKEN` runtime that talks to slack.com directly,
 * and drift reports must go through the workspace's configured Slack
 * integration. Pinning turns a missing CLOUD_API_* pair into an explicit
 * `auth_token_missing` rather than a silent change of route.
 */
const SLACK_POST_FN = String.raw`
slack_post() {
  _sp_channel="$1"
  _sp_textfile="$2"

  cat > "$ARTIFACTS/slack-post.mjs" <<'SLACKPOSTEOF'
import { readFileSync } from 'node:fs';
import { SlackClient } from '@relayflows/slack-primitive';

const [channel, textFile] = process.argv.slice(2);
const text = readFileSync(textFile, 'utf8');

const client = new SlackClient({
  runtime: 'cloud-relay',
  cloudApiUrl: process.env.CLOUD_API_URL,
  cloudApiToken: process.env.CLOUD_API_TOKEN,
});

try {
  const out = await client.postMessage({ channel, text, unfurl: false });
  console.log('SLACK_POSTED channel=' + out.channel + ' ts=' + out.ts);
} catch (err) {
  const code = err && err.code ? err.code : 'unknown';
  console.log('SLACK_ERROR ' + code + ': ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
}
SLACKPOSTEOF

  if node "$ARTIFACTS/slack-post.mjs" "$_sp_channel" "$_sp_textfile"; then
    return 0
  fi

  echo "SLACK_UNDELIVERED to $_sp_channel — payload follows:"
  echo "---- undelivered Slack payload ----"
  cat "$_sp_textfile"
  echo "---- end payload ----"
  return 1
}
`;

async function main() {
  const wf = workflow('relay-audit-feature-manifest')
    .description(
      'Derive the CLI and MCP surface, diff it against the feature manifest, and open a ' +
        'draft PR updating the manifest when it has drifted.'
    )
    .pattern('pipeline')
    .channel('relay-health')
    .maxConcurrency(3)
    // "continue" also opts out of applyReliabilityDefaults attaching a repair
    // agent to a failing gate — an audit an agent can edit until it passes is
    // not an audit.
    .onError('continue')
    .timeout(900_000);

  wf.agent('manifest-editor', {
    cli: 'claude',
    role: 'Update the feature manifest to match the CLI surface the audit derived',
    retries: 0,
  });

  // ── Phase 1: run the audit ───────────────────────────────────────────────
  //
  // failOnError stays false so the reporting steps below can run; the exit
  // code is captured into audit-exit.txt and drives everything downstream.

  wf.step('audit', {
    type: 'deterministic',
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

mkdir -p "${ARTIFACTS}"
${ENV_DEFAULTS}

CLI_ARG=""
if [ -n "$RELAY_CLI" ]; then
  CLI_ARG="--cli $RELAY_CLI"
fi

# Human-readable for the log, JSON for the machinery. Two invocations rather
# than one because the script's report goes to stdout in one format at a time.
node scripts/audit-feature-manifest.mjs $CLI_ARG 2>&1 | tee "${ARTIFACTS}/audit.txt"
EXIT_CODE=$?

node scripts/audit-feature-manifest.mjs $CLI_ARG --json > "${ARTIFACTS}/audit.json" 2>"${ARTIFACTS}/audit.err" || true

echo "$EXIT_CODE" > "${ARTIFACTS}/audit-exit.txt"

# Published for the fix chain: update-manifest is an agent step and cannot read
# this workflow's constants, so the operator's autofix decision has to reach it
# through the filesystem.
echo "AUTOFIX=${AUTOFIX ? '1' : '0'}" > "${ARTIFACTS}/autofix.env"

echo "audit exit code: $EXIT_CODE"
exit 0
`,
  });

  // ── Phase 2: escalate an unrunnable audit ────────────────────────────────
  //
  // Exit 2 means the audit itself broke (CLI missing, help unparseable). That
  // is an operator problem, not a manifest problem: a silent audit means
  // coverage can drift indefinitely with nobody noticing.

  wf.step('escalate-infra', {
    type: 'deterministic',
    dependsOn: ['audit'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
RUN_ID="${RUN_ID}"
${ENV_DEFAULTS}

EXIT_CODE=$(cat "$ARTIFACTS/audit-exit.txt" 2>/dev/null || true)
if [ -z "$EXIT_CODE" ]; then EXIT_CODE="2"; fi

if [ "$EXIT_CODE" != "2" ]; then
  echo "Audit ran (exit $EXIT_CODE) — nothing to escalate."
  exit 0
fi

DETAIL=$(head -c 300 "$ARTIFACTS/audit.txt" 2>/dev/null || true)
if [ -z "$DETAIL" ]; then DETAIL="no audit output"; fi
DETAIL_CLEAN=$(printf '%s' "$DETAIL" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g')

if [ -z "$NIGHTCTO_EVIDENCE_URL" ]; then
  echo "NIGHTCTO_EVIDENCE_URL unset — cannot escalate. Audit failure detail:"
  printf '%s\n' "$DETAIL"
  exit 0
fi

BODY=$(printf '{"schemaVersion":"cloud-runtime-evidence/1","service":"relay-audit-feature-manifest","environment":"%s","version":"unknown","path":"relayflow.audit.manifest","kind":"request_error","outcome":"error","severity":6,"occurredAt":"%s","requestId":"%s","correlationIds":{"ingress":"relayflow"},"summary":"feature manifest audit could not run: %s","errorCode":"audit_unrunnable","inspect":{"logQuery":"%s"}}' \
  "$VERIFY_ENVIRONMENT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID" "$DETAIL_CLEAN" "$ARTIFACTS")

if curl -sS -m 15 -X POST "$NIGHTCTO_EVIDENCE_URL" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $NIGHTCTO_EVIDENCE_TOKEN" \
    -H "x-nightcto-evidence-token: $NIGHTCTO_EVIDENCE_TOKEN" \
    -d "$BODY" >/dev/null 2>&1; then
  echo "escalated audit_unrunnable to NightCTO"
else
  echo "NightCTO escalation POST failed (non-fatal)"
fi
exit 0
`,
  });

  // ── Phase 3: PostHog ─────────────────────────────────────────────────────

  wf.step('emit-posthog', {
    type: 'deterministic',
    dependsOn: ['audit'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
${ENV_DEFAULTS}

if [ -z "$POSTHOG_API_KEY" ]; then
  echo "POSTHOG_API_KEY unset — not emitting"
  exit 0
fi

PROPS=$(node <<'PHEOF'
const fs = require('node:fs');
const artifacts = process.env.AUDIT_ARTIFACTS;
let report = null;
try {
  report = JSON.parse(fs.readFileSync(artifacts + '/audit.json', 'utf8'));
} catch {
  report = null;
}
const exitCode = (() => {
  try {
    return Number(fs.readFileSync(artifacts + '/audit-exit.txt', 'utf8').trim());
  } catch {
    return 2;
  }
})();
process.stdout.write(
  JSON.stringify({
    run_id: process.env.AUDIT_RUN_ID,
    exit_code: exitCode,
    auditable: report?.auditable ?? false,
    ok: report?.ok ?? false,
    manifest_version: report?.manifestVersion ?? null,
    manifest_updated: report?.manifestUpdated ?? null,
    cli_leaves: report?.counts?.cliLeaves ?? null,
    documented_commands: report?.counts?.documentedCommands ?? null,
    mcp_tools: report?.counts?.mcpTools ?? null,
    features: report?.counts?.features ?? null,
    undocumented_commands: (report?.undocumentedCommands ?? []).join(',') || null,
    stale_commands: (report?.staleCommands ?? []).join(',') || null,
    undocumented_mcp: (report?.undocumentedMcp ?? []).join(',') || null,
    stale_mcp: (report?.staleMcp ?? []).join(',') || null,
    drift_count:
      (report?.undocumentedCommands ?? []).length +
      (report?.staleCommands ?? []).length +
      (report?.undocumentedMcp ?? []).length +
      (report?.staleMcp ?? []).length,
  })
);
PHEOF
)

BODY=$(printf '{"api_key":"%s","event":"relay_manifest_audit","distinct_id":"relay-audit-feature-manifest","properties":%s}' \
  "$POSTHOG_API_KEY" "$PROPS")

if curl -sS -m 15 -X POST "$POSTHOG_HOST/capture/" \
    -H 'content-type: application/json' -d "$BODY" >/dev/null 2>&1; then
  echo "emitted relay_manifest_audit"
else
  echo "PostHog emit failed (non-fatal)"
fi
exit 0
`,
  });

  // ── Phase 4: Slack ───────────────────────────────────────────────────────

  wf.step('slack-alert', {
    type: 'deterministic',
    dependsOn: ['audit'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
CHANNEL="${SLACK_CHANNEL}"
${ENV_DEFAULTS}
${SLACK_POST_FN}

EXIT_CODE=$(cat "$ARTIFACTS/audit-exit.txt" 2>/dev/null || true)
if [ -z "$EXIT_CODE" ]; then EXIT_CODE="2"; fi

if [ "$EXIT_CODE" = "0" ]; then
  echo "SLACK_SKIPPED: manifest is clean"
  exit 0
fi

node <<'SLACKEOF' > "$ARTIFACTS/slack-message.txt"
const fs = require('node:fs');
const artifacts = process.env.AUDIT_ARTIFACTS;
const exitCode = Number(fs.readFileSync(artifacts + '/audit-exit.txt', 'utf8').trim());

const lines = [];
if (exitCode === 2) {
  lines.push(':warning: *Feature manifest audit could not run* — ${BT}' + process.env.AUDIT_RUN_ID + '${BT}');
  lines.push('This is harness breakage. Coverage drift is currently undetectable.');
  let detail = '';
  try {
    detail = fs.readFileSync(artifacts + '/audit.txt', 'utf8').slice(0, 500);
  } catch {
    detail = 'no audit output';
  }
  lines.push('${BT}${BT}${BT}');
  lines.push(detail);
  lines.push('${BT}${BT}${BT}');
} else {
  // audit.json is produced by a "|| true" invocation, so it can be missing,
  // empty, or truncated while audit-exit.txt still says 1. Falling over here
  // would leave the message file empty and the surrounding "|| true" would
  // swallow it — drift with no alert.
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(artifacts + '/audit.json', 'utf8'));
  } catch (err) {
    lines.push(':warning: *Feature manifest drifted, but the report is unreadable* — ${BT}' + process.env.AUDIT_RUN_ID + '${BT}');
    lines.push('audit.json could not be parsed: ' + err.message);
    lines.push('Run ${BT}node scripts/audit-feature-manifest.mjs${BT} locally to see the drift.');
    process.stdout.write(lines.join('\n'));
    process.exit(0);
  }
  lines.push(':clipboard: *Feature manifest has drifted* — ${BT}' + process.env.AUDIT_RUN_ID + '${BT}');
  lines.push(
    'manifest ' + r.manifestVersion + ' (updated ' + r.manifestUpdated + ') — ' +
      r.counts.cliLeaves + ' CLI leaves derived, ' + r.counts.documentedCommands + ' documented'
  );
  lines.push('');
  const section = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push('*' + title + '* (' + items.length + ')');
    for (const item of items.slice(0, 20)) lines.push('    • ${BT}' + item + '${BT}');
  };
  section('Undocumented commands — shipping unverified', r.undocumentedCommands);
  section('Stale commands — in manifest, not in CLI', r.staleCommands);
  section('Undocumented MCP tools', r.undocumentedMcp);
  section('Stale MCP tools', r.staleMcp);
  if (r.conditionalMcp && r.conditionalMcp.length > 0) {
    lines.push('');
    lines.push(
      '_Not drift, but unexercised: ' +
        r.conditionalMcp.join(', ') +
        ' are registered conditionally and did not appear in the probe._'
    );
  }
  if (!r.mcpDerivable) {
    lines.push('');
    lines.push(':warning: MCP tool list could not be derived — MCP drift was NOT checked.');
  }
}
process.stdout.write(lines.join('\n'));
SLACKEOF

slack_post "$CHANNEL" "$ARTIFACTS/slack-message.txt" || true
exit 0
`,
  });

  // ── Phase 5: file an issue ───────────────────────────────────────────────

  wf.step('file-issue', {
    type: 'deterministic',
    dependsOn: ['audit'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
AUTOFIX="${AUTOFIX ? '1' : '0'}"
${ENV_DEFAULTS}

EXIT_CODE=$(cat "$ARTIFACTS/audit-exit.txt" 2>/dev/null || true)
if [ "$EXIT_CODE" != "1" ]; then
  echo "ISSUE_SKIPPED: audit exit is '$EXIT_CODE' — only drift (1) files an issue"
  exit 0
fi
if [ "$AUTOFIX" != "1" ]; then
  echo "ISSUE_SKIPPED: AUDIT_AUTOFIX=0"
  exit 0
fi
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "ISSUE_SKIPPED: gh unavailable or unauthenticated"
  exit 0
fi

node <<'ISSUEEOF' > "$ARTIFACTS/issue-body.md"
const fs = require('node:fs');
const artifacts = process.env.AUDIT_ARTIFACTS;
// Same guard as the Slack payload: a truncated audit.json must still produce
// a filed issue, not an empty body swallowed by the gh call.
let r = null;
try {
  r = JSON.parse(fs.readFileSync(artifacts + '/audit.json', 'utf8'));
} catch (err) {
  process.stdout.write(
    'The feature manifest drifted, but the machine-readable report could not be parsed: ' +
      err.message +
      '\n\nRun ${BT}node scripts/audit-feature-manifest.mjs${BT} locally to see the drift.\n'
  );
  process.exit(0);
}

const out = [];
out.push('The feature manifest no longer matches the CLI surface.');
out.push('');
out.push('An undocumented command is an unverified command: the manifest is the');
out.push('input to every feature-verification run, so drift here silently shrinks');
out.push('coverage.');
out.push('');
out.push('- Manifest: ${BT}' + r.manifestVersion + '${BT} (updated ' + r.manifestUpdated + ')');
out.push('- Derived: ' + r.counts.cliLeaves + ' CLI leaves, ' + (r.counts.mcpTools ?? 'n/a') + ' MCP tools');
out.push('- Documented: ' + r.counts.documentedCommands + ' commands, ' + r.counts.documentedMcp + ' MCP tools across ' + r.counts.features + ' features');
out.push('');
const section = (title, items, note) => {
  if (!items || items.length === 0) return;
  out.push('## ' + title);
  out.push('');
  if (note) {
    out.push(note);
    out.push('');
  }
  for (const item of items) out.push('- ${BT}' + item + '${BT}');
  out.push('');
};
section(
  'Undocumented commands',
  r.undocumentedCommands,
  'These exist in the CLI but have no manifest entry, so nothing verifies them.'
);
section(
  'Stale commands',
  r.staleCommands,
  'These are documented but no prefix of them exists in the CLI. Either the command was removed and the entry should go, or it was renamed.'
);
section('Undocumented MCP tools', r.undocumentedMcp);
section(
  'Stale MCP tools',
  r.staleMcp,
  'Documented, and not registered anywhere in the CLI source.'
);
if (r.conditionalMcp && r.conditionalMcp.length > 0) {
  out.push('## Conditionally registered (not drift)');
  out.push('');
  out.push('Registered in source but absent from a default stdio probe, so this run did not exercise them:');
  out.push('');
  for (const item of r.conditionalMcp) out.push('- ${BT}' + item + '${BT}');
  out.push('');
}
out.push('---');
out.push('Filed by ${BT}workflows/audit-feature-manifest.ts${BT}. Reproduce with:');
out.push('');
out.push('${BT}${BT}${BT}bash');
out.push('node scripts/audit-feature-manifest.mjs');
out.push('${BT}${BT}${BT}');
process.stdout.write(out.join('\n'));
ISSUEEOF

ISSUE_URL=$(gh issue create --title "Feature manifest drift: ${RUN_ID}" \
  --body-file "$ARTIFACTS/issue-body.md" 2>&1 | grep -oE 'https://[^ ]+' | head -1 || true)

if [ -n "$ISSUE_URL" ]; then
  echo "$ISSUE_URL" > "$ARTIFACTS/issue-url.txt"
  echo "ISSUE_CREATED: $ISSUE_URL"
else
  echo "ISSUE_FAILED: gh issue create produced no URL"
fi
exit 0
`,
  });

  // ── Phase 6: update the manifest ─────────────────────────────────────────

  wf.step('update-manifest', {
    agent: 'manifest-editor',
    dependsOn: ['file-issue'],
    task: `Bring ${'`.agentworkforce/features/manifest.yaml`'} back in line with the CLI surface.

## FIRST: check whether there is anything to do

Read ${ARTIFACTS}/autofix.env and ${ARTIFACTS}/audit-exit.txt.

- If ${ARTIFACTS}/autofix.env contains \`AUTOFIX=0\`, the operator has disabled
  the fix path. Write "Autofix disabled." to ${ARTIFACTS}/update-summary.md and
  STOP IMMEDIATELY.
- If audit-exit.txt does not contain exactly \`1\`, there is NOTHING to do.
  Write "No drift — nothing to update." to ${ARTIFACTS}/update-summary.md and
  STOP IMMEDIATELY.
- In either case: do not create a branch, edit files, or run commands.
- Only if autofix is enabled AND audit-exit.txt contains \`1\` do you continue.

(The engine has no conditional steps, so this step is scheduled on every run.
The early exit is what keeps an agent away from a clean tree.)

## The task

Read ${REPORT_FILE}. It lists, as JSON:

- \`undocumentedCommands\` — real CLI commands with no manifest entry.
- \`staleCommands\` — manifest entries whose command no longer exists.
- \`undocumentedMcp\` / \`staleMcp\` — the same for MCP tools.
- \`conditionalMcp\` — NOT drift. Registered in source but not exposed by a
  default stdio probe. Leave these alone.

## Hard rules

1. NEVER commit or push to \`main\`. Work on a branch named exactly
   \`${FIX_BRANCH}\`, created from the current HEAD.
2. For each undocumented command, add a manifest entry in the correct existing
   category, matching the surrounding style exactly: \`id\`, \`name\`, \`cli\`
   (with its real argument and option signature, taken from
   \`relay <command> --help\`), \`description\`, \`location\` (the actual source
   file), and \`verify_tier\`.
3. Choose \`verify_tier\` honestly, using the scale documented at the top of the
   manifest. Do not mark something tier 1 to make it look cheap to verify.
4. For stale entries, confirm with \`relay <command> --help\` that the command
   really is gone before removing anything. If it still exists in any form, the
   audit's derivation is wrong — say so and change nothing.
5. Do NOT delete or weaken unrelated manifest entries.
6. Bump the manifest's \`updated:\` field to today's date.

## Verify before you finish

Run both of these and paste the real output:

\`\`\`bash
node scripts/audit-feature-manifest.mjs
npx vitest run .agentworkforce/agents/relay-feature-guardian/manifest-contract.test.ts
\`\`\`

The audit must print MANIFEST_CLEAN and the contract test must pass.

Do NOT edit any file other than the manifest. The integrity gate rejects a
branch that touches CLI sources, the audit script, or
manifest-contract.test.ts — resolving drift by changing what is measured is
exactly what it exists to stop. If the contract test's hardcoded expectation
list needs new entries, say so in your summary and leave it to a human.

## Deliverable

Write ${ARTIFACTS}/update-summary.md with:

- \`Added:\` each new entry and the tier you assigned it, with your reasoning.
- \`Removed:\` each removed entry and the evidence the command is gone.
- \`Evidence:\` the output of both commands above.

Commit on the branch. Do NOT open a pull request — the next step does that.`,
  });

  // ── Phase 7: integrity gate ──────────────────────────────────────────────
  //
  // The audit's own credibility depends on the manifest only ever growing to
  // match reality. An "update" that shrinks documented coverage, or that edits
  // the audit script instead of the manifest, is the failure mode to catch.

  wf.step('update-integrity', {
    type: 'deterministic',
    dependsOn: ['update-manifest'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
MANIFEST=".agentworkforce/features/manifest.yaml"

if grep -q '^AUTOFIX=0$' "$ARTIFACTS/autofix.env" 2>/dev/null; then
  echo "INTEGRITY_NOT_APPLICABLE: autofix disabled, no update was attempted"
  echo "INTEGRITY=not-applicable" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

EXIT_CODE=$(cat "$ARTIFACTS/audit-exit.txt" 2>/dev/null || true)
if [ "$EXIT_CODE" != "1" ]; then
  echo "INTEGRITY_NOT_APPLICABLE: no drift to fix"
  echo "INTEGRITY=not-applicable" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "INTEGRITY_SKIPPED: not a git repository"
  echo "INTEGRITY=skipped" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
if [ "$CURRENT" = "main" ]; then
  echo "INTEGRITY_FAIL: editor left the repo on main"
  echo "INTEGRITY=fail" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

BASE_REF=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || true)
if [ -z "$BASE_REF" ]; then
  echo "INTEGRITY_SKIPPED: no base ref to diff against"
  echo "INTEGRITY=skipped" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

# 'grep -c' exits 1 on zero matches while still printing 0, so the fallback is
# '|| true'; '|| echo 0' would emit a second line and break the comparison.
BEFORE=$(git show "$BASE_REF:$MANIFEST" 2>/dev/null | grep -cE '^      - id: ' || true)
AFTER=$(grep -cE '^      - id: ' "$MANIFEST" 2>/dev/null || true)
if [ -z "$BEFORE" ]; then BEFORE=0; fi
if [ -z "$AFTER" ]; then AFTER=0; fi

echo "Manifest feature entries: $BEFORE -> $AFTER"

# A drift fix may legitimately remove genuinely stale entries, so a small
# decrease is allowed; a large one means the editor deleted real coverage.
STALE_COUNT=$(node -e 'try{const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((r.staleCommands||[]).length+(r.staleMcp||[]).length))}catch(e){process.stdout.write("0")}' "$ARTIFACTS/audit.json" 2>/dev/null || echo 0)
MIN_ALLOWED=$((BEFORE - STALE_COUNT))

if [ "$AFTER" -lt "$MIN_ALLOWED" ]; then
  echo "INTEGRITY_FAIL: manifest dropped to $AFTER entries; only $STALE_COUNT stale entr(ies) justified removal (floor $MIN_ALLOWED)."
  echo "INTEGRITY=fail" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

# An editor can make the audit clean three ways: document the command (wanted),
# delete the command (not wanted), or move the goalposts by editing the audit
# script or its expectation list (not wanted). Only the manifest is allowed to
# change, so assert the whole changed-file set rather than one script.
ALLOWED_CHANGES=".agentworkforce/features/manifest.yaml"
CHANGED=$(git diff --name-only "$BASE_REF" 2>/dev/null || true)
UNEXPECTED=""
for f in $CHANGED; do
  case "$f" in
    "$ALLOWED_CHANGES") ;;
    *) UNEXPECTED="$UNEXPECTED $f" ;;
  esac
done

if [ -n "$UNEXPECTED" ]; then
  echo "INTEGRITY_FAIL: the branch changed files other than the manifest:$UNEXPECTED"
  echo "A manifest sync may only edit the manifest. Changing CLI sources, the audit"
  echo "script, or manifest-contract.test.ts resolves drift by moving what is measured."
  echo "INTEGRITY=fail" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

if [ ! -f "$ARTIFACTS/update-summary.md" ]; then
  echo "INTEGRITY_FAIL: no update-summary.md, so there is no reasoning on record"
  echo "INTEGRITY=fail" > "$ARTIFACTS/update-integrity.env"
  exit 0
fi

# The whole point: after the edit the audit must actually be clean.
if node scripts/audit-feature-manifest.mjs >"$ARTIFACTS/audit-after.txt" 2>&1; then
  echo "INTEGRITY_OK: audit is clean after the update"
  echo "INTEGRITY=ok" > "$ARTIFACTS/update-integrity.env"
else
  echo "INTEGRITY_FAIL: audit still reports drift after the update:"
  tail -20 "$ARTIFACTS/audit-after.txt"
  echo "INTEGRITY=fail" > "$ARTIFACTS/update-integrity.env"
fi

exit 0
`,
  });

  // ── Phase 8: draft PR ────────────────────────────────────────────────────

  wf.step('open-pr', {
    type: 'deterministic',
    dependsOn: ['update-integrity'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"

if [ ! -f "$ARTIFACTS/update-integrity.env" ]; then
  echo "PR_SKIPPED: no integrity result"
  exit 0
fi

. "$ARTIFACTS/update-integrity.env"

if [ "$INTEGRITY" != "ok" ]; then
  echo "PR_SKIPPED: integrity gate returned '$INTEGRITY'"
  exit 0
fi
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "PR_SKIPPED: gh unavailable or unauthenticated"
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ]; then
  echo "PR_SKIPPED: refusing to open a PR from main"
  exit 0
fi

git push -u origin "$BRANCH" 2>&1 | tail -3 || {
  echo "PR_FAILED: could not push $BRANCH"
  exit 0
}

{
  echo "## Feature manifest drift correction"
  echo ""
  echo "Run: ${RUN_ID}"
  echo ""
  if [ -f "$ARTIFACTS/issue-url.txt" ]; then
    echo "Fixes $(cat "$ARTIFACTS/issue-url.txt")"
    echo ""
  fi
  echo "### What drifted"
  echo ""
  echo '${BT}${BT}${BT}'
  cat "$ARTIFACTS/audit.txt" 2>/dev/null || echo "unavailable"
  echo '${BT}${BT}${BT}'
  echo ""
  echo "### Editor summary"
  echo ""
  cat "$ARTIFACTS/update-summary.md" 2>/dev/null || echo "_No summary produced._"
  echo ""
  echo "### Audit after the change"
  echo ""
  echo '${BT}${BT}${BT}'
  cat "$ARTIFACTS/audit-after.txt" 2>/dev/null || echo "unavailable"
  echo '${BT}${BT}${BT}'
  echo ""
  echo "### Review notes"
  echo ""
  echo "- Opened as a **draft** by ${BT}workflows/audit-feature-manifest.ts${BT}. Not auto-merged."
  echo "- The integrity gate confirmed the audit is clean after the change, that the"
  echo "  manifest did not lose unjustified entries, and that the audit script itself"
  echo "  was not modified."
  echo "- Still needs a human on the ${BT}verify_tier${BT} assignments: the gate cannot tell a"
  echo "  correct tier from a convenient one."
} > "$ARTIFACTS/pr-body.md"

PR_URL=$(gh pr create --draft --title "chore: sync feature manifest with CLI surface (${RUN_ID})" \
  --body-file "$ARTIFACTS/pr-body.md" --base main --head "$BRANCH" 2>&1 | grep -oE 'https://[^ ]+' | head -1 || true)

if [ -n "$PR_URL" ]; then
  echo "$PR_URL" > "$ARTIFACTS/pr-url.txt"
  echo "PR_CREATED: $PR_URL"
  if [ -f "$ARTIFACTS/issue-url.txt" ]; then
    gh issue comment "$(cat "$ARTIFACTS/issue-url.txt")" \
      --body "Draft manifest sync PR opened: $PR_URL" >/dev/null 2>&1 || true
  fi
else
  echo "PR_FAILED: gh pr create produced no URL"
fi
exit 0
`,
  });

  // ── Phase 9: enforce ─────────────────────────────────────────────────────
  //
  // Terminal, and the only failing step. Does not depend on the fix chain, so
  // a hiccup while opening a PR cannot swallow the drift signal.

  wf.step('enforce', {
    type: 'deterministic',
    dependsOn: ['slack-alert', 'emit-posthog', 'escalate-infra'],
    captureOutput: true,
    failOnError: true,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
EXIT_CODE=$(cat "$ARTIFACTS/audit-exit.txt" 2>/dev/null || true)
if [ -z "$EXIT_CODE" ]; then EXIT_CODE="2"; fi

case "$EXIT_CODE" in
  0)
    echo "ENFORCE: manifest is clean"
    exit 0
    ;;
  1)
    echo "ENFORCE: manifest drift — see the issue and draft PR"
    exit 1
    ;;
  *)
    echo "ENFORCE: audit could not run (exit $EXIT_CODE) — escalated to NightCTO"
    exit 2
    ;;
esac
`,
  });

  const result = await wf.run();

  if (process.env.DRY_RUN || !('status' in result)) {
    return;
  }

  // Make the process exit code tell the truth, the same way verify-features
  // does: a scheduler must be able to see drift without reading logs.
  const exitFile = `${ARTIFACTS}/audit-exit.txt`;
  if (!existsSync(exitFile)) {
    console.error(
      `[audit-feature-manifest] no ${exitFile} — the audit step did not complete. ` +
        `Treating as harness breakage.`
    );
    process.exitCode = 2;
    return;
  }

  const auditExit = Number(readFileSync(exitFile, 'utf8').trim());
  let report: { undocumentedCommands?: string[]; staleCommands?: string[] } | null = null;
  if (existsSync(REPORT_FILE)) {
    try {
      report = JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
    } catch {
      report = null;
    }
  }

  if (auditExit === 0) {
    console.log('[audit-feature-manifest] manifest is clean');
    return;
  }

  if (auditExit === 1) {
    const undocumented = report?.undocumentedCommands ?? [];
    const stale = report?.staleCommands ?? [];
    console.error(
      `[audit-feature-manifest] DRIFT: ${undocumented.length} undocumented, ${stale.length} stale. ` +
        `Undocumented commands are unverified commands.`
    );
    process.exitCode = 1;
    return;
  }

  console.error(`[audit-feature-manifest] the audit could not run (exit ${auditExit})`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(
    `[audit-feature-manifest] harness failure: ${err instanceof Error ? err.stack : String(err)}`
  );
  process.exitCode = 2;
});
