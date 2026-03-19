#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${PLUGIN_DIR}/.env"
RELAY_DIR="${HOME}/.relay"
TOKEN_FILE="${RELAY_DIR}/token"
STATE_FILE="${RELAY_DIR}/codex-session.json"
DEFAULT_BASE_URL="https://api.relaycast.dev"
EMPTY_OUTPUT='{}'
MAX_RENDERED_MESSAGES=20

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

trim() {
  printf '%s' "${1:-}" | awk '{$1=$1;print}'
}

normalize_base_url() {
  local value
  value=$(trim "${1:-}")
  if [ -z "$value" ] && [ -f "$STATE_FILE" ] && command_exists jq; then
    value=$(jq -r '.baseUrl // empty' "$STATE_FILE" 2>/dev/null || true)
  fi
  value=$(trim "${value:-$DEFAULT_BASE_URL}")
  value=${value%/}
  printf '%s' "${value:-$DEFAULT_BASE_URL}"
}

json_number() {
  local payload="$1"
  local query="$2"
  printf '%s' "$payload" | jq -r "$query" 2>/dev/null || printf '0'
}

read_stop_hook_active() {
  if ! command_exists jq; then
    printf 'false'
    return
  fi

  jq -r '.stop_hook_active // false' 2>/dev/null || printf 'false'
}

read_token() {
  local token
  token=$(trim "${RELAY_TOKEN:-}")
  if [ -n "$token" ]; then
    printf '%s' "$token"
    return
  fi
  if [ -s "$TOKEN_FILE" ]; then
    trim "$(cat "$TOKEN_FILE" 2>/dev/null || true)"
    return
  fi
  printf ''
}

main() {
  local input stop_hook_active token base_url messages count formatted overflow reason

  load_env

  if ! command_exists curl || ! command_exists jq; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  input=$(cat)
  stop_hook_active=$(printf '%s' "$input" | read_stop_hook_active)
  if [ "$stop_hook_active" = "true" ]; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  token=$(read_token)
  if [ -z "$token" ]; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  base_url=$(normalize_base_url "${RELAY_BASE_URL:-}")
  messages=$(
    curl -fsS \
      -X POST \
      -H "Authorization: Bearer ${token}" \
      -H 'Content-Type: application/json' \
      -d '{}' \
      "${base_url}/v1/inbox/check" 2>/dev/null || true
  )

  if [ -z "$messages" ]; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  count=$(json_number "$messages" '(.messages // []) | length')
  case "$count" in
    ''|*[!0-9]*) count=0 ;;
  esac

  if [ "$count" -eq 0 ]; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  formatted=$(
    printf '%s' "$messages" | jq -r --argjson limit "$MAX_RENDERED_MESSAGES" '
      (.messages // [])
      | .[:$limit]
      | map(
          if ((.channel // "") | length) > 0 then
            "Relay message from \(.from // "unknown") in #\(.channel)\(if ((.id // "") | length) > 0 then " [\(.id)]" else "" end): \((.text // "") | gsub("[\\r\\n]+"; " "))"
          else
            "Relay message from \(.from // "unknown")\(if ((.id // "") | length) > 0 then " [\(.id)]" else "" end): \((.text // "") | gsub("[\\r\\n]+"; " "))"
          end
        )
      | join("\n")
    ' 2>/dev/null || true
  )

  if [ -z "$formatted" ]; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  overflow=""
  if [ "$count" -gt "$MAX_RENDERED_MESSAGES" ]; then
    overflow=$(printf '\n... and %s more unread relay message(s).' "$((count - MAX_RENDERED_MESSAGES))")
  fi

  reason=$(printf 'You have %s unread relay message(s). Please read and respond before stopping:\n%s%s' "$count" "$formatted" "$overflow")
  jq -nc --arg reason "$reason" '{decision: "block", reason: $reason}'
}

main "$@"
