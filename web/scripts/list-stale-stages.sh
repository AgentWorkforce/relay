#!/usr/bin/env bash
#
# List SST preview stages and identify ones whose GitHub PR is closed/merged.
# Optionally remove them with --remove.
#
# Usage:
#   web/scripts/list-stale-stages.sh                # report only
#   web/scripts/list-stale-stages.sh --remove       # also run `sst remove` for stale stages
#   web/scripts/list-stale-stages.sh --remove --yes # skip confirmation
#
# Uses AWS_PROFILE=ar_preview by default; override by exporting AWS_PROFILE.
# Requires: aws cli, gh cli, jq, and (for --remove) node_modules/.bin/sst.

set -euo pipefail

REMOVE=0
ASSUME_YES=0
APP_NAME="relay-web"

for arg in "$@"; do
  case "$arg" in
    --remove) REMOVE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

for bin in aws gh jq; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done

# In CI, OIDC sets AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN directly. Only default
# the profile for local dev so the CLI doesn't try to look up a missing ~/.aws/credentials entry.
if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE:-ar_preview}"
fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
echo "==> AWS_PROFILE=${AWS_PROFILE:-<unset; using ambient creds>} AWS_REGION=$AWS_REGION"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials invalid or missing." >&2
  if [ -n "${AWS_PROFILE:-}" ]; then
    echo "Try: aws sso login --profile $AWS_PROFILE" >&2
  fi
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
web_dir="$repo_root/web"
sst_bin="$repo_root/node_modules/.bin/sst"

if [ "$REMOVE" = "1" ] && [ ! -x "$sst_bin" ]; then
  echo "sst CLI not found at $sst_bin — run 'npm ci' at repo root" >&2
  exit 1
fi

# 1. Resolve SST state bucket (SST writes /sst/bootstrap on first deploy per region/account).
echo "==> Resolving SST state bucket via SSM /sst/bootstrap..."
bootstrap_json="$(aws ssm get-parameter --name /sst/bootstrap --query 'Parameter.Value' --output text)"
state_bucket="$(echo "$bootstrap_json" | jq -r '.bucket // .state // empty')"
if [ -z "$state_bucket" ]; then
  echo "could not read state bucket from /sst/bootstrap; raw value: $bootstrap_json" >&2
  exit 1
fi
echo "    state bucket: $state_bucket"

# 2. List every stage for this app from S3. Layout is app/<app>/<stage>.json
state_prefix="app/$APP_NAME/"
echo "==> Listing stages under s3://$state_bucket/$state_prefix ..."
stages=()
while IFS= read -r line; do
  [ -n "$line" ] && stages+=("$line")
done < <(
  aws s3 ls "s3://$state_bucket/$state_prefix" 2>/dev/null \
    | awk '$NF ~ /\.json$/ { sub(/\.json$/, "", $NF); print $NF }' | sort -u
)

if [ "${#stages[@]}" -eq 0 ]; then
  echo "    no stages found"
  exit 0
fi
echo "    found ${#stages[@]} stage(s)"

# 3. Classify each stage. pr-N stages are checked against GitHub PR state.
declare -a stale_stages=()
declare -a active_stages=()
declare -a unknown_stages=()

printf "\n%-30s %-10s %s\n" "STAGE" "STATE" "DETAIL"
printf -- "---------------------------------------------------------------\n"
for stage in "${stages[@]}"; do
  if [[ "$stage" =~ ^pr-([0-9]+)$ ]]; then
    pr_num="${BASH_REMATCH[1]}"
    pr_state="$(gh pr view "$pr_num" --json state --jq .state 2>/dev/null || echo "NOTFOUND")"
    if [ "$pr_state" = "OPEN" ]; then
      active_stages+=("$stage")
      printf "%-30s %-10s PR #%s open — keep\n" "$stage" "active" "$pr_num"
    else
      stale_stages+=("$stage")
      printf "%-30s %-10s PR #%s %s — stale\n" "$stage" "STALE" "$pr_num" "$pr_state"
    fi
  else
    case "$stage" in
      production|staging|main)
        active_stages+=("$stage")
        printf "%-30s %-10s reserved name — keep\n" "$stage" "active"
        ;;
      *)
        unknown_stages+=("$stage")
        printf "%-30s %-10s not a pr-N stage — manual review\n" "$stage" "unknown"
        ;;
    esac
  fi
done

echo
echo "Summary: ${#stale_stages[@]} stale, ${#active_stages[@]} active, ${#unknown_stages[@]} unknown"

if [ "${#stale_stages[@]}" -eq 0 ]; then
  echo "nothing to remove"
  exit 0
fi

if [ "$REMOVE" != "1" ]; then
  echo
  echo "Rerun with --remove to tear down the stale stages."
  exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
  echo
  read -r -p "Run 'sst remove' against ${#stale_stages[@]} stale stage(s)? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 0 ;;
  esac
fi

# 4. Remove each stale stage. Try unlock first in case a prior cleanup left a lock.
cd "$web_dir"
failed=()
for stage in "${stale_stages[@]}"; do
  echo
  echo "==> Removing $stage"
  "$sst_bin" unlock --stage "$stage" >/dev/null 2>&1 || true
  if "$sst_bin" remove --stage "$stage"; then
    echo "    removed $stage"
  else
    echo "    FAILED to remove $stage" >&2
    failed+=("$stage")
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "completed with ${#failed[@]} failure(s): ${failed[*]}"
  exit 1
fi
echo "done — removed ${#stale_stages[@]} stage(s)"
