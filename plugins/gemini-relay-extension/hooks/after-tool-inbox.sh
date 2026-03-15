#!/bin/sh

set -eu

EMPTY_OUTPUT='{}'
TOKEN_FILE="${HOME}/.relay/token"
BASE_URL="${RELAY_BASE_URL:-https://www.relaycast.dev/api}"
INBOX_URL="${BASE_URL}/v1/inbox/check"

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

if [ ! -s "$TOKEN_FILE" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
if [ -z "${TOKEN:-}" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

MESSAGES=$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$INBOX_URL" 2>/dev/null || true)

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
  (.messages // [])
  | .[:20]
  | map(
      if .channel then
        "Relay message from \(.from) [#\(.channel)]: \(.text)"
      else
        "Relay message from \(.from): \(.text)"
      end
    )
  | join("\n")
' 2>/dev/null || true)

if [ -z "${FORMATTED:-}" ]; then
  printf '%s\n' "$EMPTY_OUTPUT"
  exit 0
fi

CONTEXT=$(printf 'You have %s new relay message(s):\n%s\nPlease read and respond to these messages.' "$COUNT" "$FORMATTED")

jq -nc --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "AfterTool",
    additionalContext: $context
  }
}'
