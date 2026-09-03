#!/usr/bin/env bash

# Production implementation of the verify-features primary Slack step. Keeping
# this executable outside the workflow template lets the PR proof run the exact
# delivery-to-receipt branch instead of inferring it from source text.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS_TOOL="$SCRIPT_DIR/escalation-status.mjs"
SLACK_POST_TOOL="$SCRIPT_DIR/slack-post.mjs"
ARTIFACTS="${VERIFY_ARTIFACTS:?VERIFY_ARTIFACTS is required}"
RUN_ID="${VERIFY_RUN_ID:?VERIFY_RUN_ID is required}"
CHANNEL="${VERIFY_SLACK_CHANNEL-C0AEKNLDNKW}"

CLOUD_API_URL="${CLOUD_API_URL:-}"
CLOUD_API_TOKEN="${CLOUD_API_TOKEN:-${RELAY_CLOUD_API_TOKEN:-${CLOUD_API_ACCESS_TOKEN:-}}}"
export CLOUD_API_URL CLOUD_API_TOKEN

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
    "no verdict.json to report"
  echo "SLACK_FAILED: no verdict.json to report"
  exit 0
fi

if ! VERDICT=$(node - "$ARTIFACTS/verdict.json" <<'VERDICTEOF'
const fs = require('node:fs');
const verdict = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
if (
  !verdict ||
  typeof verdict !== 'object' ||
  typeof verdict.runId !== 'string' ||
  verdict.runId.length === 0 ||
  !['PASS', 'FAIL'].includes(verdict.verdict) ||
  !verdict.provenance ||
  typeof verdict.provenance !== 'object' ||
  !verdict.totals ||
  !count(verdict.totals.pass) ||
  !count(verdict.totals.fail) ||
  !count(verdict.totals.skip) ||
  !verdict.tiers ||
  typeof verdict.tiers !== 'object' ||
  Array.isArray(verdict.tiers) ||
  !Array.isArray(verdict.tiersNotRun) ||
  !verdict.tiersNotRun.every((tier) => typeof tier === 'string') ||
  Object.values(verdict.tiers).some(
    (tier) =>
      !tier ||
      typeof tier !== 'object' ||
      !count(tier.pass) ||
      !count(tier.fail) ||
      !count(tier.skip) ||
      !Array.isArray(tier.failures) ||
      tier.failures.some(
        (failure) =>
          !failure ||
          typeof failure !== 'object' ||
          typeof failure.check !== 'string' ||
          typeof failure.reason !== 'string'
      )
  )
) {
  throw new Error('verdict.json does not satisfy the alert contract');
}
process.stdout.write(verdict.verdict);
VERDICTEOF
); then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
    "verdict.json is malformed or missing required alert fields"
  echo "SLACK_FAILED: verdict.json is malformed or incomplete"
  exit 0
fi
if [ "$VERDICT" = "PASS" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary not_applicable \
    "verdict is PASS"
  echo "SLACK_NOT_APPLICABLE: verdict is PASS — not alerting"
  exit 0
fi

node <<'SLACKEOF' > "$ARTIFACTS/slack-message.txt"
const fs = require('node:fs');
const artifacts = process.env.VERIFY_ARTIFACTS;
const v = JSON.parse(fs.readFileSync(artifacts + '/verdict.json', 'utf8'));

const lines = [];
lines.push(':rotating_light: *Feature verification FAILED* — `' + v.runId + '`');
lines.push(
  'CLI ' +
    (v.provenance.VERIFY_CLI_VERSION || '?') +
    ' / repo ' +
    (v.provenance.VERIFY_REPO_VERSION || '?') +
    ' @ ' +
    (v.provenance.VERIFY_GIT_SHA || '?')
);
lines.push(
  v.totals.pass + ' passed, *' + v.totals.fail + ' failed*, ' + v.totals.skip + ' skipped'
);
lines.push('');
for (const [tier, bucket] of Object.entries(v.tiers)) {
  const total = bucket.pass + bucket.fail + bucket.skip;
  const state = total === 0 ? 'NOT_RUN' : bucket.fail > 0 ? 'FAIL' : 'PASS';
  lines.push(
    '• `' + tier + '` ' + state + ' — ' + bucket.pass + 'p/' + bucket.fail + 'f/' + bucket.skip + 's'
  );
  for (const failure of bucket.failures.slice(0, 5)) {
    lines.push('    ↳ ' + failure.check + ': ' + String(failure.reason).slice(0, 180));
  }
}
if (v.tiersNotRun.length > 0) {
  lines.push('');
  lines.push('*Tiers that produced no records:* ' + v.tiersNotRun.join(', '));
}
lines.push('');
lines.push('Artifacts: `' + artifacts + '`');
process.stdout.write(lines.join('\n'));
SLACKEOF

{
  echo ""
  node "$STATUS_TOOL" render-initial "$ARTIFACTS"
} >> "$ARTIFACTS/slack-message.txt"

node "$STATUS_TOOL" redact-file "$ARTIFACTS/slack-message.txt"
SLACK_POSTED=0
if [ -z "$CHANNEL" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
    "VERIFY_SLACK_CHANNEL is unset; no destination was assumed"
elif node "$SLACK_POST_TOOL" "$CHANNEL" "$ARTIFACTS/slack-message.txt"; then
  SLACK_POSTED=1
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary delivered \
    "failure alert posted to $CHANNEL"
else
  echo "SLACK_UNDELIVERED to $CHANNEL — payload follows:"
  echo "---- undelivered Slack payload ----"
  cat "$ARTIFACTS/slack-message.txt"
  echo "---- end payload ----"
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
    "failure alert could not be posted to $CHANNEL"
fi

if [ -n "$CHANNEL" ]; then
  if ! node "$STATUS_TOOL" envelope "$ARTIFACTS" primary "$RUN_ID" "$CHANNEL" \
    "$ARTIFACTS/slack-message.txt" slack_primary; then
    if [ "$SLACK_POSTED" -ne 1 ]; then
      node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
        "failure alert and fallback envelope could not be delivered for $CHANNEL"
    fi
    echo "ALERT_ENVELOPE_FAILED: primary envelope write failed"
  fi
else
  echo "ALERT_ENVELOPE_FAILED: VERIFY_SLACK_CHANNEL is required"
fi

# Delivery failures are enforced by the channel leaf gate. This step remains
# zero so sibling escalation/reporting work is not pruned from the DAG.
exit 0
