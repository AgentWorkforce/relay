#!/usr/bin/env bash
#
# Bootstrap shared CloudFront resources for preview environments.
#
# Each `sst.aws.Nextjs` preview stage normally creates its own CachePolicy and
# KeyValueStore — those carry low per-account quotas (20 cache policies / 5 KV
# stores). This script creates ONE of each and writes their IDs to SSM so that
# every preview stage can reference them via `web/sst.config.ts`.
#
# Idempotent: re-running checks SSM first and only creates resources if missing.
#
# Usage:
#   web/scripts/bootstrap-preview-infra.sh

set -euo pipefail

if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE:-ar_preview}"
fi
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"

for bin in aws jq; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done

CACHE_POLICY_NAME="relay-web-preview-shared"
KV_STORE_NAME="relay-web-preview-shared"
SSM_CACHE_POLICY_PARAM="/relay-web/preview/cache-policy-id"
SSM_KV_STORE_PARAM="/relay-web/preview/kv-store-arn"

echo "==> AWS_PROFILE=${AWS_PROFILE:-<unset>} AWS_REGION=$AWS_REGION"
aws sts get-caller-identity --query Account --output text

read_ssm() {
  aws ssm get-parameter --name "$1" --query 'Parameter.Value' --output text 2>/dev/null || true
}

write_ssm() {
  aws ssm put-parameter --name "$1" --value "$2" --type String --overwrite >/dev/null
}

# 1. Cache policy. Config matches SST's internal default for sst.aws.Nextjs
#    (cookies=none, query strings=all, headers=x-open-next-cache-key + x-forwarded-host,
#    brotli/gzip enabled, default ttl 0, max 1 year).
existing_policy_id="$(read_ssm "$SSM_CACHE_POLICY_PARAM")"
if [ -n "$existing_policy_id" ] && aws cloudfront get-cache-policy --id "$existing_policy_id" >/dev/null 2>&1; then
  echo "==> Cache policy already exists: $existing_policy_id"
  cache_policy_id="$existing_policy_id"
else
  echo "==> Creating shared cache policy $CACHE_POLICY_NAME"
  cache_policy_config=$(cat <<'JSON'
{
  "Name": "relay-web-preview-shared",
  "Comment": "Shared SST server response cache policy for relay-web preview stages",
  "DefaultTTL": 0,
  "MinTTL": 0,
  "MaxTTL": 31536000,
  "ParametersInCacheKeyAndForwardedToOrigin": {
    "EnableAcceptEncodingGzip": true,
    "EnableAcceptEncodingBrotli": true,
    "HeadersConfig": {
      "HeaderBehavior": "whitelist",
      "Headers": {
        "Quantity": 2,
        "Items": ["x-open-next-cache-key", "x-forwarded-host"]
      }
    },
    "CookiesConfig": { "CookieBehavior": "none" },
    "QueryStringsConfig": { "QueryStringBehavior": "all" }
  }
}
JSON
)
  cache_policy_id="$(aws cloudfront create-cache-policy \
    --cache-policy-config "$cache_policy_config" \
    --query 'CachePolicy.Id' --output text)"
  echo "    created cache policy: $cache_policy_id"
  write_ssm "$SSM_CACHE_POLICY_PARAM" "$cache_policy_id"
fi

# 2. KV store. SST namespaces keys by md5(app + stage + componentName) so sharing
#    the store across stages is safe — entries don't collide.
existing_kv_arn="$(read_ssm "$SSM_KV_STORE_PARAM")"
if [ -n "$existing_kv_arn" ] && aws cloudfront describe-key-value-store --kvs-arn "$existing_kv_arn" >/dev/null 2>&1; then
  echo "==> KV store already exists: $existing_kv_arn"
  kv_store_arn="$existing_kv_arn"
else
  echo "==> Creating shared KV store $KV_STORE_NAME"
  kv_store_arn="$(aws cloudfront create-key-value-store \
    --name "$KV_STORE_NAME" \
    --comment "Shared KV store for relay-web preview stages" \
    --query 'KeyValueStore.ARN' --output text)"
  echo "    created KV store: $kv_store_arn"
  write_ssm "$SSM_KV_STORE_PARAM" "$kv_store_arn"
fi

echo
echo "==> SSM parameters:"
echo "    $SSM_CACHE_POLICY_PARAM = $cache_policy_id"
echo "    $SSM_KV_STORE_PARAM     = $kv_store_arn"
echo
echo "Preview deploys will now reuse these resources. Re-run after disaster"
echo "recovery or if AWS resources are manually deleted."
