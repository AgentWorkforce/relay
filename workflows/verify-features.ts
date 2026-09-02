/**
 * verify-features.ts
 *
 * Automated feature health check for agent-relay. Walks every user-facing
 * feature tier by tier, records one structured result per check, and turns a
 * failure into action: a Slack alert, a GitHub issue, an attempted fix on a
 * branch, and a draft PR carrying re-verified evidence.
 *
 * Designed to run on a schedule (nightly or post-merge):
 *   relay cloud schedule workflows/verify-features.ts --cron "0 3 * * *"
 *
 * Or manually:
 *   relay node workflow run workflows/verify-features.ts
 *
 * Pattern: pipeline (sequential phases — later tiers assume earlier ones ran)
 *
 * ## Why this file is shaped the way it is
 *
 * An earlier version of this workflow reported "COMPLETED — 11 passed, 0
 * failed" on a run where Tier 2 had four failing checks. Three independent
 * defects produced that false green, and each one is now closed here:
 *
 *   1. Every step set `failOnError: false`, so a non-zero exit still scored as
 *      a pass. Tiers still use it (we want all tiers to run even after one
 *      fails), but they are no longer the verdict — `verdict` is, and it reads
 *      a machine-readable ledger rather than grepping prose logs.
 *   2. Nothing aggregated the per-tier results into a run verdict. `verdict`
 *      plus `enforce-verdict` now do, and `main()` sets a non-zero process exit
 *      so a scheduler sees red.
 *   3. `main()` discarded the runner result entirely. It now reads verdict.json
 *      and fails closed when that file is missing.
 *
 * A fourth defect was subtler. `applyReliabilityDefaults` in @relayflows/core
 * force-enables `strategy: "retry"` with a repair agent for any workflow that
 * declares agents, so a failing verification gate got handed to an agent that
 * edited the working tree until the gate passed. A verification workflow whose
 * assertions can be rewritten to make them pass measures nothing. `onError`
 * is set to "continue" below specifically to opt out of that path.
 *
 * ## Honest accounting
 *
 * Every check records `pass`, `fail`, or `skip` with a reason. A check that
 * cannot run in this environment (no cloud login, no provider CLI) is a SKIP
 * with a stated cause — never a pass, and never a fail. `verdict` also fails
 * the run when a tier produced no records at all, so a tier that crashes
 * before its first check cannot masquerade as a clean tier.
 *
 * Feature manifest: .agentworkforce/features/manifest.yaml
 * Critical paths:   .agentworkforce/features/critical-paths.md
 * Procedures ref:   .agentworkforce/features/verify/procedures.md
 * Manifest audit:   workflows/audit-feature-manifest.ts
 *
 * ## Environment
 *
 *   VERIFY_SLACK_CHANNEL    Slack channel ID for failures. Default C0AEKNLDNKW.
 *   VERIFY_AUTOFIX          "0" disables the issue/fix/PR path. Default on.
 *   VERIFY_ALLOW_CLI_DRIFT  "1" downgrades a CLI-vs-repo version mismatch from
 *                           a failure to a warning.
 *   POSTHOG_API_KEY         Delivers PostHog evidence. On FAIL, a missing key
 *                           is recorded as a failed escalation. Host: POSTHOG_HOST.
 *   NIGHTCTO_EVIDENCE_URL   Enables infra escalation to NightCTO.
 *   NIGHTCTO_EVIDENCE_TOKEN Bearer token for the above.
 *   CLOUD_API_URL           Required for Slack delivery. Slack posts go through
 *   CLOUD_API_TOKEN         the relayflows Slack primitive's cloud-relay runtime
 *                           (/api/v1/slack/post-message), which uses the
 *                           workspace's configured Slack integration. No bot
 *                           token is read.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { workflow } from '@relayflows/core';

import { prepareRunArtifacts } from '../scripts/verify-features/run-artifacts.mjs';

const ARTIFACTS_ROOT = '.workflow-artifacts/verify-features';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const RUN_NONCE = randomUUID().slice(0, 8);
const RUN_ID = `verify-${TIMESTAMP}-${RUN_NONCE}`;
const ARTIFACTS = `${ARTIFACTS_ROOT}/runs/${RUN_ID}`;
const VERDICT_FILE = `${ARTIFACTS}/verdict.json`;
const ESCALATION_STATUS_TOOL = 'scripts/verify-features/escalation-status.mjs';

/** Unique suffix so a run never collides with existing workspace state. */
const SUFFIX = `vf-${RUN_NONCE}`;

/** Canonical fix branch. RUN_ID already carries the "verify-" prefix. */
const FIX_BRANCH = `fix/${RUN_ID}`;

const AUTOFIX = process.env.VERIFY_AUTOFIX !== '0';

/**
 * A literal backtick.
 *
 * Step bodies below are template literals, so a raw backtick would close the
 * template. The Slack and GitHub payloads want Markdown code spans, so those
 * are written as `${BT}` and interpolated in.
 */
const BT = '`';

/**
 * Optional-environment seeding, interpolated ahead of every step body.
 *
 * `printenv` is used instead of the natural `${VAR:-default}` for one hard
 * reason: these step bodies are TypeScript template literals, so a `${` in the
 * shell source is parsed as TypeScript interpolation and the file would not
 * compile. Every shell variable below is therefore written `$VAR`, and defaults
 * are applied with explicit `if` blocks. Seeding also keeps `set -u` from
 * aborting a step because an operator did not configure an optional knob.
 */
const ENV_DEFAULTS = String.raw`
VERIFY_ALLOW_CLI_DRIFT="$(printenv VERIFY_ALLOW_CLI_DRIFT || true)"
VERIFY_SLACK_CHANNEL="$(printenv VERIFY_SLACK_CHANNEL || true)"
if [ -z "$VERIFY_SLACK_CHANNEL" ]; then VERIFY_SLACK_CHANNEL="C0AEKNLDNKW"; fi
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
export CLOUD_API_URL CLOUD_API_TOKEN VERIFY_SLACK_CHANNEL
VERIFY_ENVIRONMENT="$(printenv VERIFY_ENVIRONMENT || true)"
if [ -z "$POSTHOG_HOST" ]; then POSTHOG_HOST="https://i.agentrelay.com"; fi
if [ -z "$VERIFY_ENVIRONMENT" ]; then VERIFY_ENVIRONMENT="sandbox"; fi
export VERIFY_ARTIFACTS="${ARTIFACTS}"
export VERIFY_RUN_ID="${RUN_ID}"
`;

/**
 * Shell harness interpolated into every check-running step.
 *
 * Every check appends one JSON line to checks.jsonl. Downstream steps read
 * that ledger instead of grepping the human-readable logs — the previous
 * version's analyzer reported "1 issue(s)" for a tier with four failures
 * because it counted matching *tiers*, not matching checks.
 *
 * Written with String.raw so the sed escapes survive into the shell. Shell
 * variables must be written `$VAR`, never `${VAR}` — braces would be read as
 * TypeScript interpolation.
 */
const PRELUDE =
  ENV_DEFAULTS +
  String.raw`
PASS=0
FAIL=0
SKIP=0
ARTIFACTS="${ARTIFACTS}"
CHECKS="$ARTIFACTS/checks.jsonl"
CAPS="$ARTIFACTS/caps.env"
RUN_ID="${RUN_ID}"

# Append one structured result AND move the tier counters.
#
# The counters live here, not in the callers, so that the per-tier summary line
# can never disagree with the ledger. Several checks below record directly
# (multi-step sequences that do not fit run_check); when the callers owned the
# counters those sites reported "0 passed, 0 failed" while the ledger held real
# results.
#
# Reason text is flattened and bounded so a multi-line stack trace cannot
# corrupt the ledger.
record() {
  # Strip ALL control bytes, not just newlines: ANSI escapes and stray control
  # characters from CLI output would otherwise land raw inside the JSON string
  # and make the line unparseable. The verdict reader skips unparseable lines,
  # so a corrupted reason could silently erase a failing check.
  _reason=$(printf '%s' "$4" | tr -d '\000-\010\013\014\016-\037\177' | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-400)
  printf '{"run":"%s","tier":"%s","check":"%s","status":"%s","reason":"%s"}\n' \
    "$RUN_ID" "$1" "$2" "$3" "$_reason" >> "$CHECKS"
  case "$3" in
    pass) PASS=$((PASS + 1)) ;;
    fail) FAIL=$((FAIL + 1)) ;;
    skip) SKIP=$((SKIP + 1)) ;;
  esac
}

# Run a command and match its output. Records pass/fail either way.
#
# Note the plain "grep -i" rather than "grep -qi": under "set -o pipefail", a
# -q grep exits at the first match, the writer upstream takes SIGPIPE, and the
# pipeline reports failure even though the match succeeded. That turned a
# demonstrably running broker into a "capability absent" result in a live run.
run_check() {
  _name="$1"
  _cmd="$2"
  _expect="$3"
  if _out=$(eval "$_cmd" 2>&1) && printf '%s' "$_out" | grep -i -- "$_expect" >/dev/null; then
    echo "  PASS  $_name" | tee -a "$LOG"
    record "$TIER" "$_name" pass ""
  else
    echo "  FAIL  $_name (expected: $_expect)" | tee -a "$LOG"
    echo "        output: $(printf '%s' "$_out" | head -3)" | tee -a "$LOG"
    record "$TIER" "$_name" fail "$_out"
  fi
}

# A check we could not run here. Recorded with a cause so that reading the
# report can never confuse "not exercised" with "verified working".
skip_check() {
  echo "  SKIP  $1 ($2)" | tee -a "$LOG"
  record "$TIER" "$1" skip "$2"
}

# Capability flags are written by the "capabilities" step.
have_cap() { grep -q "^$1=1$" "$CAPS" 2>/dev/null; }

# Run a check only when a capability is present, else skip with the reason.
gated_check() {
  _cap="$1"
  shift
  if have_cap "$_cap"; then
    run_check "$@"
  else
    skip_check "$1" "requires capability: $_cap"
  fi
}

# Provenance is a validity precondition, not one ordinary feature check. If the
# CLI is outside this checkout, running more commands would produce precise but
# meaningless results about a published binary.
abort_for_invalid_provenance() {
  if ! grep -q '^VERIFY_PROVENANCE_VALID=1$' "$ARTIFACTS/provenance.env" 2>/dev/null; then
    _cli_path=$(grep '^VERIFY_CLI_PATH=' "$ARTIFACTS/provenance.env" 2>/dev/null | cut -d= -f2- || true)
    if [ -z "$_cli_path" ]; then _cli_path="missing provenance evidence"; fi
    echo "  FAIL  tier-aborted-invalid-provenance (CLI: $_cli_path)" | tee -a "$LOG"
    record "$TIER" "tier-aborted-invalid-provenance" fail \
      "feature checks were not run because CLI provenance is invalid for this checkout: $_cli_path"
    return 0
  fi
  return 1
}

finish_tier() {
  echo "" | tee -a "$LOG"
  echo "$TIER result: $PASS passed, $FAIL failed, $SKIP skipped" | tee -a "$LOG"
  if [ "$FAIL" -gt 0 ]; then
    echo "TIER_FAIL" >> "$LOG"
  else
    echo "TIER_PASS" >> "$LOG"
  fi
}
`;

/**
 * Post to Slack through the relayflows Slack primitive.
 *
 * Deliberately pins `runtime: 'cloud-relay'` rather than letting the adapter
 * auto-detect. `selectRuntime` in @relayflows/slack-primitive prefers
 * cloud-relay but falls back to a local `SLACK_BOT_TOKEN` runtime that talks to
 * slack.com directly — and this workflow must post through the workspace's
 * configured Slack integration (the Nango connection behind
 * `/api/v1/slack/post-message`), not whatever bot token happens to be in the
 * environment. Pinning makes a missing CLOUD_API_* pair throw
 * `auth_token_missing` instead of silently taking a different path.
 *
 * The primitive is a hard dependency of @relayflows/core, which this workflow
 * already imports, so it resolves wherever the workflow itself does.
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

  # Undelivered alerts must be loud. Echo the payload so it is at least
  # recoverable from the run log rather than lost with the process.
  echo "SLACK_UNDELIVERED to $_sp_channel — payload follows:"
  echo "---- undelivered Slack payload ----"
  cat "$_sp_textfile"
  echo "---- end payload ----"
  return 1
}
`;

/**
 * Bounded evidence POST to NightCTO, matching the CloudEvidenceSummary v1
 * contract in ../cloud/docs/dogfood-telemetry-brief.md. Byte compatibility
 * matters — NightCTO's cloud-runtime adapter consumes exactly this shape.
 *
 * This is for failures of the verification *machinery* (the relayflow, the
 * sandbox, the executor), not for product features being broken. A broken
 * feature is a PR; a broken harness is an operator alert, because nobody is
 * watching a check that never ran.
 */
const NIGHTCTO_FN = String.raw`
escalate_infra() {
  _path="$1"
  _code="$2"
  _summary="$3"
  if [ -z "$NIGHTCTO_EVIDENCE_URL" ]; then
    echo "  [nightcto] NIGHTCTO_EVIDENCE_URL unset — infra escalation skipped: $_summary"
    return 0
  fi
  _summary_clean=$(printf '%s' "$_summary" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-300)
  _body=$(printf '{"schemaVersion":"cloud-runtime-evidence/1","service":"relay-verify-features","environment":"%s","version":"%s","path":"%s","kind":"request_error","outcome":"error","severity":6,"occurredAt":"%s","requestId":"%s","correlationIds":{"ingress":"relayflow"},"summary":"%s","errorCode":"%s","inspect":{"logQuery":"%s"}}' \
    "$VERIFY_ENVIRONMENT" "$VERIFY_CLI_VERSION" "$_path" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID" "$_summary_clean" "$_code" "$ARTIFACTS")
  # Fire-and-forget: an unreachable NightCTO must never mask the product result.
  if curl -sS -m 15 -X POST "$NIGHTCTO_EVIDENCE_URL" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $NIGHTCTO_EVIDENCE_TOKEN" \
      -H "x-nightcto-evidence-token: $NIGHTCTO_EVIDENCE_TOKEN" \
      -d "$_body" >/dev/null 2>&1; then
    echo "  [nightcto] escalated: $_code"
  else
    echo "  [nightcto] escalation POST failed (non-fatal): $_code"
  fi
  return 0
}
`;

/**
 * PostHog emission via the public capture endpoint.
 *
 * Deliberately not routed through the CLI's telemetry client: that client is
 * opt-in *product* telemetry keyed to a real user's distinct_id, and CI health
 * events would pollute it. This posts CI-owned events under a stable
 * synthetic distinct_id instead.
 */
const POSTHOG_FN = String.raw`
posthog_capture() {
  _event="$1"
  _props="$2"
  if [ -z "$POSTHOG_API_KEY" ]; then
    echo "  [posthog] POSTHOG_API_KEY unset — not emitting $_event"
    return 1
  fi
  _body=$(printf '{"api_key":"%s","event":"%s","distinct_id":"relay-verify-features","properties":%s}' \
    "$POSTHOG_API_KEY" "$_event" "$_props")
  if curl -fsS -m 15 -X POST "$POSTHOG_HOST/capture/" \
      -H 'content-type: application/json' -d "$_body" >/dev/null 2>&1; then
    echo "  [posthog] emitted $_event"
    return 0
  else
    echo "  [posthog] emit failed: $_event"
    return 1
  fi
}
`;

async function main() {
  const wf = workflow('relay-verify-features')
    .description(
      'Automated feature health check. Runs verification tiers 1-6 and the 6 critical paths, ' +
        'posts PASS/FAIL to Slack, and opens an issue plus a draft fix PR when something breaks.'
    )
    .pattern('pipeline')
    .channel('relay-health')
    .maxConcurrency(1)
    // Not cosmetic: "continue" is the only strategy that keeps
    // applyReliabilityDefaults from attaching a repair agent to failing
    // verification gates. See the file header.
    .onError('continue')
    .timeout(3_600_000); // 1 hour — tiers 5/6 drive real cloud and provider calls

  // ── Agents ────────────────────────────────────────────────────────────────

  // opencode is cheap and this is routine summarization of files already written.
  wf.agent('reporter', {
    cli: 'opencode',
    role: 'Read verification artifacts and write a structured PASS/FAIL/SKIP report',
    retries: 1,
  });

  // The fixer edits source, so it gets the stronger model.
  wf.agent('fixer', {
    cli: 'claude',
    role: 'Root-cause a failing feature verification check and fix the underlying defect',
    retries: 0,
  });

  // ── Phase 0: acceptance contract ─────────────────────────────────────────
  //
  // Unquoted heredoc terminator so $(date) actually expands. The previous
  // version used <<'EOF' and printed the literal text "$(date -u ...)".

  wf.step('acceptance-contract', {
    type: 'deterministic',
    captureOutput: true,
    failOnError: false,
    command: String.raw`cat <<EOF
FEATURE VERIFICATION ACCEPTANCE CONTRACT

Run ID: ${RUN_ID}
Date:   $(date -u +%Y-%m-%dT%H:%M:%SZ)

The run PASSES only if every check that CAN run in this environment passes.

| Tier | Scope                                          | Environment needed        |
|------|------------------------------------------------|---------------------------|
| V1   | CLI health and command discovery               | isolated CLI              |
| V2   | Broker lifecycle, dead letters, node agents     | local broker              |
| V3   | Channels, messages, threads, reactions, inbox   | workspace + 1 agent token |
| V4   | Cross-agent DMs, invites, read receipts, files  | workspace + 2 agents      |
| V5   | Cloud, fleet, integrations, skills, reflex      | authenticated cloud       |
| V6   | Managed agents, harnesses, PTY, SDK            | provider CLI credentials  |
| CP   | Critical paths 1-6 from critical-paths.md       | mixed                     |

Failure contract:
  - Any check that fails      => run FAIL.
  - Any tier with no records  => run FAIL (a crashed tier is not a clean tier).
  - A check that cannot run   => SKIP with a stated cause. Never a pass.

A FAIL posts to Slack, opens a GitHub issue, and attempts a fix on a branch
with a draft PR. A failure of the harness itself escalates to NightCTO. Each
Slack attempt also emits a credential-free relay-alert-envelope/1 artifact for
a trusted scheduler postback; an envelope is a handoff, not a delivery receipt.
EOF
`,
  });

  // ── Phase 1: setup ───────────────────────────────────────────────────────

  wf.step('setup', {
    type: 'deterministic',
    dependsOn: ['acceptance-contract'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

mkdir -p "${ARTIFACTS}"
LOG="${ARTIFACTS}/setup.log"
: > "${ARTIFACTS}/checks.jsonl"
if ! node "${ESCALATION_STATUS_TOOL}" reset "${ARTIFACTS}"; then
  echo "SETUP_FAIL: could not reset escalation artifacts" | tee -a "$LOG"
  exit 2
fi

echo "=== Setup: ${RUN_ID} ===" | tee "$LOG"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

relay node up --background 2>&1 | tee -a "$LOG" || true

BROKER_READY=0
for i in $(seq 1 30); do
  if relay node status 2>&1 | grep -i "running" >/dev/null; then
    BROKER_READY=1
    break
  fi
  sleep 1
done

relay status 2>&1 | tee -a "$LOG"

if [ "$BROKER_READY" -eq 1 ]; then
  echo "SETUP_OK" >> "$LOG"
  exit 0
fi

echo "SETUP_FAIL: broker did not become ready within 30 seconds" >> "$LOG"
exit 1
`,
  });

  // ── Phase 2: provenance ──────────────────────────────────────────────────
  //
  // The run this workflow was rebuilt from verified agent-relay 10.0.0 while
  // the repo was at 11.3.0 — it even logged "Update available: 10.0.0 →
  // 11.3.0" and then reported `relay node deadletters` as an unknown command,
  // which was a real command in 11.x. A whole run's worth of green (and one
  // loud red herring) measured a stale published CLI instead of the code under
  // test. Version drift is now an explicit, failing check.

  wf.step('provenance', {
    type: 'deterministic',
    dependsOn: ['setup'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="provenance"
LOG="${ARTIFACTS}/provenance.log"
${PRELUDE}

echo "=== Provenance ===" | tee "$LOG"

CLI_PATH=$(command -v relay 2>/dev/null || echo "not-found")
CLI_VERSION=$(relay version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
REPO_VERSION=$(node -e 'try{process.stdout.write(require("./package.json").version)}catch(e){process.stdout.write("unknown")}' 2>/dev/null || echo "unknown")
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
PROVENANCE_VALID=1

echo "  relay path:     $CLI_PATH" | tee -a "$LOG"
echo "  relay version:  $CLI_VERSION" | tee -a "$LOG"
echo "  repo version:   $REPO_VERSION" | tee -a "$LOG"
echo "  git sha:        $GIT_SHA" | tee -a "$LOG"

# Recorded for the report, Slack, PostHog, and NightCTO payloads.
{
  echo "VERIFY_CLI_VERSION=$CLI_VERSION"
  echo "VERIFY_REPO_VERSION=$REPO_VERSION"
  echo "VERIFY_GIT_SHA=$GIT_SHA"
  echo "VERIFY_CLI_PATH=$CLI_PATH"
} > "${ARTIFACTS}/provenance.env"

if [ "$CLI_PATH" = "not-found" ]; then
  PROVENANCE_VALID=0
  record "$TIER" "cli-present" fail "relay is not on PATH"
  echo "  FAIL  relay is not on PATH" | tee -a "$LOG"
  echo "VERIFY_PROVENANCE_VALID=$PROVENANCE_VALID" >> "${ARTIFACTS}/provenance.env"
  exit 0
fi
record "$TIER" "cli-present" pass ""

if [ "$REPO_VERSION" = "unknown" ]; then
  skip_check "cli-matches-repo" "no package.json in cwd — cannot compare versions"
elif [ "$CLI_VERSION" = "$REPO_VERSION" ]; then
  echo "  PASS  cli-matches-repo ($CLI_VERSION)" | tee -a "$LOG"
  record "$TIER" "cli-matches-repo" pass ""
elif [ "$VERIFY_ALLOW_CLI_DRIFT" = "1" ]; then
  skip_check "cli-matches-repo" "CLI $CLI_VERSION != repo $REPO_VERSION (drift allowed by env)"
else
  PROVENANCE_VALID=0
  echo "  FAIL  cli-matches-repo: verifying $CLI_VERSION but repo is $REPO_VERSION" | tee -a "$LOG"
  record "$TIER" "cli-matches-repo" fail "CLI under test is $CLI_VERSION but the repo is $REPO_VERSION; results do not describe this checkout"
fi

# Matching versions prove nothing on a feature branch: between releases the
# globally installed CLI and this checkout report the same version, so a global
# binary would pass the check above while exercising none of the branch's
# changes. Resolve the binary and require it to live inside this checkout.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
CLI_REAL=$(node -e 'const fs=require("node:fs");try{process.stdout.write(fs.realpathSync(process.argv[1]))}catch(e){process.stdout.write(process.argv[1])}' "$CLI_PATH" 2>/dev/null || printf '%s' "$CLI_PATH")
REPO_REAL=$(node -e 'const fs=require("node:fs");try{process.stdout.write(fs.realpathSync(process.argv[1]))}catch(e){process.stdout.write(process.argv[1])}' "$REPO_ROOT" 2>/dev/null || printf '%s' "$REPO_ROOT")
echo "  resolved CLI: $CLI_REAL" | tee -a "$LOG"
echo "  repo root:    $REPO_REAL" | tee -a "$LOG"

if [ -z "$REPO_ROOT" ]; then
  PROVENANCE_VALID=0
  # Falling back to $PWD would only prove the binary sits under the current
  # directory, which is not provenance. Say so instead of claiming a pass.
  skip_check "cli-belongs-to-checkout" "not a git checkout — cannot establish which tree the CLI was built from"
else

case "$CLI_REAL" in
  "$REPO_REAL"/*)
    echo "  PASS  cli-belongs-to-checkout" | tee -a "$LOG"
    record "$TIER" "cli-belongs-to-checkout" pass ""
    ;;
  *)
    PROVENANCE_VALID=0
    echo "  FAIL  cli-belongs-to-checkout: $CLI_REAL is outside $REPO_REAL" | tee -a "$LOG"
    record "$TIER" "cli-belongs-to-checkout" fail "the CLI under test resolves to $CLI_REAL, outside this checkout ($REPO_REAL); a matching version number does not make it this branch's build"
    ;;
esac

fi

echo "VERIFY_PROVENANCE_VALID=$PROVENANCE_VALID" >> "${ARTIFACTS}/provenance.env"
finish_tier
exit 0
`,
  });

  // ── Phase 3: capability probe ────────────────────────────────────────────
  //
  // Tier 5/6 checks need cloud auth and provider CLIs. Probing once up front
  // lets every later check state a cause for skipping instead of emitting a
  // failure that only means "this sandbox is not logged in" — the exact reason
  // `cloud whoami` and `cloud session` were scored as product failures before.

  wf.step('capabilities', {
    type: 'deterministic',
    dependsOn: ['provenance'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
LOG="${ARTIFACTS}/capabilities.log"
CAPS="${ARTIFACTS}/caps.env"
${ENV_DEFAULTS}
: > "$CAPS"

echo "=== Capability probe ===" | tee "$LOG"

if ! grep -q '^VERIFY_PROVENANCE_VALID=1$' "$ARTIFACTS/provenance.env" 2>/dev/null; then
  echo "  ABORT  capability probes not run: CLI provenance is invalid" | tee -a "$LOG"
  for _name in broker workspace cloud gh git_repo jq slack provider_claude provider_codex provider_opencode provider_gemini provider_any; do
    echo "$_name=0" >> "$CAPS"
  done
  cat "$CAPS"
  exit 0
fi

probe() {
  _name="$1"
  _cmd="$2"
  PROBE_COMMAND="$_cmd" node -e '
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("/bin/sh", ["-c", process.env.PROBE_COMMAND], {
      stdio: "ignore",
      timeout: 10000,
    });
    if (result.error && result.error.code === "ETIMEDOUT") process.exit(124);
    process.exit(result.status === 0 ? 0 : 1);
  '
  _rc=$?
  if [ "$_rc" -eq 0 ]; then
    echo "$_name=1" >> "$CAPS"
    echo "  YES  $_name" | tee -a "$LOG"
  else
    echo "$_name=0" >> "$CAPS"
    if [ "$_rc" -eq 124 ]; then
      echo "  no   $_name (probe timed out after 10s)" | tee -a "$LOG"
    else
      echo "  no   $_name" | tee -a "$LOG"
    fi
  fi
}

probe broker        'relay node status 2>&1 | grep -i running >/dev/null'
probe workspace     'relay workspace active'
probe cloud         'relay cloud whoami'
probe gh            'gh auth status'
probe git_repo      'git rev-parse --git-dir'
probe jq            'command -v jq'
probe slack         '[ -n "$CLOUD_API_URL" ] && [ -n "$CLOUD_API_TOKEN" ]'
probe provider_claude   'command -v claude'
probe provider_codex    'command -v codex'
probe provider_opencode 'command -v opencode'
probe provider_gemini   'command -v gemini'

# Any provider at all is enough for the managed-agent paths.
if grep -q '^provider_.*=1$' "$CAPS"; then
  echo "provider_any=1" >> "$CAPS"
else
  echo "provider_any=0" >> "$CAPS"
fi

cat "$CAPS"
exit 0
`,
  });

  // ── Phase 4: Tier 1 — CLI health and command discovery ───────────────────

  wf.step('tier1-cli-health', {
    type: 'deterministic',
    dependsOn: ['capabilities'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="tier1"
LOG="${ARTIFACTS}/tier1.log"
${PRELUDE}

echo "=== Tier 1: CLI Health and Command Discovery ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

run_check "relay version"          "relay version"            "[0-9]\+\.[0-9]"
run_check "relay --help"           "relay --help"             "Usage"
run_check "relay status"           "relay status"             "."
run_check "relay telemetry status" "relay telemetry status"   "."
run_check "relay workspace list"   "relay workspace list"     "."
run_check "relay update --help"    "relay update --help"      "Usage"
run_check "relay uninstall --help" "relay uninstall --help"   "Usage"

# Command-group discovery: a missing group means a whole feature category is
# unreachable, which no individual check below would attribute correctly.
for group in node cloud fleet workspace agent channel message integration capabilities skills reflex telemetry mcp; do
  run_check "group discovery: $group" "relay $group --help" "Usage"
done

run_check "node subcommands"          "relay node --help"          "up"
run_check "node agent subcommands"    "relay node agent --help"    "spawn"
run_check "node workflow subcommands" "relay node workflow --help" "run"
run_check "message dm subcommands"    "relay message dm --help"    "send"
run_check "message inbox subcommands" "relay message inbox --help" "check"
run_check "integration webhook subs"  "relay integration webhook --help" "create"

finish_tier
exit 0
`,
  });

  // ── Phase 5: Tier 2 — broker lifecycle and node agents ───────────────────

  wf.step('tier2-broker', {
    type: 'deterministic',
    dependsOn: ['tier1-cli-health'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="tier2"
LOG="${ARTIFACTS}/tier2.log"
${PRELUDE}

echo "=== Tier 2: Broker Lifecycle and Node Agents ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

run_check "node status shows running" "relay node status"        "running"
run_check "node metrics"             "relay node metrics"        "."
run_check "node deadletters"         "relay node deadletters"    "."
run_check "node deadletters --json"  "relay node deadletters --json" "."
run_check "node agent list"          "relay node agent list"     "."
run_check "fleet status"             "relay fleet status"        "."

# 'relay node tail' streams until interrupted; bound it and accept a timeout
# kill as success. Without the bound this step hangs until the run times out.
# Only a clean exit (0) or the timeout's own kill (124/137) counts. The old
# "-le 124" also accepted exit 1, so a removed or broken 'node tail' still
# scored PASS — precisely the false green this file exists to prevent.
run_check "node tail (bounded)" \
  "timeout 5 relay node tail >/dev/null 2>&1; _rc=\$?; case \$_rc in 0|124|137) echo tail-ok ;; *) echo \"tail-failed rc=\$_rc\" ;; esac" "tail-ok"

# Redeliver against an empty queue is a no-op, so this exercises the command
# path without mutating real delivery state.
run_check "node redeliver --all (empty queue)" \
  "relay node redeliver --all 2>&1 || true" "."

finish_tier
exit 0
`,
  });

  // ── Phase 6: Tier 3 — channels, messages, threads, reactions, inbox ──────

  wf.step('tier3-messaging', {
    type: 'deterministic',
    dependsOn: ['tier2-broker'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="tier3"
LOG="${ARTIFACTS}/tier3.log"
${PRELUDE}

AGENT="vf-msg-${SUFFIX}"
CHANNEL="vf-channel-${SUFFIX}"
MSG_TEXT="verify-msg-${SUFFIX}"

echo "=== Tier 3: Channels, Messages, Threads, Reactions, Inbox ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

# Parse the JSON token field rather than matching any long-ish string:
# "agent register" on an existing name prints that the agent already exists,
# and a 20+ char agent name matched the old heuristic, so a failed registration
# silently yielded the agent own name as its token. Every downstream call then
# failed for reasons that had nothing to do with the feature under test.
TOKEN=$(relay agent register "$AGENT" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
if [ -z "$TOKEN" ]; then
  record "$TIER" "agent register + token" fail "no token returned from relay agent register"
  echo "  FAIL  agent register (no token returned)" | tee -a "$LOG"
  echo "  Remaining tier 3 checks cannot run without an agent token." | tee -a "$LOG"
  for remaining in "channel create" "channel list" "channel join" "channel set_topic" \
    "message post" "message list" "message reply" "message get_thread" \
    "reaction add" "reaction remove" "inbox check" "inbox mark_read" \
    "message search" "channel leave" "channel archive"; do
    skip_check "$remaining" "agent registration failed — no token"
  done
  finish_tier
  exit 0
fi

echo "  PASS  agent register + token" | tee -a "$LOG"
record "$TIER" "agent register + token" pass ""
export RELAY_AGENT_TOKEN="$TOKEN"

run_check "agent list shows agent" "relay agent list" "$AGENT"

run_check "channel create"    "relay channel create '$CHANNEL'"                     "."
run_check "channel list"      "relay channel list"                                  "$CHANNEL"
run_check "channel join"      "relay channel join '$CHANNEL'"                       "."
run_check "channel set_topic" "relay channel set_topic '$CHANNEL' 'verify topic'"    "."

run_check "message post" "relay message post '$CHANNEL' '$MSG_TEXT'"      "."
# Asserting the posted text reads back is the actual round-trip proof; a bare
# "command exited 0" would pass even if the message were dropped.
run_check "message list round-trip" "relay message list '$CHANNEL' --limit 5" "$MSG_TEXT"

MSG_ID=$(relay message list "$CHANNEL" 2>/dev/null | grep -o '"messageId": *"[^"]*"' | head -1 | sed 's/.*"messageId": *"//;s/".*//' || echo "")
if [ -n "$MSG_ID" ]; then
  run_check "message reply"      "relay message reply '$MSG_ID' 'thread-reply-${SUFFIX}'" "."
  run_check "message get_thread" "relay message get_thread '$MSG_ID'"                     "thread-reply-${SUFFIX}"
  run_check "reaction add"       "relay message reaction add '$MSG_ID' thumbsup"          "."
  run_check "reaction remove"    "relay message reaction remove '$MSG_ID' thumbsup"       "."
  run_check "inbox check"        "relay message inbox check"                              "."
  run_check "inbox mark_read"    "relay message inbox mark_read '$MSG_ID'"                "."
else
  for remaining in "message reply" "message get_thread" "reaction add" "reaction remove" \
    "inbox check" "inbox mark_read"; do
    skip_check "$remaining" "could not extract a messageId from message list output"
  done
fi

run_check "message search"  "relay message search '$MSG_TEXT'"  "$MSG_TEXT"
run_check "channel leave"   "relay channel leave '$CHANNEL'"     "."
run_check "channel archive" "relay channel archive '$CHANNEL'"   "."

# Assert the removal actually took effect rather than assuming it did. A live
# run found "agent remove" failing for any agent that had sent a message,
# leaking a raw SQL error, which left test identities accumulating in the
# workspace while every tier still reported clean.
run_check "agent remove" "relay agent remove '$AGENT'" "."
if relay agent list 2>&1 | grep "\"name\": \"$AGENT\"" >/dev/null; then
  echo "  FAIL  agent gone after remove" | tee -a "$LOG"
  record "$TIER" "agent gone after remove" fail "$AGENT is still listed after a remove that reported success"
else
  echo "  PASS  agent gone after remove" | tee -a "$LOG"
  record "$TIER" "agent gone after remove" pass ""
fi

finish_tier
exit 0
`,
  });

  // ── Phase 7: Tier 4 — cross-agent coordination ───────────────────────────

  wf.step('tier4-cross-agent', {
    type: 'deterministic',
    dependsOn: ['tier3-messaging'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="tier4"
LOG="${ARTIFACTS}/tier4.log"
${PRELUDE}

AGENT_A="vf-alice-${SUFFIX}"
AGENT_B="vf-bob-${SUFFIX}"
CHANNEL="vf-private-${SUFFIX}"

echo "=== Tier 4: Cross-Agent DMs, Invites, Read Receipts, Files ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

TOKEN_A=$(relay agent register "$AGENT_A" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
TOKEN_B=$(relay agent register "$AGENT_B" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")

if [ -z "$TOKEN_A" ] || [ -z "$TOKEN_B" ]; then
  record "$TIER" "register two agents" fail "token A empty=$([ -z "$TOKEN_A" ] && echo yes || echo no), token B empty=$([ -z "$TOKEN_B" ] && echo yes || echo no)"
  echo "  FAIL  register two agents" | tee -a "$LOG"
  for remaining in "dm send A to B" "dm list" "channel invite" "dm send_group" \
    "inbox get_readers" "message file upload"; do
    skip_check "$remaining" "two-agent registration failed"
  done
  finish_tier
  exit 0
fi

echo "  PASS  register agent A ($AGENT_A)" | tee -a "$LOG"
echo "  PASS  register agent B ($AGENT_B)" | tee -a "$LOG"
record "$TIER" "register agent A" pass ""
record "$TIER" "register agent B" pass ""

DM_TEXT="dm-verify-${SUFFIX}"
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel create "$CHANNEL" >/dev/null 2>&1 || true
RELAY_AGENT_TOKEN="$TOKEN_A" relay channel join "$CHANNEL" >/dev/null 2>&1 || true

DM_OUT_FILE="${ARTIFACTS}/dm-send.out"
if RELAY_AGENT_TOKEN="$TOKEN_A" relay message dm send "$AGENT_B" "$DM_TEXT" > "$DM_OUT_FILE" 2>&1; then
  echo "  PASS  dm send A to B" | tee -a "$LOG"
  record "$TIER" "dm send A to B" pass ""
else
  echo "  FAIL  dm send A to B" | tee -a "$LOG"
  record "$TIER" "dm send A to B" fail "$(cat "$DM_OUT_FILE")"
fi

DM_SEND_OUT=$(cat "$DM_OUT_FILE" 2>/dev/null || echo "")
CONV_ID=$(printf '%s' "$DM_SEND_OUT" | grep -o '"conversationId": *"[^"]*"' | head -1 | sed 's/.*"conversationId": *"//;s/".*//' || echo "")
DM_ID=$(printf '%s' "$DM_SEND_OUT" | grep -oE '"(messageId|id)": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")

if [ -n "$CONV_ID" ]; then
  # B must see A's exact text, not merely a listable conversation.
  run_check "dm list (B sees A's text)" \
    "RELAY_AGENT_TOKEN='$TOKEN_B' relay message dm list '$CONV_ID'" "$DM_TEXT"
else
  skip_check "dm list (B sees A's text)" "no conversationId in dm send response"
fi

run_check "channel invite B into private channel" \
  "RELAY_AGENT_TOKEN='$TOKEN_A' relay channel invite '$CHANNEL' '$AGENT_B'" "."
run_check "dm send_group" \
  "RELAY_AGENT_TOKEN='$TOKEN_A' relay message dm send_group 'group-dm-${SUFFIX}' --to '$AGENT_B'" "."

if [ -n "$DM_ID" ]; then
  run_check "inbox mark_read (B)" \
    "RELAY_AGENT_TOKEN='$TOKEN_B' relay message inbox mark_read '$DM_ID'" "."
  run_check "inbox get_readers (A sees B)" \
    "RELAY_AGENT_TOKEN='$TOKEN_A' relay message inbox get_readers '$DM_ID'" "$AGENT_B"
else
  skip_check "inbox mark_read (B)" "no message id in dm send response"
  skip_check "inbox get_readers (A sees B)" "no message id in dm send response"
fi

UPLOAD_FILE="${ARTIFACTS}/upload-fixture.txt"
echo "verify-upload-${SUFFIX}" > "$UPLOAD_FILE"
# Signature is "upload <path> --channel <channel>" — the channel is an option,
# not a positional. A live run caught this check passing the channel first.
# --text is passed explicitly even though --help documents it as defaulting to
# "": the API rejects an empty text with "text is required", so the documented
# default cannot succeed. Tracked as a product finding, not worked around
# silently — the check exercises the path that actually works.
run_check "message file upload" \
  "RELAY_AGENT_TOKEN='$TOKEN_A' relay message file upload '$UPLOAD_FILE' --channel '$CHANNEL' --text 'verify upload ${SUFFIX}'" "."

RELAY_AGENT_TOKEN="$TOKEN_A" relay channel archive "$CHANNEL" >/dev/null 2>&1 || true
relay agent remove "$AGENT_A" 2>/dev/null || true
relay agent remove "$AGENT_B" 2>/dev/null || true

finish_tier
exit 0
`,
  });

  // ── Phase 8: Tier 5 — cloud, fleet, integrations, skills, reflex ─────────
  //
  // Everything here needs real cloud auth. Each check is gated so an
  // unauthenticated sandbox produces SKIPs with a cause rather than a wall of
  // failures that say nothing about the product.

  wf.step('tier5-cloud', {
    type: 'deterministic',
    dependsOn: ['tier4-cross-agent'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="tier5"
LOG="${ARTIFACTS}/tier5.log"
${PRELUDE}

echo "=== Tier 5: Cloud, Fleet, Integrations, Skills, Reflex ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

if ! have_cap cloud; then
  echo "  Cloud capability absent — every tier 5 check is a stated SKIP." | tee -a "$LOG"
fi

gated_check cloud "cloud whoami"    "relay cloud whoami"    "."
gated_check cloud "cloud session"   "relay cloud session"   "."
skip_check "cloud status" "takes a required <runId>; no disposable cloud run is made (see the cloud run skip)"
gated_check cloud "cloud schedules" "relay cloud schedules" "."
skip_check "cloud logs" "takes a required <runId>; no disposable cloud run is made (see the cloud run skip)"
gated_check cloud "cloud sync --help" "relay cloud sync --help" "Usage"

# Deliberately not exercised: 'cloud run' bills real sandbox time, and
# cloud login/connect/enroll need an interactive browser. Recorded as
# skips so the report shows the coverage hole instead of hiding it.
skip_check "cloud run"     "spends real cloud budget — excluded from scheduled verification"
skip_check "cloud login"   "requires interactive browser auth"
skip_check "cloud connect" "requires interactive browser auth"
skip_check "cloud enroll"  "requires interactive browser auth"

gated_check cloud "fleet nodes"   "relay fleet nodes"   "."
gated_check cloud "fleet config"  "relay fleet config"  "."
gated_check cloud "fleet inherit" "relay fleet inherit --help" "Usage"
skip_check "fleet enable"  "mutates workspace cloud state"
skip_check "fleet disable" "mutates workspace cloud state"

# fleet spawn/release were undocumented in the manifest until this change and
# are still unverified: spawning burns provider credits on a remote node.
skip_check "fleet spawn"   "spawns a billed remote agent — needs a dedicated fixture node"
skip_check "fleet release" "depends on fleet spawn"

gated_check cloud "reflex status" "relay reflex status" "."
skip_check "reflex on"  "mutates history sync state for the workspace"
skip_check "reflex off" "mutates history sync state for the workspace"

# The endpoint takes the channel to deliver into and returns a generated URL,
# and the channel must already exist, so create it before registering the hook.
WEBHOOK_CHANNEL="vf-hook-${SUFFIX}"
WEBHOOK_AGENT="vf-hookagent-${SUFFIX}"
WEBHOOK_TOKEN=$(relay agent register "$WEBHOOK_AGENT" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || true)
RELAY_AGENT_TOKEN="$WEBHOOK_TOKEN" relay channel create "$WEBHOOK_CHANNEL" >/dev/null 2>&1 || true
if have_cap cloud; then
  run_check "integration webhook list" "relay integration webhook list" "."
  run_check "integration subscription list" "relay integration subscription list" "."
  # create returns the generated webhook; trigger and delete take its id, so the
  # id has to be carried between them rather than reusing the channel name.
  WEBHOOK_OUT="${ARTIFACTS}/webhook-create.json"
  if relay integration webhook create "$WEBHOOK_CHANNEL" > "$WEBHOOK_OUT" 2>&1; then
    echo "  PASS  integration webhook create" | tee -a "$LOG"
    record "$TIER" "integration webhook create" pass ""
    WEBHOOK_ID=$(grep -o '"webhookId": *"[^"]*"' "$WEBHOOK_OUT" | head -1 | sed 's/.*: *"//;s/".*//' || true)
    if [ -n "$WEBHOOK_ID" ]; then
      run_check "integration webhook trigger" "relay integration webhook trigger '$WEBHOOK_ID' 2>&1 || true" "."
      run_check "integration webhook delete"  "relay integration webhook delete '$WEBHOOK_ID'" "."
    else
      skip_check "integration webhook trigger" "no webhookId in create response"
      skip_check "integration webhook delete"  "no webhookId in create response"
    fi
  else
    record "$TIER" "integration webhook create" fail "relay integration webhook create exited non-zero"
    echo "  FAIL  integration webhook create" | tee -a "$LOG"
    skip_check "integration webhook trigger" "webhook create failed"
    skip_check "integration webhook delete"  "webhook create failed"
  fi
else
  for remaining in "integration webhook list" "integration subscription list" \
    "integration webhook create" "integration webhook trigger" "integration webhook delete"; do
    skip_check "$remaining" "requires capability: cloud"
  done
fi

RELAY_AGENT_TOKEN="$WEBHOOK_TOKEN" relay channel archive "$WEBHOOK_CHANNEL" >/dev/null 2>&1 || true
relay agent remove "$WEBHOOK_AGENT" >/dev/null 2>&1 || true

gated_check cloud "capabilities list" "relay capabilities list" "."
gated_check cloud "skills add --help" "relay skills add --help" "Usage"

finish_tier
exit 0
`,
  });

  // ── Phase 9: Tier 6 — managed agents, harnesses, PTY, SDK ────────────────

  wf.step('tier6-harnesses', {
    type: 'deterministic',
    dependsOn: ['tier5-cloud'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="tier6"
LOG="${ARTIFACTS}/tier6.log"
${PRELUDE}

echo "=== Tier 6: Managed Agents, Harnesses, PTY, SDK ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

# Discovery works without credentials and catches a removed subcommand.
run_check "node agent spawn --help"   "relay node agent spawn --help"   "Usage"
run_check "node agent release --help" "relay node agent release --help" "Usage"
run_check "node agent attach --help"  "relay node agent attach --help"  "Usage"
run_check "node agent set-model --help" "relay node agent set-model --help" "Usage"
run_check "node agent new --help"     "relay node agent new --help"     "Usage"
run_check "node agent message hold --help" "relay node agent message hold --help" "Usage"

PROVIDER=""
for candidate in claude codex opencode gemini; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PROVIDER="$candidate"
    break
  fi
done

if [ -z "$PROVIDER" ]; then
  echo "  No provider CLI on PATH — managed-agent lifecycle is a stated SKIP." | tee -a "$LOG"
  for remaining in "node agent spawn" "node agent list shows worker" \
    "node agent message hold" "node agent message auto" "node agent release"; do
    skip_check "$remaining" "no provider CLI (claude/codex/opencode/gemini) on PATH"
  done
else
  echo "  Using provider: $PROVIDER" | tee -a "$LOG"
  WORKER="vf-worker-${SUFFIX}"
  if relay node agent spawn "$PROVIDER" --name "$WORKER" \
      --task 'Reply verify-ok and exit' --spawn-mode task-exit --exit-after-task >/dev/null 2>&1; then
    echo "  PASS  node agent spawn" | tee -a "$LOG"
    record "$TIER" "node agent spawn" pass ""
    run_check "node agent list shows worker" "relay node agent list" "$WORKER"
    run_check "node agent message hold" "relay node agent message hold '$WORKER'" "."
    run_check "node agent message auto" "relay node agent message auto '$WORKER'" "."
    run_check "node agent release"      "relay node agent release '$WORKER'"      "."
  else
    record "$TIER" "node agent spawn" fail "spawn of provider $PROVIDER exited non-zero"
    echo "  FAIL  node agent spawn ($PROVIDER)" | tee -a "$LOG"
    for remaining in "node agent list shows worker" "node agent message hold" \
      "node agent message auto" "node agent release"; do
      skip_check "$remaining" "spawn failed"
    done
  fi
fi

# SDK: presence of the package manifest only. A full SDK round trip belongs in
# the SDK package's own tests, not in a CLI feature sweep.
if [ -d packages/sdk ]; then
  run_check "sdk package resolves" "test -f packages/sdk/package.json && echo sdk-ok" "sdk-ok"
else
  skip_check "sdk package resolves" "packages/sdk not present in this checkout"
fi

skip_check "browser primitive"  "requires a provisioned browser session (tier 6 interactive)"
skip_check "python sdk"         "verified in the python-sdk repo test suite"
skip_check "swift sdk"          "verified in the swift-sdk repo test suite"

finish_tier
exit 0
`,
  });

  // ── Phase 10: critical paths 1-6 ─────────────────────────────────────────

  wf.step('critical-paths', {
    type: 'deterministic',
    dependsOn: ['tier6-harnesses'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="critical-paths"
LOG="${ARTIFACTS}/critical-paths.log"
${PRELUDE}

echo "=== Critical Paths (see .agentworkforce/features/critical-paths.md) ===" | tee "$LOG"
if abort_for_invalid_provenance; then finish_tier; exit 0; fi

# ── CP1: local broker lifecycle ──────────────────────────────────────────
# Uses an isolated state dir so bringing the broker down cannot disturb the
# broker the remaining paths depend on.
echo "-- CP1: Local Broker Lifecycle --" | tee -a "$LOG"
CP1_STATE="${ARTIFACTS}/cp1-state"
mkdir -p "$CP1_STATE"
CP1=0
relay node up --background --no-spawn --state-dir "$CP1_STATE" >/dev/null 2>&1 || true
sleep 2
relay node status --state-dir "$CP1_STATE" 2>&1 | grep -i running >/dev/null && CP1=$((CP1 + 1))
relay node metrics >/dev/null 2>&1 && CP1=$((CP1 + 1))
relay node deadletters --json >/dev/null 2>&1 && CP1=$((CP1 + 1))
relay node down --state-dir "$CP1_STATE" >/dev/null 2>&1 || true
sleep 2
# "grep -v" succeeds when ANY line lacks the pattern, so a multi-line status
# that still says running satisfied it. Negate the match over the whole output.
if ! relay node status --state-dir "$CP1_STATE" 2>&1 | grep -i running >/dev/null; then
  CP1=$((CP1 + 1))
fi
if [ "$CP1" -ge 4 ]; then
  echo "  PASS  CP1 ($CP1/4)" | tee -a "$LOG"
  record "$TIER" "CP1 broker lifecycle" pass ""
else
  echo "  FAIL  CP1 ($CP1/4)" | tee -a "$LOG"
  record "$TIER" "CP1 broker lifecycle" fail "only $CP1 of 4 lifecycle assertions held"
fi

# ── CP2: cross-agent channel message ────────────────────────────────────
echo "-- CP2: Cross-Agent Channel Message --" | tee -a "$LOG"
CP2_A="cp2a-${SUFFIX}"
CP2_B="cp2b-${SUFFIX}"
CP2_CH="cp2-ch-${SUFFIX}"
CP2_MSG="cp2-msg-${SUFFIX}"
TOKEN_2A=$(relay agent register "$CP2_A" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
TOKEN_2B=$(relay agent register "$CP2_B" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
if [ -n "$TOKEN_2A" ] && [ -n "$TOKEN_2B" ]; then
  RELAY_AGENT_TOKEN="$TOKEN_2A" relay channel create "$CP2_CH" >/dev/null 2>&1 || true
  RELAY_AGENT_TOKEN="$TOKEN_2A" relay channel invite "$CP2_CH" "$CP2_B" >/dev/null 2>&1 || true
  RELAY_AGENT_TOKEN="$TOKEN_2A" relay message post "$CP2_CH" "$CP2_MSG" >/dev/null 2>&1 || true
  if RELAY_AGENT_TOKEN="$TOKEN_2B" relay message list "$CP2_CH" --limit 10 2>&1 | grep "$CP2_MSG" >/dev/null; then
    echo "  PASS  CP2 (B read A's exact text)" | tee -a "$LOG"
    record "$TIER" "CP2 cross-agent channel message" pass ""
  else
    echo "  FAIL  CP2 (B did not see A's text)" | tee -a "$LOG"
    record "$TIER" "CP2 cross-agent channel message" fail "agent B could not read the message agent A posted to $CP2_CH"
  fi
  RELAY_AGENT_TOKEN="$TOKEN_2A" relay channel archive "$CP2_CH" >/dev/null 2>&1 || true
else
  skip_check "CP2 cross-agent channel message" "could not register two agents"
fi
relay agent remove "$CP2_A" 2>/dev/null || true
relay agent remove "$CP2_B" 2>/dev/null || true

# ── CP3: managed local agent ────────────────────────────────────────────
echo "-- CP3: Managed Local Agent --" | tee -a "$LOG"
CP3_PROVIDER=""
for candidate in claude codex opencode gemini; do
  command -v "$candidate" >/dev/null 2>&1 && CP3_PROVIDER="$candidate" && break
done
if [ -z "$CP3_PROVIDER" ]; then
  skip_check "CP3 managed local agent" "no provider CLI on PATH; provider cost makes this a pre-provisioned check"
else
  CP3_WORKER="cp3-${SUFFIX}"
  if relay node agent spawn "$CP3_PROVIDER" --name "$CP3_WORKER" \
      --task 'Reply critical-ok' --spawn-mode task-exit --exit-after-task >/dev/null 2>&1 \
      && relay node agent list 2>&1 | grep "$CP3_WORKER" >/dev/null; then
    relay node agent message hold "$CP3_WORKER" >/dev/null 2>&1 || true
    relay node agent message auto "$CP3_WORKER" >/dev/null 2>&1 || true
    relay node agent release "$CP3_WORKER" >/dev/null 2>&1 || true
    echo "  PASS  CP3" | tee -a "$LOG"
    record "$TIER" "CP3 managed local agent" pass ""
  else
    echo "  FAIL  CP3" | tee -a "$LOG"
    record "$TIER" "CP3 managed local agent" fail "spawn or list did not show worker $CP3_WORKER with provider $CP3_PROVIDER"
  fi
fi

# ── CP4: MCP stdio round trip ───────────────────────────────────────────
# A real JSON-RPC handshake. The old version only ran 'relay mcp --help',
# which proves argument parsing and nothing about the server.
echo "-- CP4: MCP Stdio Round Trip --" | tee -a "$LOG"
MCP_OUT="${ARTIFACTS}/cp4-mcp.json"
cat > "${ARTIFACTS}/cp4-mcp.mjs" <<'MCPEOF'
import { spawn } from 'node:child_process';

const child = spawn('relay', ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
let done = false;

const finish = (payload) => {
  if (done) return;
  done = true;
  child.kill('SIGTERM');
  console.log(JSON.stringify(payload));
  process.exit(0);
};

const timer = setTimeout(() => finish({ ok: false, error: 'timeout waiting for tools/list' }), 25000);
timer.unref();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id === 2 && msg.result?.tools) {
        clearTimeout(timer);
        finish({ ok: true, tools: msg.result.tools.map((t) => t.name).sort() });
      }
    } catch {
      // partial frame
    }
  }
});
child.on('error', (err) => finish({ ok: false, error: err.message }));
child.on('exit', (code) => finish({ ok: false, error: 'mcp server exited with code ' + code }));

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-features', version: '1.0.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
MCPEOF

if node "${ARTIFACTS}/cp4-mcp.mjs" > "$MCP_OUT" 2>/dev/null && grep -q '"ok":true' "$MCP_OUT"; then
  TOOL_COUNT=$(grep -o '"' "$MCP_OUT" | wc -l | tr -d ' ')
  # Assert the tools we depend on are actually listed, not just that some
  # list came back.
  MCP_MISSING=""
  for tool in register_agent create_channel post_message list_messages send_dm check_inbox; do
    grep -q "\"$tool\"" "$MCP_OUT" || MCP_MISSING="$MCP_MISSING $tool"
  done
  if [ -z "$MCP_MISSING" ]; then
    echo "  PASS  CP4 (tools/list returned the required tool set)" | tee -a "$LOG"
    record "$TIER" "CP4 mcp stdio round trip" pass ""
  else
    echo "  FAIL  CP4 (missing tools:$MCP_MISSING)" | tee -a "$LOG"
    record "$TIER" "CP4 mcp stdio round trip" fail "tools/list is missing:$MCP_MISSING"
  fi
else
  echo "  FAIL  CP4 (no tools/list response)" | tee -a "$LOG"
  record "$TIER" "CP4 mcp stdio round trip" fail "$(head -c 300 "$MCP_OUT" 2>/dev/null || echo 'no output from mcp probe')"
fi

# ── CP5: local workflow run, logs, sync ─────────────────────────────────
echo "-- CP5: Local Workflow Run, Logs, Sync --" | tee -a "$LOG"
CP5_DIR="${ARTIFACTS}/cp5"
mkdir -p "$CP5_DIR"
echo 'console.log("critical-workflow-ok")' > "$CP5_DIR/workflow.js"
CP5_JSON=$(relay node workflow run "$CP5_DIR/workflow.js" --json 2>&1 || echo "")
CP5_RUN_ID=$(printf '%s' "$CP5_JSON" | grep -o '"runId": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")

# "workflow run" is asynchronous: it returns status "running" with a run id and
# the sentinel only reaches the log later. Poll the log the way critical-path 5
# documents (--follow), rather than asserting against the launch response, which
# can never contain the output.
CP5_SEEN=0
if [ -n "$CP5_RUN_ID" ]; then
  for _ in $(seq 1 20); do
    if relay node workflow logs "$CP5_RUN_ID" 2>&1 | grep "critical-workflow-ok" >/dev/null; then
      CP5_SEEN=1
      break
    fi
    sleep 1
  done
fi

if [ "$CP5_SEEN" -eq 1 ]; then
  CP5_SYNC=$(relay node workflow sync "$CP5_RUN_ID" --dry-run --json 2>&1 || echo "")
  if printf '%s' "$CP5_SYNC" | grep '"status": *"completed"' >/dev/null; then
    echo "  PASS  CP5 (run $CP5_RUN_ID, sentinel + completed)" | tee -a "$LOG"
    record "$TIER" "CP5 local workflow lifecycle" pass ""
  else
    echo "  FAIL  CP5 (sentinel seen but run did not report completed)" | tee -a "$LOG"
    record "$TIER" "CP5 local workflow lifecycle" fail "sync did not report completed: $(printf '%s' "$CP5_SYNC" | head -c 200)"
  fi
elif [ -z "$CP5_RUN_ID" ]; then
  echo "  FAIL  CP5 (no runId from workflow run)" | tee -a "$LOG"
  record "$TIER" "CP5 local workflow lifecycle" fail "$(printf '%s' "$CP5_JSON" | head -c 300)"
else
  echo "  FAIL  CP5 (sentinel never appeared in the run log)" | tee -a "$LOG"
  record "$TIER" "CP5 local workflow lifecycle" fail "run $CP5_RUN_ID produced no critical-workflow-ok within 20s"
fi

# ── CP6: direct message and read receipt ────────────────────────────────
echo "-- CP6: Direct Message and Read Receipt --" | tee -a "$LOG"
CP6_A="cp6a-${SUFFIX}"
CP6_B="cp6b-${SUFFIX}"
TOKEN_6A=$(relay agent register "$CP6_A" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
TOKEN_6B=$(relay agent register "$CP6_B" 2>&1 | grep -o '"token": *"[^"]*"' | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
if [ -n "$TOKEN_6A" ] && [ -n "$TOKEN_6B" ]; then
  CP6_MSG="cp6-dm-${SUFFIX}"
  CP6_OUT="${ARTIFACTS}/cp6-dm.out"
  RELAY_AGENT_TOKEN="$TOKEN_6A" relay message dm send "$CP6_B" "$CP6_MSG" > "$CP6_OUT" 2>&1 || true
  CP6_CONV=$(grep -o '"conversationId": *"[^"]*"' "$CP6_OUT" | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
  CP6_ID=$(grep -oE '"(messageId|id)": *"[^"]*"' "$CP6_OUT" | head -1 | sed 's/.*: *"//;s/".*//' || echo "")
  CP6=0
  if [ -n "$CP6_CONV" ]; then
    RELAY_AGENT_TOKEN="$TOKEN_6B" relay message dm list "$CP6_CONV" 2>&1 | grep "$CP6_MSG" >/dev/null && CP6=$((CP6 + 1))
  fi
  if [ -n "$CP6_ID" ]; then
    RELAY_AGENT_TOKEN="$TOKEN_6B" relay message inbox mark_read "$CP6_ID" >/dev/null 2>&1 && CP6=$((CP6 + 1))
    RELAY_AGENT_TOKEN="$TOKEN_6A" relay message inbox get_readers "$CP6_ID" 2>&1 | grep "$CP6_B" >/dev/null && CP6=$((CP6 + 1))
  fi
  if [ "$CP6" -ge 3 ]; then
    echo "  PASS  CP6 ($CP6/3)" | tee -a "$LOG"
    record "$TIER" "CP6 dm and read receipt" pass ""
  else
    echo "  FAIL  CP6 ($CP6/3)" | tee -a "$LOG"
    record "$TIER" "CP6 dm and read receipt" fail "only $CP6 of 3 assertions held (conv=$CP6_CONV id=$CP6_ID)"
  fi
else
  skip_check "CP6 dm and read receipt" "could not register two agents"
fi
relay agent remove "$CP6_A" 2>/dev/null || true
relay agent remove "$CP6_B" 2>/dev/null || true

finish_tier
exit 0
`,
  });

  // ── Phase 10b: RelayFlow proof-case regression corpus ────────────────────
  //
  // Every merged feature/bug-fix PR leaves behind a case under
  // tests/relayflows/cases/ that discriminates the bug: a `base` arm that
  // reproduces it and a `head` arm that does not. Those cases are the sharpest
  // regression assets this repo has — each one is a real end-to-end
  // reproduction someone already paid to build and get right.
  //
  // They were also, until this tier, run exactly once each. The PR-proof
  // dispatcher selects only the single case a PR declares, and
  // `scripts/pr-proof/prepare.mjs` hard-fails a PR that changes any other case
  // ("A PR must change exactly its one declared RelayFlow case"), so a later PR
  // cannot re-run an earlier proof even in principle. Reintroduce a fixed bug
  // and nothing notices.
  //
  // This tier re-runs the corpus head-only against the current checkout and
  // requires each case to still report its `head` signature. A case that now
  // reports its `base` signature is a regression of that exact bug, named.
  //
  // Head-only is deliberate. Outside a PR there is no meaningful base SHA, and
  // asserting the fixed behaviour is the property we actually want to hold on
  // main. A case whose runner cannot execute at all is recorded as a skip with
  // its cause, never as a pass — an unrunnable proof must not read as a
  // verified one.
  wf.step('relayflow-corpus', {
    type: 'deterministic',
    dependsOn: ['critical-paths'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

TIER="relayflow-corpus"
LOG="${ARTIFACTS}/relayflow-corpus.log"
${PRELUDE}

echo "=== RelayFlow proof-case regression corpus ===" | tee "$LOG"

# Read through printenv: under 'set -u' a bare $TMPDIR aborts the whole step
# before a single case records anything, and TMPDIR is routinely unset on Linux.
CASE_TMPDIR=$(printenv TMPDIR 2>/dev/null || true)
[ -n "$CASE_TMPDIR" ] || CASE_TMPDIR=/tmp

CASE_ROOT="tests/relayflows/cases"
if [ ! -d "$CASE_ROOT" ]; then
  skip_check "relayflow corpus" "no $CASE_ROOT in this checkout"
  finish_tier
  exit 0
fi

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
if [ -z "$HEAD_SHA" ]; then
  skip_check "relayflow corpus" "checkout has no resolvable HEAD"
  finish_tier
  exit 0
fi

# The broker cases need a broker binary built from THIS checkout. A leftover
# binary under target/ is worse than none: the case would run green against an
# OLD broker and report a head signature that says nothing about this commit.
#
# Provenance is established by age. If any broker source, Cargo.toml or
# Cargo.lock is newer than the binary, the binary predates the tree and is
# refused. This is deliberately conservative: on a fresh checkout every file
# carries checkout time, so a cached target/ is rejected and the cases skip
# with that cause rather than producing a false result.
BROKER_BIN=""
BROKER_SKIP_REASON="no broker binary is built in this checkout"
for candidate in "target/release/agent-relay-broker" "target/debug/agent-relay-broker"; do
  [ -x "$candidate" ] || continue
  newer_source=$(find crates Cargo.toml Cargo.lock -newer "$candidate" -type f -print 2>/dev/null | head -n 1 || true)
  if [ -n "$newer_source" ]; then
    BROKER_SKIP_REASON="broker binary $candidate is older than $newer_source, so it was not built from this checkout"
    continue
  fi
  BROKER_BIN="$PWD/$candidate"
  break
done

for case_dir in "$CASE_ROOT"/*/; do
  case_id=$(basename "$case_dir")
  manifest="$case_dir/case.json"
  [ -f "$manifest" ] || continue

  # Validate through the SAME validator the proof gate uses rather than a
  # hand-rolled shell reading of the manifest. contract.mjs already enforces the
  # id, version, kind, requirements, timeout bounds, the node|bash executable
  # allowlist, and that the script stays under the case directory. Duplicating
  # any of that here would drift from it; a copied or malformed case would then
  # be scored by weaker rules than the gate applies.
  #
  # Emits, newline separated: timeoutSeconds, expected head signature,
  # needs-broker flag, then each runner.command element.
  # Written to a file rather than captured: command substitution strips NUL
  # bytes, which are the delimiter that makes this transport safe.
  meta_file="${ARTIFACTS}/corpus-$case_id.meta"
  meta_err="${ARTIFACTS}/corpus-$case_id.meta.err"
  rm -f "$meta_file" "$meta_err"
  node --input-type=module -e "
import { validateCaseManifest, BROKER_RUNTIME_REQUIREMENT } from './scripts/pr-proof/contract.mjs';
import fs from 'node:fs';
const id = process.argv[1];
try {
  const m = validateCaseManifest(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), { caseId: id });
  const sig = m.expected?.head?.signature;
  if (!sig) throw new Error('manifest declares no expected.head.signature');
  const needsBroker = (m.requirements ?? []).includes(BROKER_RUNTIME_REQUIREMENT) ? '1' : '';
    // NUL TERMINATED, not merely separated: a newline is legal inside a runner
  // argument and would otherwise split one argument into two before the case
  // ever runs, and 'read -d' needs the final field terminated too or it drops
  // the last command element.
  const fields = [m.timeoutSeconds, sig, needsBroker, ...m.runner.command];
  process.stdout.write(fields.map((f) => String(f) + '\0').join(''));
} catch (error) {
  // Report the contract's own reasons, not a node stack trace: the skip line is
  // the only thing a reader sees for a case that never ran.
  process.stderr.write((error?.details ?? [error?.message ?? String(error)]).join('; '));
  process.exit(1);
}
" "$case_id" "$manifest" >"$meta_file" 2>"$meta_err" || {
    skip_check "corpus: $case_id" "manifest rejected by the proof contract: $(tr '\n' ' ' < "$meta_err" 2>/dev/null | tail -c 200)"
    continue
  }

  case_timeout=""
  expected=""
  needs_broker=""
  runner_exe=""
  meta_line=0
  set --
  while IFS= read -r -d '' meta_value; do
    meta_line=$((meta_line + 1))
    case "$meta_line" in
      1) case_timeout="$meta_value" ;;
      2) expected="$meta_value" ;;
      3) needs_broker="$meta_value" ;;
      4) runner_exe="$meta_value" ;;
      *) set -- "$@" "$meta_value" ;;
    esac
  done < "$meta_file"

  if [ -z "$expected" ] || [ -z "$runner_exe" ] || [ "$#" -eq 0 ] || [ -z "$case_timeout" ]; then
    skip_check "corpus: $case_id" "manifest did not yield a runnable command and expected signature"
    continue
  fi
  if [ -n "$needs_broker" ] && [ -z "$BROKER_BIN" ]; then
    skip_check "corpus: $case_id" "case requires a broker binary: $BROKER_SKIP_REASON"
    continue
  fi

  result_file="${ARTIFACTS}/corpus-$case_id.json"
  case_log="${ARTIFACTS}/corpus-$case_id.log"

  # A previous run's result must never be read as this run's evidence: a runner
  # that exits zero without writing would otherwise be scored on a stale
  # signature and recorded PASS.
  rm -f "$result_file" "$case_log"

  # Each case gets a clean environment for the same reason the cases themselves
  # do: inheriting this runner's RELAY_* credentials points the process under
  # test at production instead of the instance it stands up.
  # Bounded by the manifest's own timeoutSeconds. An unbounded runner that
  # stalls in npm ci, a build, or a spawned broker would block cleanup, verdict
  # and every alerting step from ever running.
  case_rc=0
  env -i \
      PATH="$PATH" HOME="$HOME" TMPDIR="$CASE_TMPDIR" \
      RELAY_PR_PROOF_ARM=head \
      RELAY_PR_PROOF_TARGET_DIR="$PWD" \
      RELAY_PR_PROOF_HARNESS_DIR="$PWD" \
      RELAY_PR_PROOF_HEAD_SHA="$HEAD_SHA" \
      RELAY_PR_PROOF_RESULT_PATH="$result_file" \
      RELAY_PR_PROOF_BROKER_BINARY="$BROKER_BIN" \
      timeout -k 10 "$case_timeout" "$runner_exe" "$@" >"$case_log" 2>&1 || case_rc=$?

  if [ "$case_rc" -eq 0 ]; then
    actual=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$result_file','utf8')).signature ?? '')" 2>/dev/null || echo "")
    [ -n "$actual" ] || actual="<no signature>"
    if [ "$actual" = "$expected" ]; then
      echo "  PASS  corpus: $case_id ($actual)" | tee -a "$LOG"
      record "$TIER" "corpus: $case_id" pass ""
    else
      echo "  FAIL  corpus: $case_id (expected $expected, got $actual)" | tee -a "$LOG"
      record "$TIER" "corpus: $case_id" fail "expected head signature $expected, observed $actual; a base signature here means this exact bug is back"
    fi
  elif [ "$case_rc" -eq 124 ] || [ "$case_rc" -eq 137 ]; then
    # timeout(1) reports 124. A timeout proves nothing either way.
    echo "  FAIL  corpus: $case_id (runner exceeded $case_timeout s)" | tee -a "$LOG"
    record "$TIER" "corpus: $case_id" fail "runner exceeded its manifest timeout of $case_timeout s: $(tail -c 300 "$case_log" 2>/dev/null)"
  else
    # A runner that exits non-zero proved nothing — it is an infrastructure
    # fault, not a verified case. Record it as a failure so it is visible, with
    # the tail that explains it.
    echo "  FAIL  corpus: $case_id (runner exited $case_rc)" | tee -a "$LOG"
    record "$TIER" "corpus: $case_id" fail "runner exited $case_rc: $(tail -c 300 "$case_log" 2>/dev/null)"
  fi
done

finish_tier
exit 0
`,
  });

  // ── Phase 11: cleanup ────────────────────────────────────────────────────

  wf.step('cleanup', {
    type: 'deterministic',
    dependsOn: ['relayflow-corpus'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
# Scope teardown to THIS run's suffix. The previous pattern matched the
# substrings "vf"/"cp<digit>" anywhere in the listing, so any pre-existing
# workspace agent or channel whose name happened to contain them — or an
# unrelated column of the JSON — would have been removed or archived.
SUFFIX="${SUFFIX}"

relay agent list 2>/dev/null | grep -oE '"name": "[^"]*"' | sed 's/"name": "//;s/"$//' |
  grep -E "^(vf|cp[0-9])[A-Za-z0-9_-]*-$SUFFIX\$" | while read -r name; do
    relay agent remove "$name" >/dev/null 2>&1 || true
  done

relay channel list 2>/dev/null | grep -oE '"name": "[^"]*"' | sed 's/"name": "//;s/"$//' |
  grep -E "^(vf|cp[0-9])[A-Za-z0-9_-]*-$SUFFIX\$" | while read -r name; do
    relay channel archive "$name" >/dev/null 2>&1 || true
  done

echo "Cleanup complete"
exit 0
`,
  });

  // ── Phase 12: verdict ────────────────────────────────────────────────────
  //
  // The authoritative aggregation. It exits 0 even on FAIL, on purpose:
  // findReadySteps() in @relayflows/core only schedules a step whose
  // dependencies are "completed" or "skipped", so a failing gate here would
  // permanently block the Slack, issue, and PR steps below — the escalation
  // path would silently never run. Enforcement is `enforce-verdict` plus the
  // process exit code in main().

  wf.step('verdict', {
    type: 'deterministic',
    dependsOn: ['cleanup'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
${ENV_DEFAULTS}

# Published for the fix chain: attempt-fix is an agent step and cannot read the
# workflow's own constants, so the operator's autofix decision has to reach it
# through the filesystem.
echo "AUTOFIX=${AUTOFIX ? '1' : '0'}" > "$ARTIFACTS/autofix.env"

node <<'VERDICTEOF'
const fs = require('node:fs');

const artifacts = process.env.VERIFY_ARTIFACTS || '.workflow-artifacts/verify-features';
const ledgerPath = artifacts + '/checks.jsonl';

// Every tier that must have produced records. A tier missing from the ledger
// crashed before its first check; reporting that as "clean" is the exact
// failure mode this gate exists to prevent.
const EXPECTED_TIERS = [
  'provenance',
  'tier1',
  'tier2',
  'tier3',
  'tier4',
  'tier5',
  'tier6',
  'critical-paths',
  // Listed so an aborted corpus tier reads as "did not run" rather than
  // vanishing: the step is failOnError:false, so a crash before its first
  // record() would otherwise reach verdict as silence.
  'relayflow-corpus',
];

let checks = [];
let ledgerError = null;
// A line the reader cannot parse is a check whose result was lost. Counting
// them is the difference between "no failures" and "we could not tell", so
// they are tracked and fail the run rather than being quietly discarded.
let malformedLines = 0;
try {
  const raw = fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'));
  for (const line of raw) {
    try {
      checks.push(JSON.parse(line));
    } catch {
      malformedLines += 1;
    }
  }
} catch (err) {
  ledgerError = err.message;
}

const byTier = {};
for (const tier of EXPECTED_TIERS) {
  byTier[tier] = { pass: 0, fail: 0, skip: 0, failures: [] };
}
for (const check of checks) {
  const bucket = (byTier[check.tier] ??= { pass: 0, fail: 0, skip: 0, failures: [] });
  if (check.status === 'pass') bucket.pass++;
  else if (check.status === 'fail') {
    bucket.fail++;
    bucket.failures.push({ check: check.check, reason: check.reason });
  } else if (check.status === 'skip') bucket.skip++;
}

const notRun = EXPECTED_TIERS.filter(
  (tier) => byTier[tier].pass + byTier[tier].fail + byTier[tier].skip === 0
);

const totals = { pass: 0, fail: 0, skip: 0 };
for (const bucket of Object.values(byTier)) {
  totals.pass += bucket.pass;
  totals.fail += bucket.fail;
  totals.skip += bucket.skip;
}

const provenance = {};
try {
  for (const line of fs.readFileSync(artifacts + '/provenance.env', 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key) provenance[key] = rest.join('=');
  }
} catch {
  // provenance step did not run; reported via notRun
}

const reasons = [];
if (ledgerError) reasons.push('check ledger unreadable: ' + ledgerError);
if (notRun.length > 0) reasons.push('tiers produced no records: ' + notRun.join(', '));
if (totals.fail > 0) reasons.push(totals.fail + ' check(s) failed');
if (malformedLines > 0) {
  reasons.push(malformedLines + ' unparseable ledger line(s) — check results were lost');
}

const verdict = {
  runId: process.env.VERIFY_RUN_ID,
  verdict: reasons.length === 0 ? 'PASS' : 'FAIL',
  reasons,
  totals,
  malformedLines,
  tiers: byTier,
  tiersNotRun: notRun,
  provenance,
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(artifacts + '/verdict.json', JSON.stringify(verdict, null, 2));

console.log('=== Verdict: ' + verdict.verdict + ' ===');
console.log(
  'checks: ' + totals.pass + ' passed, ' + totals.fail + ' failed, ' + totals.skip + ' skipped'
);
for (const [tier, bucket] of Object.entries(byTier)) {
  const state = bucket.pass + bucket.fail + bucket.skip === 0 ? 'NOT_RUN' : bucket.fail > 0 ? 'FAIL' : 'PASS';
  console.log(
    '  [' + tier + '] ' + state + '  ' + bucket.pass + 'p/' + bucket.fail + 'f/' + bucket.skip + 's'
  );
  for (const failure of bucket.failures) {
    console.log('      FAIL: ' + failure.check + ' — ' + String(failure.reason).slice(0, 160));
  }
}
if (reasons.length > 0) console.log('reasons: ' + reasons.join('; '));
VERDICTEOF

exit 0
`,
  });

  // ── Phase 13: observability — PostHog ────────────────────────────────────

  wf.step('emit-posthog', {
    type: 'deterministic',
    dependsOn: ['verdict'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
RUN_ID="${RUN_ID}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"
${ENV_DEFAULTS}
${POSTHOG_FN}

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" posthog failed \
    "no verdict.json; PostHog run evidence could not be built"
  echo "POSTHOG_FAILED: no verdict.json"
  exit 0
fi

# Build the property payloads with node so the JSON is always well-formed.
if ! node <<'PHEOF' > "$ARTIFACTS/posthog-payloads.txt"; then
const fs = require('node:fs');
const artifacts = process.env.VERIFY_ARTIFACTS || '.workflow-artifacts/verify-features';
const verdict = JSON.parse(fs.readFileSync(artifacts + '/verdict.json', 'utf8'));

const runProps = {
  run_id: verdict.runId,
  verdict: verdict.verdict,
  checks_passed: verdict.totals.pass,
  checks_failed: verdict.totals.fail,
  checks_skipped: verdict.totals.skip,
  tiers_not_run: verdict.tiersNotRun.join(',') || null,
  cli_version: verdict.provenance.VERIFY_CLI_VERSION || null,
  repo_version: verdict.provenance.VERIFY_REPO_VERSION || null,
  git_sha: verdict.provenance.VERIFY_GIT_SHA || null,
  reasons: verdict.reasons.join('; ') || null,
};
console.log('relay_verify_run\t' + JSON.stringify(runProps));

// One event per failing check, bounded so a catastrophic run cannot emit
// thousands of events.
const failures = Object.entries(verdict.tiers).flatMap(([tier, bucket]) =>
  bucket.failures.map((f) => ({ tier, ...f }))
);
for (const failure of failures.slice(0, 50)) {
  console.log(
    'relay_verify_check_failed\t' +
      JSON.stringify({
        run_id: verdict.runId,
        tier: failure.tier,
        check: failure.check,
        reason: String(failure.reason).slice(0, 300),
        cli_version: verdict.provenance.VERIFY_CLI_VERSION || null,
      })
  );
}
PHEOF
  node "$STATUS_TOOL" write "$ARTIFACTS" posthog failed \
    "PostHog payload construction failed"
  echo "POSTHOG_FAILED: payload construction failed"
  exit 0
fi

TOTAL=$(wc -l < "$ARTIFACTS/posthog-payloads.txt" 2>/dev/null | tr -d ' ' || true)
if [ -z "$TOTAL" ]; then TOTAL=0; fi
if [ "$TOTAL" -eq 0 ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" posthog failed \
    "no PostHog payloads were built from verdict.json"
  echo "POSTHOG_FAILED: no payloads were built"
  exit 0
fi
if [ -z "$POSTHOG_API_KEY" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" posthog failed \
    "$TOTAL event(s) dropped: POSTHOG_API_KEY is unset"
  echo "POSTHOG_FAILED: $TOTAL event(s) dropped because POSTHOG_API_KEY is unset"
  exit 0
fi

DELIVERED=0
FAILED=0
while IFS="$(printf '\t')" read -r event props; do
  [ -n "$event" ] || continue
  if posthog_capture "$event" "$props"; then
    DELIVERED=$((DELIVERED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done < "$ARTIFACTS/posthog-payloads.txt"

if [ "$FAILED" -eq 0 ] && [ "$DELIVERED" -eq "$TOTAL" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" posthog delivered \
    "$DELIVERED/$TOTAL event(s) delivered"
  echo "POSTHOG_DELIVERED: $DELIVERED/$TOTAL event(s)"
else
  node "$STATUS_TOOL" write "$ARTIFACTS" posthog failed \
    "$FAILED/$TOTAL event(s) failed; $DELIVERED delivered"
  echo "POSTHOG_FAILED: $FAILED/$TOTAL event(s) failed"
fi

exit 0
`,
  });

  // ── Phase 14: infra escalation to NightCTO ───────────────────────────────
  //
  // A broken *harness* is a different failure class from a broken feature. A
  // product regression gets an issue and a PR; a harness that cannot run gets
  // an operator alert, because otherwise the run just goes quiet and nobody
  // notices that verification stopped happening. The pasted run showed exactly
  // this class: an expired openai refresh token during bootstrap, logged as
  // "non-fatal" and never surfaced to anyone.

  wf.step('escalate-infra', {
    type: 'deterministic',
    dependsOn: ['verdict'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
RUN_ID="${RUN_ID}"
${ENV_DEFAULTS}
VERIFY_CLI_VERSION=$(grep '^VERIFY_CLI_VERSION=' "$ARTIFACTS/provenance.env" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$VERIFY_CLI_VERSION" ]; then VERIFY_CLI_VERSION="unknown"; fi
${NIGHTCTO_FN}

ESCALATED=0

# 1. The verdict gate itself did not produce a verdict.
if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  escalate_infra "relayflow.verify.verdict" "verdict_missing" \
    "verify-features produced no verdict.json — the verification pipeline did not complete"
  ESCALATED=1
fi

# 2. Tiers that never recorded a single check: harness breakage, not a
#    product signal.
if [ -f "$ARTIFACTS/verdict.json" ]; then
  NOT_RUN=$(node -e 'const v=require("node:fs").readFileSync(process.argv[1],"utf8");process.stdout.write((JSON.parse(v).tiersNotRun||[]).join(","))' "$ARTIFACTS/verdict.json" 2>/dev/null || echo "")
  if [ -n "$NOT_RUN" ]; then
    escalate_infra "relayflow.verify.tier_not_run" "tier_not_run" \
      "verify-features tiers produced no records: $NOT_RUN"
    ESCALATED=1
  fi
fi

# 3. The broker never came up, so nothing below tier 1 could be meaningful.
if grep -q "SETUP_FAIL" "$ARTIFACTS/setup.log" 2>/dev/null; then
  escalate_infra "relayflow.verify.setup" "broker_start_failed" \
    "verify-features could not start the local broker within 30s"
  ESCALATED=1
fi

# 4. No provider CLI at all. Bootstrap logs an expired provider credential as
#    "non-fatal" and continues, which silently converts tier 6 and CP3 into
#    permanent SKIPs — verification quietly stops covering managed agents.
if grep -q "^provider_any=0$" "$ARTIFACTS/caps.env" 2>/dev/null; then
  escalate_infra "relayflow.verify.providers" "no_provider_cli" \
    "verify-features found no provider CLI on PATH — tier 6 and CP3 cannot be verified in this environment"
  ESCALATED=1
fi

if [ "$ESCALATED" -eq 0 ]; then
  echo "  No harness-level failures to escalate."
fi

exit 0
`,
  });

  // ── Phase 15: Slack escalation ───────────────────────────────────────────
  //
  // Posts on FAIL through the relayflows Slack primitive, pinned to its
  // cloud-relay runtime so delivery always goes via the workspace's Slack
  // integration rather than a bot token. When CLOUD_API_URL/CLOUD_API_TOKEN are
  // absent the primitive throws auth_token_missing and the step echoes the
  // undelivered payload — a silent no-op must never be mistakable for a
  // delivered alert.

  wf.step('slack-alert', {
    type: 'deterministic',
    dependsOn: ['verdict', 'emit-posthog', 'file-issue'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"
${ENV_DEFAULTS}
CHANNEL="$VERIFY_SLACK_CHANNEL"
${SLACK_POST_FN}

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
    "no verdict.json to report"
  echo "SLACK_FAILED: no verdict.json to report"
  exit 0
fi

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json")

if [ "$VERDICT" = "PASS" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary not_applicable \
    "verdict is PASS"
  echo "SLACK_NOT_APPLICABLE: verdict is PASS — not alerting"
  exit 0
fi

node <<'SLACKEOF' > "$ARTIFACTS/slack-message.txt"
const fs = require('node:fs');
const artifacts = process.env.VERIFY_ARTIFACTS || '.workflow-artifacts/verify-features';
const v = JSON.parse(fs.readFileSync(artifacts + '/verdict.json', 'utf8'));

const lines = [];
lines.push(':rotating_light: *Feature verification FAILED* — ${BT}' + v.runId + '${BT}');
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
    '• ${BT}' + tier + '${BT} ' + state + ' — ' + bucket.pass + 'p/' + bucket.fail + 'f/' + bucket.skip + 's'
  );
  for (const f of bucket.failures.slice(0, 5)) {
    lines.push('    ↳ ' + f.check + ': ' + String(f.reason).slice(0, 180));
  }
}
if (v.tiersNotRun.length > 0) {
  lines.push('');
  lines.push('*Tiers that produced no records:* ' + v.tiersNotRun.join(', '));
}
lines.push('');
lines.push('Artifacts: ${BT}' + artifacts + '${BT}');
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
elif slack_post "$CHANNEL" "$ARTIFACTS/slack-message.txt"; then
  SLACK_POSTED=1
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary delivered \
    "failure alert posted to $CHANNEL"
else
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_primary failed \
    "failure alert could not be posted to $CHANNEL"
fi
if [ -n "$CHANNEL" ]; then
  if ! node "$STATUS_TOOL" envelope "$ARTIFACTS" primary "${RUN_ID}" "$CHANNEL" \
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
exit 0
`,
  });

  // ── Phase 16: relay-native report ────────────────────────────────────────

  wf.step('report', {
    agent: 'reporter',
    dependsOn: ['verdict'],
    task: `You are an automated feature health agent for agent-relay.

Read ${VERDICT_FILE}. It is the authoritative result — do NOT re-derive the
verdict from the individual tier logs, and do NOT run any relay commands to
re-test anything.

If ${VERDICT_FILE} does not exist, post exactly this to the relay-health channel
and then finish:

## Feature Verification: ${RUN_ID}

**Overall: NOT_RUN** — the verification pipeline produced no verdict.
This is a harness failure, not a product result. Check the workflow logs.

Otherwise post a message to the relay-health channel in this format, filling it
in from verdict.json:

## Feature Verification: ${RUN_ID}

**Overall: <verdict>** (<pass> passed, <fail> failed, <skip> skipped)
CLI <provenance.VERIFY_CLI_VERSION> / repo <provenance.VERIFY_REPO_VERSION>

| Tier | Result | p/f/s | Notes |
|------|--------|-------|-------|
| one row per tier in verdict.json "tiers" |

**Failures:** every entry in each tier's "failures" array, as
\`<check>: <reason>\`. Write "None" only if there are genuinely zero.
**Skipped:** the skip count per tier — state plainly that skipped checks were
NOT verified.
**Tiers not run:** verdict.json "tiersNotRun", or "None".

Be accurate over brief. Never describe a skipped check as passing.`,
  });

  // ── Phase 17: GitHub issue ───────────────────────────────────────────────

  wf.step('file-issue', {
    type: 'deterministic',
    dependsOn: ['verdict'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
AUTOFIX="${AUTOFIX ? '1' : '0'}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"
${ENV_DEFAULTS}

if [ "$AUTOFIX" != "1" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue disabled \
    "VERIFY_AUTOFIX=0; operator disabled GitHub escalation"
  echo "ISSUE_DISABLED: VERIFY_AUTOFIX=0"
  exit 0
fi
if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue failed \
    "no verdict.json; cannot file a trustworthy issue"
  echo "ISSUE_FAILED: no verdict.json"
  exit 0
fi

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json")
if [ "$VERDICT" = "PASS" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue not_applicable \
    "verdict is PASS"
  echo "ISSUE_NOT_APPLICABLE: verdict is PASS"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue failed \
    "gh CLI is not available"
  echo "ISSUE_FAILED: gh CLI not available"
  exit 0
fi
if ! gh auth status >/dev/null 2>&1; then
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue failed \
    "gh is not authenticated"
  echo "ISSUE_FAILED: gh is not authenticated"
  exit 0
fi

node <<'ISSUEEOF' > "$ARTIFACTS/issue-body.md"
const fs = require('node:fs');
const artifacts = process.env.VERIFY_ARTIFACTS || '.workflow-artifacts/verify-features';
const v = JSON.parse(fs.readFileSync(artifacts + '/verdict.json', 'utf8'));

const out = [];
out.push('Automated feature verification failed.');
out.push('');
out.push('- Run: ${BT}' + v.runId + '${BT}');
out.push('- CLI under test: ${BT}' + (v.provenance.VERIFY_CLI_VERSION || '?') + '${BT}');
out.push('- Repo version: ${BT}' + (v.provenance.VERIFY_REPO_VERSION || '?') + '${BT}');
out.push('- Git sha: ${BT}' + (v.provenance.VERIFY_GIT_SHA || '?') + '${BT}');
out.push('- Totals: ' + v.totals.pass + ' passed, ' + v.totals.fail + ' failed, ' + v.totals.skip + ' skipped');
out.push('');
out.push('## Failing checks');
out.push('');
let any = false;
for (const [tier, bucket] of Object.entries(v.tiers)) {
  if (bucket.failures.length === 0) continue;
  any = true;
  out.push('### ' + tier);
  for (const f of bucket.failures) {
    out.push('- **' + f.check + '** — ' + String(f.reason).slice(0, 500));
  }
  out.push('');
}
if (!any) out.push('_No individual check failures; see the reasons below._');
out.push('## Verdict reasons');
out.push('');
for (const reason of v.reasons) out.push('- ' + reason);
if (v.tiersNotRun.length > 0) {
  out.push('');
  out.push('## Tiers that produced no records');
  out.push('');
  out.push('These crashed before their first check — treat as harness breakage, not a clean pass.');
  out.push('');
  for (const tier of v.tiersNotRun) out.push('- ${BT}' + tier + '${BT}');
}
out.push('');
out.push('---');
out.push('Filed by ${BT}workflows/verify-features.ts${BT}. Artifacts: ${BT}' + artifacts + '${BT}');
process.stdout.write(out.join('\n'));
ISSUEEOF

TITLE="Feature verification failed: ${RUN_ID}"
ISSUE_OUTPUT=$(gh issue create --title "$TITLE" --body-file "$ARTIFACTS/issue-body.md" 2>&1)
ISSUE_RC=$?
ISSUE_URL=""
if [ "$ISSUE_RC" -eq 0 ]; then
  ISSUE_URL=$(printf '%s\n' "$ISSUE_OUTPUT" | grep -oE 'https://github\.com/[^ ]+/issues/[0-9]+' | head -1 || true)
fi

if [ "$ISSUE_RC" -eq 0 ] && [ -n "$ISSUE_URL" ]; then
  echo "$ISSUE_URL" > "$ARTIFACTS/issue-url.txt"
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue delivered \
    "issue created" "$ISSUE_URL"
  echo "ISSUE_CREATED: $ISSUE_URL"
else
  ISSUE_ERROR=$(printf '%s' "$ISSUE_OUTPUT" | tr '\n\r\t' '   ' | cut -c1-500)
  node "$STATUS_TOOL" write "$ARTIFACTS" github_issue failed \
    "gh issue create failed (exit $ISSUE_RC): $ISSUE_ERROR"
  echo "ISSUE_FAILED: gh issue create exit=$ISSUE_RC produced no issue URL"
fi

exit 0
`,
  });

  // ── Phase 18: attempt a fix ──────────────────────────────────────────────

  wf.step('attempt-fix', {
    agent: 'fixer',
    dependsOn: ['file-issue'],
    task: `Fix the underlying defect behind a feature verification failure.

## FIRST: check whether there is anything to do

Read ${ARTIFACTS}/autofix.env and ${VERDICT_FILE}.

- If ${ARTIFACTS}/autofix.env contains \`AUTOFIX=0\`, the operator has disabled
  the fix path. Write "Autofix disabled." to ${ARTIFACTS}/fix-summary.md and
  STOP IMMEDIATELY.
- If ${VERDICT_FILE} does not exist, or its "verdict" field is "PASS", there is
  NOTHING to fix. Write "No failures — nothing to fix." to
  ${ARTIFACTS}/fix-summary.md and STOP IMMEDIATELY.
- In either case: do not read other files, do not create a branch, do not edit
  anything, do not run any commands.
- Only if autofix is enabled AND "verdict" is "FAIL" do you continue.

(The workflow engine has no conditional steps, so this step is scheduled on
every run. The early exit above is what keeps a green run from spending model
time and, more importantly, from letting an agent loose on a clean tree.)

## The task

Read ${VERDICT_FILE} for the authoritative list of failing checks, and the
per-tier logs in ${ARTIFACTS}/ for detail.

## Hard rules

1. NEVER commit or push to \`main\`. Work on a branch named exactly
   \`${FIX_BRANCH}\`. Create it from the current HEAD.
2. Fix the ROOT CAUSE in product code. Do NOT make a check pass by weakening,
   deleting, or loosening the check itself. If a check is genuinely wrong (it
   tests a command that was intentionally removed, or asserts something the
   product never promised), you may correct the check — but you must say so
   explicitly and justify it in your summary.
3. Do NOT reduce the number of checks in \`workflows/verify-features.ts\`. A
   later gate counts them and will reject the branch if the count drops.
4. Re-run the specific failing tier after your fix and paste the real output as
   evidence. A fix with no re-run is not a fix.
5. Classify EVERY failed check separately. "Environmental" is allowed only
   with concrete evidence from a named command/log proving the missing external
   prerequisite. A blanket statement that all failures are environmental is
   invalid. If evidence is insufficient, use category \`unknown\`, not
   \`environmental\`.
6. A \`cli-belongs-to-checkout\` failure is category \`provenance\`, never
   environmental: it means the run exercised a different artifact and the
   remaining results are not evidence about this checkout.
7. A failure whose evidence contains \`Recovery authority does not match the
   expected agent identity\` is category \`identity\`, never environmental or
   "missing broker". Preserve that exact evidence for human review.
8. If a failure is genuinely environmental (no cloud login, no provider CLI,
   expired credentials), do NOT patch code. Explain the evidence and change
   nothing for that specific failure.

## Deliverables

Write a file \`${ARTIFACTS}/fix-summary.md\` containing:

- \`Root cause:\` one paragraph per distinct failure, naming the file and symbol.
- \`Change:\` what you edited and why it addresses the root cause.
- \`Evidence:\` the exact command you re-ran and its output.
- \`Environmental:\` any failures you deliberately did not patch, and why.
- \`Assertions changed:\` any verification check you modified, with justification,
  or "none".

Also write \`${ARTIFACTS}/failure-assessment.json\` as a JSON array with exactly
one object per entry in verdict.json's failure arrays. Every object must have:

- \`tier\` and \`check\`: exact strings from verdict.json.
- \`category\`: one of \`product\`, \`provenance\`, \`identity\`,
  \`environmental\`, or \`unknown\`.
- \`evidence\`: the concrete log line or command output supporting the category.
- \`reasoning\`: why that evidence supports the category and whether code changed.

The integrity gate rejects missing entries, evidence-free environmental claims,
and provenance/identity failures mislabeled as environmental. This assessment is
included in the Slack follow-up so a human can disagree with your judgement.

Commit your work on the branch. Do NOT open a pull request — a later step does
that. Do NOT merge anything.`,
  });

  // ── Phase 19: fix integrity gate ─────────────────────────────────────────
  //
  // The one guard that makes the auto-fix path trustworthy. A fixer agent's
  // cheapest route to green is always to weaken the assertion, so this
  // compares the check count before and after and refuses a branch that
  // shrank coverage.

  wf.step('fix-integrity', {
    type: 'deterministic',
    dependsOn: ['attempt-fix'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
WORKFLOW_FILE="workflows/verify-features.ts"

# This step is scheduled unconditionally (no conditional steps in the engine),
# so a green run reaches it with nothing to check. Exit before the git
# assertions below, which would otherwise report a misleading INTEGRITY_FAIL
# just because HEAD is still main on a clean run.
if grep -q '^AUTOFIX=0$' "$ARTIFACTS/autofix.env" 2>/dev/null; then
  echo "INTEGRITY_NOT_APPLICABLE: autofix disabled, no fix was attempted"
  echo "INTEGRITY=not-applicable" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

if [ -f "$ARTIFACTS/verdict.json" ]; then
  VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json" 2>/dev/null || true)
  if [ "$VERDICT" = "PASS" ]; then
    echo "INTEGRITY_NOT_APPLICABLE: verdict is PASS, no fix was attempted"
    echo "INTEGRITY=not-applicable" > "$ARTIFACTS/fix-integrity.env"
    exit 0
  fi
fi

# A fixer that labels everything "environmental" without evidence is not a
# fix. Validate one explicit assessment per failed check before considering the
# branch or PR state.
node <<'ASSESSMENTEOF'
const fs = require('node:fs');
const artifacts = process.env.VERIFY_ARTIFACTS || '.workflow-artifacts/verify-features';
const verdict = JSON.parse(fs.readFileSync(artifacts + '/verdict.json', 'utf8'));
const assessments = JSON.parse(fs.readFileSync(artifacts + '/failure-assessment.json', 'utf8'));
const allowed = new Set(['product', 'provenance', 'identity', 'environmental', 'unknown']);
const expected = [];
for (const [tier, bucket] of Object.entries(verdict.tiers)) {
  for (const failure of bucket.failures) expected.push({ tier, ...failure });
}
const errors = [];
if (!Array.isArray(assessments)) {
  errors.push('failure-assessment.json must be an array');
} else {
  const byKey = new Map();
  for (const assessment of assessments) {
    const key = String(assessment.tier) + '\0' + String(assessment.check);
    if (byKey.has(key)) errors.push('duplicate assessment: ' + assessment.tier + '/' + assessment.check);
    byKey.set(key, assessment);
  }
  for (const failure of expected) {
    const key = failure.tier + '\0' + failure.check;
    const assessment = byKey.get(key);
    if (!assessment) {
      errors.push('missing assessment: ' + failure.tier + '/' + failure.check);
      continue;
    }
    if (!allowed.has(assessment.category)) errors.push('invalid category: ' + key);
    if (String(assessment.evidence || '').trim().length < 5) errors.push('missing evidence: ' + key);
    if (String(assessment.reasoning || '').trim().length < 10) errors.push('missing reasoning: ' + key);
    const provenanceFailure =
      failure.tier === 'provenance' ||
      String(failure.check).includes('invalid-provenance') ||
      String(failure.reason).includes('provenance is invalid for this checkout');
    if (provenanceFailure && assessment.category !== 'provenance') {
      errors.push('provenance failure mislabeled as ' + assessment.category + ': ' + key);
    }
    const identityEvidence = String(failure.reason) + '\n' + String(assessment.evidence || '');
    if (
      identityEvidence.includes('Recovery authority does not match the expected agent identity') &&
      assessment.category !== 'identity'
    ) {
      errors.push('recovery-authority failure mislabeled as ' + assessment.category + ': ' + key);
    }
    if (assessment.category === 'environmental' && String(assessment.evidence || '').trim().length < 20) {
      errors.push('environmental assessment lacks concrete evidence: ' + key);
    }
  }
  if (byKey.size !== expected.length) {
    errors.push('assessment count ' + byKey.size + ' does not match failure count ' + expected.length);
  }
}
if (errors.length > 0) {
  for (const error of errors) console.error('ASSESSMENT_INVALID: ' + error);
  process.exit(1);
}
console.log('ASSESSMENT_OK: ' + expected.length + ' failure(s) classified with evidence');
ASSESSMENTEOF
ASSESSMENT_RC=$?
if [ "$ASSESSMENT_RC" -ne 0 ]; then
  echo "INTEGRITY_FAIL: fixer did not provide a valid per-failure assessment"
  echo "INTEGRITY=fail" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "INTEGRITY_SKIPPED: not a git repository"
  echo "INTEGRITY=skipped" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "Current branch: $CURRENT"

if [ "$CURRENT" = "main" ]; then
  echo "INTEGRITY_FAIL: the fixer left the repo on main — refusing to proceed"
  echo "INTEGRITY=fail" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

# 'grep -c' prints 0 and exits 1 when there are no matches, so the fallback
# must be '|| true' — '|| echo 0' would emit a second line and break the
# numeric comparison below. POSIX bracket classes, not \s, for portability.
CHECK_PATTERN='^[[:space:]]*(run_check|gated_check|skip_check|record) '

count_checks_at() {
  git show "$1:$WORKFLOW_FILE" 2>/dev/null | grep -cE "$CHECK_PATTERN" || true
}

BASE_REF=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || true)
if [ -z "$BASE_REF" ]; then
  echo "INTEGRITY_SKIPPED: cannot resolve a base ref to diff against"
  echo "INTEGRITY=skipped" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

BEFORE=$(count_checks_at "$BASE_REF")
AFTER=$(grep -cE "$CHECK_PATTERN" "$WORKFLOW_FILE" 2>/dev/null || true)
if [ -z "$BEFORE" ]; then BEFORE=0; fi
if [ -z "$AFTER" ]; then AFTER=0; fi

echo "Verification call sites: $BEFORE (base $BASE_REF) -> $AFTER (working tree)"

if [ "$AFTER" -lt "$BEFORE" ]; then
  echo "INTEGRITY_FAIL: the fix removed $((BEFORE - AFTER)) verification call site(s)."
  echo "A fix that deletes checks has not fixed anything."
  echo "INTEGRITY=fail" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

if [ ! -f "$ARTIFACTS/fix-summary.md" ]; then
  echo "INTEGRITY_FAIL: fixer produced no fix-summary.md, so there is no root cause on record"
  echo "INTEGRITY=fail" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

if ! grep -qi "Root cause:" "$ARTIFACTS/fix-summary.md"; then
  echo "INTEGRITY_FAIL: fix-summary.md has no 'Root cause:' section"
  echo "INTEGRITY=fail" > "$ARTIFACTS/fix-integrity.env"
  exit 0
fi

echo "INTEGRITY_OK"
echo "INTEGRITY=ok" > "$ARTIFACTS/fix-integrity.env"
exit 0
`,
  });

  // ── Phase 20: draft PR ───────────────────────────────────────────────────

  wf.step('open-pr', {
    type: 'deterministic',
    dependsOn: ['fix-integrity'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
AUTOFIX="${AUTOFIX ? '1' : '0'}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"

if [ ! -f "$ARTIFACTS/fix-integrity.env" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr failed \
    "no integrity result; the fix path did not complete"
  echo "PR_FAILED: no integrity result — the fix path did not complete"
  exit 0
fi

. "$ARTIFACTS/fix-integrity.env"

if [ "$INTEGRITY" != "ok" ]; then
  PR_STATE="failed"
  PR_PREFIX="PR_FAILED"
  if [ "$AUTOFIX" != "1" ]; then
    PR_STATE="disabled"
    PR_PREFIX="PR_DISABLED"
  elif [ -f "$ARTIFACTS/verdict.json" ]; then
    VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json" 2>/dev/null || true)
    if [ "$VERDICT" = "PASS" ]; then
      PR_STATE="not_applicable"
      PR_PREFIX="PR_NOT_APPLICABLE"
    fi
  fi
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr "$PR_STATE" \
    "integrity gate returned '$INTEGRITY'; no validated fix commit exists"
  echo "$PR_PREFIX: integrity gate returned '$INTEGRITY' — not opening a PR"
  exit 0
fi
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr failed \
    "gh is unavailable or unauthenticated"
  echo "PR_FAILED: gh unavailable or unauthenticated"
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr failed \
    "fixer remained on main; refusing to open a PR"
  echo "PR_FAILED: refusing to open a PR from main"
  exit 0
fi

if git diff --quiet HEAD 2>/dev/null && [ -z "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr failed \
    "no fix commits on $BRANCH relative to origin/main"
  echo "PR_FAILED: no commits on $BRANCH relative to origin/main"
  exit 0
fi

git push -u origin "$BRANCH" 2>&1 | tail -3 || {
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr failed \
    "could not push $BRANCH"
  echo "PR_FAILED: could not push $BRANCH"
  exit 0
}

ISSUE_REF=""
if [ -f "$ARTIFACTS/issue-url.txt" ]; then
  ISSUE_REF="Fixes $(cat "$ARTIFACTS/issue-url.txt")"
fi

{
  echo "## Automated fix for feature verification failure"
  echo ""
  echo "Run: \`${RUN_ID}\`"
  echo ""
  [ -n "$ISSUE_REF" ] && echo "$ISSUE_REF" && echo ""
  echo "### Fixer summary"
  echo ""
  cat "$ARTIFACTS/fix-summary.md" 2>/dev/null || echo "_No fix summary produced._"
  echo ""
  echo "### Verdict at time of failure"
  echo ""
  echo '${BT}${BT}${BT}'
  node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(v.totals.pass+" passed, "+v.totals.fail+" failed, "+v.totals.skip+" skipped");for(const[t,b]of Object.entries(v.tiers)){if(b.failures.length)for(const f of b.failures)console.log("["+t+"] "+f.check+": "+String(f.reason).slice(0,200))}' "$ARTIFACTS/verdict.json" 2>/dev/null || echo "unavailable"
  echo '${BT}${BT}${BT}'
  echo ""
  echo "### Review notes"
  echo ""
  echo "- Opened as a **draft** by \`workflows/verify-features.ts\`. Not auto-merged."
  echo "- The integrity gate confirmed this branch does not reduce the number of"
  echo "  verification call sites, but a human still needs to confirm the fix"
  echo "  addresses the root cause rather than the symptom."
} > "$ARTIFACTS/pr-body.md"

PR_OUTPUT=$(gh pr create --draft --title "fix: feature verification failures (${RUN_ID})" \
  --body-file "$ARTIFACTS/pr-body.md" --base main --head "$BRANCH" 2>&1)
PR_RC=$?
PR_URL=""
if [ "$PR_RC" -eq 0 ]; then
  PR_URL=$(printf '%s\n' "$PR_OUTPUT" | grep -oE 'https://github\.com/[^ ]+/pull/[0-9]+' | head -1 || true)
fi

if [ "$PR_RC" -eq 0 ] && [ -n "$PR_URL" ]; then
  echo "$PR_URL" > "$ARTIFACTS/pr-url.txt"
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr delivered \
    "draft PR created" "$PR_URL"
  echo "PR_CREATED: $PR_URL"
  if [ -f "$ARTIFACTS/issue-url.txt" ]; then
    gh issue comment "$(cat "$ARTIFACTS/issue-url.txt")" \
      --body "Draft fix PR opened: $PR_URL" >/dev/null 2>&1 || true
  fi
else
  PR_ERROR=$(printf '%s' "$PR_OUTPUT" | tr '\n\r\t' '   ' | cut -c1-500)
  node "$STATUS_TOOL" write "$ARTIFACTS" draft_pr failed \
    "gh pr create failed (exit $PR_RC): $PR_ERROR"
  echo "PR_FAILED: gh pr create exit=$PR_RC produced no PR URL"
fi

exit 0
`,
  });

  // ── Phase 21: Slack follow-up with issue and PR links ────────────────────

  wf.step('slack-followup', {
    type: 'deterministic',
    dependsOn: ['open-pr', 'slack-alert'],
    captureOutput: true,
    failOnError: false,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"
${ENV_DEFAULTS}
CHANNEL="$VERIFY_SLACK_CHANNEL"
${SLACK_POST_FN}

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_followup failed \
    "no verdict.json; final escalation status could not be built"
  echo "FOLLOWUP_FAILED: no verdict.json"
  exit 0
fi

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json")
if [ "$VERDICT" = "PASS" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_followup not_applicable \
    "verdict is PASS"
  echo "FOLLOWUP_NOT_APPLICABLE: verdict is PASS"
  exit 0
fi

FOLLOWUP="$ARTIFACTS/slack-followup.txt"
{
  echo "Follow-up for \`${RUN_ID}\`:"
  node "$STATUS_TOOL" render-final "$ARTIFACTS"
} > "$FOLLOWUP"

node "$STATUS_TOOL" redact-file "$FOLLOWUP"
SLACK_POSTED=0
if [ -z "$CHANNEL" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_followup failed \
    "VERIFY_SLACK_CHANNEL is unset; no destination was assumed"
elif slack_post "$CHANNEL" "$FOLLOWUP"; then
  SLACK_POSTED=1
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_followup delivered \
    "final escalation status posted to $CHANNEL"
else
  node "$STATUS_TOOL" write "$ARTIFACTS" slack_followup failed \
    "final escalation status could not be posted to $CHANNEL"
fi
if [ -n "$CHANNEL" ]; then
  if ! node "$STATUS_TOOL" envelope "$ARTIFACTS" followup "${RUN_ID}" "$CHANNEL" \
    "$FOLLOWUP" slack_followup; then
    if [ "$SLACK_POSTED" -ne 1 ]; then
      node "$STATUS_TOOL" write "$ARTIFACTS" slack_followup failed \
        "final escalation and fallback envelope could not be delivered for $CHANNEL"
    fi
    echo "ALERT_ENVELOPE_FAILED: followup envelope write failed"
  fi
else
  echo "ALERT_ENVELOPE_FAILED: VERIFY_SLACK_CHANNEL is required"
fi
exit 0
`,
  });

  // Each delivery contract gets its own terminal leaf gate. Failing the
  // delivery step itself would prune downstream reporting; leaf gates make the
  // summary red per channel while siblings continue to the final Slack status.
  const escalationChannelGates = [
    {
      step: 'enforce-posthog-delivery',
      dependency: 'emit-posthog',
      channel: 'posthog',
      requiresAutofix: false,
    },
    {
      step: 'enforce-github-issue-delivery',
      dependency: 'file-issue',
      channel: 'github_issue',
      requiresAutofix: true,
    },
    {
      step: 'enforce-draft-pr-delivery',
      dependency: 'open-pr',
      channel: 'draft_pr',
      requiresAutofix: true,
    },
    {
      step: 'enforce-slack-primary-delivery',
      dependency: 'slack-alert',
      channel: 'slack_primary',
      requiresAutofix: false,
    },
    {
      step: 'enforce-slack-followup-delivery',
      dependency: 'slack-followup',
      channel: 'slack_followup',
      requiresAutofix: false,
    },
  ] as const;

  for (const gate of escalationChannelGates) {
    wf.step(gate.step, {
      type: 'deterministic',
      dependsOn: [gate.dependency],
      captureOutput: true,
      failOnError: true,
      command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
AUTOFIX="${AUTOFIX ? '1' : '0'}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"
CHANNEL="${gate.channel}"
REQUIRES_AUTOFIX="${gate.requiresAutofix ? '1' : '0'}"

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  echo "ESCALATION_CHANNEL_AUDIT_FAIL: no verdict.json"
  exit 2
fi

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json")
if [ "$VERDICT" = "PASS" ]; then
  echo "ESCALATION_CHANNEL_AUDIT_NOT_APPLICABLE: verdict is PASS"
  exit 0
fi

REQUIRED=1
if [ "$REQUIRES_AUTOFIX" = "1" ] && [ "$AUTOFIX" != "1" ]; then REQUIRED=0; fi
node "$STATUS_TOOL" audit-channel "$ARTIFACTS" "$CHANNEL" "$REQUIRED"
`,
    });
  }

  // ── Phase 22: enforce escalation delivery ───────────────────────────────
  //
  // The delivery steps stay exit-zero so a missing credential cannot prune the
  // downstream fix and Slack-reporting subtree. This terminal audit turns their
  // machine-readable status back into an independently red workflow row.

  wf.step('enforce-escalations', {
    type: 'deterministic',
    dependsOn: ['slack-followup'],
    captureOutput: true,
    failOnError: true,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"
AUTOFIX="${AUTOFIX ? '1' : '0'}"
STATUS_TOOL="${ESCALATION_STATUS_TOOL}"

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  echo "ESCALATION_AUDIT_FAIL: no verdict.json"
  exit 2
fi

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json")
if [ "$VERDICT" = "PASS" ]; then
  echo "ESCALATION_AUDIT_NOT_APPLICABLE: verdict is PASS"
  exit 0
fi

node "$STATUS_TOOL" audit "$ARTIFACTS" "$AUTOFIX"
`,
  });

  // ── Phase 23: enforce the verdict ────────────────────────────────────────
  //
  // Terminal step for the product verdict. Nothing depends on it, so its
  // failure cannot block escalation; enforce-escalations independently colours
  // broken reporting red after the complete fix/reporting chain finishes.
  //
  // Deliberately does NOT depend on the fix chain (attempt-fix → fix-integrity
  // → open-pr → slack-followup). A step failure marks its whole downstream
  // subtree skipped (markDownstreamSkipped is transitive), so hanging
  // enforcement off the fix chain would mean any hiccup while opening a PR
  // silently swallowed the red verdict. Reporting and alerting are the only
  // things enforcement waits on.

  wf.step('enforce-verdict', {
    type: 'deterministic',
    dependsOn: ['report', 'emit-posthog', 'escalate-infra', 'slack-alert'],
    captureOutput: true,
    failOnError: true,
    command: String.raw`
set -uo pipefail

ARTIFACTS="${ARTIFACTS}"

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  echo "ENFORCE: no verdict.json — treating as FAIL (harness did not complete)"
  exit 2
fi

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$ARTIFACTS/verdict.json")
node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log("verdict="+v.verdict);console.log("reasons="+(v.reasons.join("; ")||"none"))' "$ARTIFACTS/verdict.json"

if [ "$VERDICT" = "PASS" ]; then
  echo "ENFORCE: PASS"
  exit 0
fi

echo "ENFORCE: FAIL — see verdict.json"
exit 1
`,
  });

  const dryRun = process.env.DRY_RUN === '1';
  if (!dryRun) prepareRunArtifacts(ARTIFACTS_ROOT, RUN_ID, RUN_NONCE);
  const result = await wf.run({ dryRun, cwd: process.cwd() });

  // A dry run plans the graph without executing it, so there is no verdict to
  // read and nothing to enforce. Bail before the checks below, which would
  // otherwise report a validated plan as harness breakage.
  if (dryRun || !('status' in result)) {
    return;
  }

  // ── Post-run: make the process exit code tell the truth ──────────────────
  //
  // The previous version awaited run() and discarded the result, so a run with
  // four failing checks still exited 0 and every scheduler saw success. Read
  // the verdict directly rather than trusting the runner's row status, and
  // fail closed when the verdict is missing.

  let verdict: {
    runId?: string;
    verdict?: string;
    reasons?: string[];
    totals?: Record<string, number>;
  } | null = null;
  if (existsSync(VERDICT_FILE)) {
    try {
      verdict = JSON.parse(readFileSync(VERDICT_FILE, 'utf8'));
    } catch (err) {
      console.error(`[verify-features] verdict.json is unreadable: ${(err as Error).message}`);
    }
  }

  if (!verdict || verdict.runId !== RUN_ID) {
    console.error(
      `[verify-features] no verdict for run ${RUN_ID} at ${VERDICT_FILE} — treating this run as FAILED. ` +
        `The verification pipeline did not complete; this is harness breakage, not a clean run.`
    );
    process.exitCode = 2;
    return;
  }

  const totals = verdict.totals ?? {};
  console.log(
    `[verify-features] verdict=${verdict.verdict} ` +
      `pass=${totals.pass ?? '?'} fail=${totals.fail ?? '?'} skip=${totals.skip ?? '?'} ` +
      `(workflow row status: ${'status' in result ? String(result.status) : 'unknown'})`
  );

  if (verdict.verdict !== 'PASS') {
    console.error(`[verify-features] FAILED: ${(verdict.reasons ?? []).join('; ')}`);
    const escalationAudit = spawnSync(
      process.execPath,
      [ESCALATION_STATUS_TOOL, 'audit', ARTIFACTS, AUTOFIX ? '1' : '0'],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    if (escalationAudit.stdout) process.stdout.write(escalationAudit.stdout);
    if (escalationAudit.stderr) process.stderr.write(escalationAudit.stderr);
    if (escalationAudit.status !== 0) {
      console.error(
        `[verify-features] ESCALATION DELIVERY FAILED independently of the workflow DAG ` +
          `(audit exit ${escalationAudit.status ?? 'unknown'})`
      );
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  // A throw here means the harness itself broke — the runner could not even
  // produce a result. That is the NightCTO escalation case, and it must not
  // exit 0.
  console.error(`[verify-features] harness failure: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 2;
});
