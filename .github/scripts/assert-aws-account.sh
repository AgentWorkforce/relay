#!/usr/bin/env bash
set -euo pipefail

expected_account_id="${1:-${AWS_ACCOUNT_ID:-}}"
stage="${2:-${SST_STAGE:-unknown}}"
operation="${3:-deploy}"

if [ -z "$expected_account_id" ]; then
  echo "Missing expected AWS account ID. Pass it as the first argument or set AWS_ACCOUNT_ID." >&2
  exit 1
fi

actual_account_id="$(aws sts get-caller-identity --query Account --output text)"

if [ "$actual_account_id" != "$expected_account_id" ]; then
  echo "stage ${stage} must ${operation} in AWS account ${expected_account_id}, but the current credentials resolved to ${actual_account_id}." >&2
  exit 1
fi

echo "Using AWS account ${actual_account_id} for stage ${stage}."
