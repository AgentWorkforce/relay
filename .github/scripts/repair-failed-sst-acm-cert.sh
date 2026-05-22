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
cleanup() {
  rm -f "$state_file"
}
trap cleanup EXIT

repair_state() {
  local reason="$1"

  echo "Repairing SST state for $cert_target: $reason"
  (
    cd "$web_dir"
    "$sst_bin" state remove "$validation_target" --stage "$stage" || true
    "$sst_bin" state remove "$cert_target" --stage "$stage"
    "$sst_bin" state repair --stage "$stage"
  )
}

(
  cd "$web_dir"
  "$sst_bin" state export --stage "$stage" > "$state_file"
)

cert_arn="$(
  STATE_FILE="$state_file" CERT_TARGET="$cert_target" node <<'NODE'
const fs = require("fs");

const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8"));
const resources =
  state?.deployment?.resources ??
  state?.checkpoint?.latest?.resources ??
  state?.resources ??
  [];

const target = process.env.CERT_TARGET;
const cert = resources.find((resource) => {
  if (resource?.type !== "aws:acm/certificate:Certificate") return false;
  const urn = String(resource.urn ?? "");
  return urn.endsWith(`::${target}`) || urn.endsWith(`$${target}`);
});

process.stdout.write(cert?.id ?? cert?.outputs?.arn ?? "");
NODE
)"

if [ -z "$cert_arn" ]; then
  echo "No $cert_target ACM certificate found in SST state; nothing to repair."
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

if [ "$status" = "FAILED" ] && [ "$failure_reason" = "VALIDATION_TIMED_OUT" ]; then
  repair_state "certificate $cert_arn is FAILED with VALIDATION_TIMED_OUT"
  exit 0
fi

echo "$cert_target is $status; no SST state repair needed."
