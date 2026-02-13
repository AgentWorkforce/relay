#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${RELAYCAST_BASE_URL:-https://api.relaycast.dev}"
CACHE_PATH="${RELAYCAST_CACHE_PATH:-$HOME/.relay-broker/relaycast.json}"
TO="${1:-}"
TEXT="${2:-}"

if [[ -z "$TO" || -z "$TEXT" ]]; then
  echo "usage: $0 <to> <text>" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

if [[ ! -f "$CACHE_PATH" ]]; then
  echo "credential cache missing: $CACHE_PATH" >&2
  exit 2
fi

REGISTER_PAYLOAD="$(jq -c '{machine_id,project_id,workspace_id,agent_id,api_key}' "$CACHE_PATH")"
TOKEN="$(
  curl -fsS -X POST "$BASE_URL/v1/agents" \
    -H 'content-type: application/json' \
    -d "$REGISTER_PAYLOAD" \
    | jq -r '.token // .agent_token'
)"

if [[ "$TOKEN" == "null" || -z "$TOKEN" ]]; then
  echo "failed to get relaycast token" >&2
  exit 1
fi

if [[ "$TO" == \#* ]]; then
  CHANNEL="${TO#\#}"
  BODY="$(jq -nc --arg text "$TEXT" '{text:$text,priority:3}')"
  curl -fsS -X POST "$BASE_URL/v1/channels/$CHANNEL/messages" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$BODY" >/dev/null
else
  BODY="$(jq -nc --arg to "$TO" --arg text "$TEXT" '{to:$to,text:$text}')"
  curl -fsS -X POST "$BASE_URL/v1/dm" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$BODY" >/dev/null
fi
