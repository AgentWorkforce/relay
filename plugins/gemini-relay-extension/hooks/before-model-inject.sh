#!/bin/sh

set -eu

EMPTY_OUTPUT='{}'
TOKEN_FILE="${HOME}/.relay/token"
RATE_DIR="${TMPDIR:-/tmp}/relay-beforemodel"

INPUT=$(cat)

if [ ! -s "$TOKEN_FILE" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
if [ -z "${TOKEN:-}" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
if [ -n "$SESSION_ID" ]; then
  SAFE_SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
else
  SAFE_SESSION_ID="default"
fi

mkdir -p "$RATE_DIR"
RATE_FILE="${RATE_DIR}/${SAFE_SESSION_ID}.last-check"
NOW=$(date +%s)

if [ -f "$RATE_FILE" ]; then
  LAST_CHECK=$(cat "$RATE_FILE" 2>/dev/null || printf '0')
  case "$LAST_CHECK" in
    ''|*[!0-9]*) LAST_CHECK=0 ;;
  esac

  ELAPSED=$((NOW - LAST_CHECK))
  if [ "$ELAPSED" -lt 5 ]; then
    printf '%s\n' "$EMPTY_OUTPUT"
    exit 0
  fi
fi

printf '%s\n' "$NOW" > "$RATE_FILE"

MESSAGES=$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://www.relaycast.dev/api/v1/inbox/check 2>/dev/null || true)

if [ -z "${MESSAGES:-}" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

COUNT=$(printf '%s' "$MESSAGES" | jq -r '(.messages // []) | length' 2>/dev/null || printf '0')
case "$COUNT" in
  ''|*[!0-9]*) COUNT=0 ;;
esac

if [ "$COUNT" -eq 0 ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

FORMATTED=$(printf '%s' "$MESSAGES" | jq -r '
  .messages[]
  | if .channel then
      "Relay message from \(.from) [#\(.channel)]: \(.text)"
    else
      "Relay message from \(.from): \(.text)"
    end
' 2>/dev/null || true)

if [ -z "${FORMATTED:-}" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

MODIFIED=$(printf '%s' "$INPUT" | jq -c --arg msgs "$FORMATTED" '
  .llm_request as $req
  | if ($req | type) != "object" then
      null
    else
      $req
      | .messages = (
          [{"role": "system", "content": ("New relay messages:\n" + $msgs)}]
          + (if (.messages | type) == "array" then .messages else [] end)
        )
    end
' 2>/dev/null || true)

if [ -z "${MODIFIED:-}" ] || [ "$MODIFIED" = "null" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

printf '%s\n' "$MODIFIED" | jq -c '{
  hookSpecificOutput: {
    hookEventName: "BeforeModel",
    llm_request: .
  }
}'
