#!/usr/bin/env bash
set -euo pipefail

stage="${SST_STAGE:-production}"
acm_region="${ACM_REGION:-us-east-1}"
cert_target="${SST_ACM_CERT_TARGET:-WebCdnSslCertificate}"
validation_target="${SST_ACM_VALIDATION_TARGET:-WebCdnSslValidation}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
web_dir="$repo_root/web"
sst_bin="$repo_root/node_modules/.bin/sst"

if [ ! -x "$sst_bin" ]; then
  echo "sst CLI not found at $sst_bin; run npm ci first" >&2
  exit 1
fi

state_file="$(mktemp)"
arn_file="$(mktemp)"
cleanup() {
  rm -f "$state_file" "$arn_file"
}
trap cleanup EXIT

repair_state() {
  local reason="$1"

  echo "Repairing SST state for $cert_target/$validation_target: $reason"
  (
    cd "$web_dir"
    "$sst_bin" state remove "$validation_target" --stage "$stage" || true
    "$sst_bin" state remove "$cert_target" --stage "$stage" || true
    "$sst_bin" state repair --stage "$stage"
  )
}

(
  cd "$web_dir"
  "$sst_bin" state export --stage "$stage" > "$state_file"
)

STATE_FILE="$state_file" CERT_TARGET="$cert_target" VALIDATION_TARGET="$validation_target" node > "$arn_file" <<'NODE'
const fs = require("fs");

const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
const resources = [];

function visit(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(visit);
    return;
  }
  if (typeof value.urn === "string") resources.push(value);
  Object.values(value).forEach(visit);
}

function matchesTarget(resource, target) {
  const urn = String(resource.urn ?? "");
  return urn.endsWith("::" + target) || urn.endsWith("$" + target);
}

function findCertificateArn(value) {
  const serialized = JSON.stringify(value ?? {});
  return serialized.match(/arn:aws:acm:[^"\\\s]+:certificate\/[a-f0-9-]+/)?.[0] ?? "";
}

visit(state);

const cert = resources.find((resource) => matchesTarget(resource, process.env.CERT_TARGET));
const validation = resources.find((resource) =>
  matchesTarget(resource, process.env.VALIDATION_TARGET),
);
const arn =
  cert?.id ||
  cert?.outputs?.arn ||
  findCertificateArn(cert) ||
  findCertificateArn(validation);

process.stdout.write(arn ?? "");
NODE
cert_arn="$(<"$arn_file")"

if [ -z "$cert_arn" ]; then
  echo "No ACM certificate ARN found in SST state for $cert_target/$validation_target; nothing to repair."
  exit 0
fi

set +e
describe_output="$(
  aws acm describe-certificate \
    --region "$acm_region" \
    --certificate-arn "$cert_arn" \
    --query 'Certificate.[Status,FailureReason]' \
    --output text 2>&1
)"
describe_status=$?
set -e

if [ "$describe_status" -ne 0 ]; then
  if [[ "$describe_output" == *ResourceNotFoundException* ]]; then
    repair_state "certificate $cert_arn no longer exists in ACM"
    exit 0
  fi

  echo "$describe_output" >&2
  exit "$describe_status"
fi

read -r status failure_reason <<< "$describe_output"

if [ "$status" = "VALIDATION_TIMED_OUT" ] || { [ "$status" = "FAILED" ] && [ "$failure_reason" = "VALIDATION_TIMED_OUT" ]; }; then
  repair_state "certificate $cert_arn status is $status"
  exit 0
fi

echo "$cert_target is $status; no SST state repair needed."
