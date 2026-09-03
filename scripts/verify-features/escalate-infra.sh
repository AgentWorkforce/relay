#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS_TOOL="$SCRIPT_DIR/escalation-status.mjs"
ARTIFACTS="${VERIFY_ARTIFACTS:?VERIFY_ARTIFACTS is required}"
RUN_ID="${VERIFY_RUN_ID:?VERIFY_RUN_ID is required}"
VERIFY_ENVIRONMENT="${VERIFY_ENVIRONMENT:-sandbox}"
NIGHTCTO_EVIDENCE_URL="${NIGHTCTO_EVIDENCE_URL:-}"
NIGHTCTO_EVIDENCE_TOKEN="${NIGHTCTO_EVIDENCE_TOKEN:-}"
VERIFY_CLI_VERSION=$(grep '^VERIFY_CLI_VERSION=' "$ARTIFACTS/provenance.env" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$VERIFY_CLI_VERSION" ]; then VERIFY_CLI_VERSION="unknown"; fi

escalate_infra() {
  local evidence_path="$1"
  local code="$2"
  local summary="$3"
  if [ -z "$NIGHTCTO_EVIDENCE_URL" ]; then
    echo "  [nightcto] DELIVERY_FAILED: NIGHTCTO_EVIDENCE_URL unset — $code"
    return 1
  fi
  local body
  if ! body=$(node - "$VERIFY_ENVIRONMENT" "$VERIFY_CLI_VERSION" "$evidence_path" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID" "$summary" "$code" "$ARTIFACTS" <<'JSONEOF'
const [environment, version, evidencePath, occurredAt, requestId, summary, errorCode, logQuery] =
  process.argv.slice(2);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 'cloud-runtime-evidence/1',
    service: 'relay-verify-features',
    environment,
    version,
    path: evidencePath,
    kind: 'request_error',
    outcome: 'error',
    severity: 6,
    occurredAt,
    requestId,
    correlationIds: { ingress: 'relayflow' },
    summary: String(summary).replace(/[\n\r\t]/g, ' ').slice(0, 300),
    errorCode,
    inspect: { logQuery },
  })
);
JSONEOF
  ); then
    echo "  [nightcto] DELIVERY_FAILED: JSON payload construction failed — $code"
    return 1
  fi
  if curl -fsS -m 15 -X POST "$NIGHTCTO_EVIDENCE_URL" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $NIGHTCTO_EVIDENCE_TOKEN" \
      -H "x-nightcto-evidence-token: $NIGHTCTO_EVIDENCE_TOKEN" \
      -d "$body" >/dev/null 2>&1; then
    echo "  [nightcto] delivered: $code"
    return 0
  fi
  echo "  [nightcto] DELIVERY_FAILED: POST failed — $code"
  return 1
}

ATTEMPTED_CODES=""
FAILED_CODES=""
attempt_infra_escalation() {
  local evidence_path="$1"
  local code="$2"
  local summary="$3"
  if [ -z "$ATTEMPTED_CODES" ]; then ATTEMPTED_CODES="$code"; else ATTEMPTED_CODES="$ATTEMPTED_CODES,$code"; fi
  if ! escalate_infra "$evidence_path" "$code" "$summary"; then
    if [ -z "$FAILED_CODES" ]; then FAILED_CODES="$code"; else FAILED_CODES="$FAILED_CODES,$code"; fi
  fi
}

if [ ! -f "$ARTIFACTS/verdict.json" ]; then
  attempt_infra_escalation "relayflow.verify.verdict" "verdict_missing" \
    "verify-features produced no verdict.json — the verification pipeline did not complete"
fi

if [ -f "$ARTIFACTS/verdict.json" ]; then
  if NOT_RUN=$(node -e 'const v=require("node:fs").readFileSync(process.argv[1],"utf8");process.stdout.write((JSON.parse(v).tiersNotRun||[]).join(","))' "$ARTIFACTS/verdict.json" 2>/dev/null); then
    if [ -n "$NOT_RUN" ]; then
      attempt_infra_escalation "relayflow.verify.tier_not_run" "tier_not_run" \
        "verify-features tiers produced no records: $NOT_RUN"
    fi
  else
    attempt_infra_escalation "relayflow.verify.verdict" "verdict_missing" \
      "verify-features verdict.json was unreadable — the verification pipeline did not complete"
  fi
fi

if grep -q "SETUP_FAIL" "$ARTIFACTS/setup.log" 2>/dev/null; then
  attempt_infra_escalation "relayflow.verify.setup" "broker_start_failed" \
    "verify-features could not start the local broker within 30s"
fi

if grep -q "^provider_any=0$" "$ARTIFACTS/caps.env" 2>/dev/null; then
  attempt_infra_escalation "relayflow.verify.providers" "no_provider_cli" \
    "verify-features found no provider CLI on PATH — tier 6 and CP3 cannot be verified in this environment"
fi

if [ -z "$ATTEMPTED_CODES" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" infra not_applicable \
    "no harness-level failure required NightCTO escalation"
  echo "  No harness-level failures to escalate."
elif [ -n "$FAILED_CODES" ]; then
  node "$STATUS_TOOL" write "$ARTIFACTS" infra failed \
    "NightCTO delivery failed for: $FAILED_CODES"
  echo "INFRA_ESCALATION_FAILED: $FAILED_CODES"
else
  node "$STATUS_TOOL" write "$ARTIFACTS" infra delivered \
    "NightCTO evidence delivered for: $ATTEMPTED_CODES"
  echo "INFRA_ESCALATION_DELIVERED: $ATTEMPTED_CODES"
fi

# The infra leaf gate turns a failed receipt red after this step completes, so
# every applicable condition is attempted and sibling alerting remains live.
exit 0
