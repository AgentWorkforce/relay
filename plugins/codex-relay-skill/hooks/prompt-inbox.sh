#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${PLUGIN_DIR}/.env"
BASE_RELAY_DIR="${HOME}/.relay"
# Per-agent namespacing: use RELAY_AGENT_NAME to avoid concurrent agents
# overwriting each other's state files
_agent_ns=$(printf '%s' "${RELAY_AGENT_NAME:-}" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//' | cut -c1-64)
if [ -n "$_agent_ns" ]; then
  RELAY_DIR="${BASE_RELAY_DIR}/agents/${_agent_ns}"
else
  RELAY_DIR="${BASE_RELAY_DIR}"
fi
TOKEN_FILE="${RELAY_DIR}/token"
STATE_FILE="${RELAY_DIR}/codex-session.json"
LAST_POLL_FILE="${RELAY_DIR}/last-poll"
DEFAULT_BASE_URL="https://api.relaycast.dev"
EMPTY_OUTPUT='{}'
MAX_RENDERED_MESSAGES=20
MIN_POLL_INTERVAL=3

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

should_skip_poll() {
  local now last elapsed
  now=$(date +%s)
  if [ -f "$LAST_POLL_FILE" ]; then
    last=$(cat "$LAST_POLL_FILE" 2>/dev/null || printf '0')
    case "$last" in
      ''|*[!0-9]*) last=0 ;;
    esac
    elapsed=$((now - last))
    if [ "$elapsed" -lt "$MIN_POLL_INTERVAL" ]; then
      return 0
    fi
  fi
  mkdir -p "$RELAY_DIR"
  printf '%s\n' "$now" > "$LAST_POLL_FILE"
  return 1
}

main() {
  local token base_url messages count formatted overflow context

  load_env

  if ! command_exists curl || ! command_exists jq; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi

  if should_skip_poll; then
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

  count=$(printf '%s' "$messages" | jq -r '(.messages // []) | length' 2>/dev/null || printf '0')
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

  context=$(printf 'Relay inbox update (%s unread):\n%s%s\nRead and respond to any messages that affect the current task.' "$count" "$formatted" "$overflow")
  jq -nc \
    --arg context "$context" \
    '{
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: $context
      }
    }'
}

main "$@"
