#!/bin/sh

set -eu

ALLOW_OUTPUT='{"decision":"allow"}'
TOKEN_FILE="${HOME}/.relay/token"
BASE_URL="${RELAY_BASE_URL:-https://www.relaycast.dev/api}"
INBOX_URL="${BASE_URL}/v1/inbox/check"
GUARD_DIR="${TMPDIR:-/tmp}/relay-afteragent"

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$ALLOW_OUTPUT"
  exit 0
fi

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
if [ -n "$SESSION_ID" ]; then
  SAFE_SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
else
  SAFE_SESSION_ID="default"
fi

mkdir -p "$GUARD_DIR"
GUARD_FILE="${GUARD_DIR}/${SAFE_SESSION_ID}.count"
RETRY_COUNT=0

if [ -f "$GUARD_FILE" ]; then
  RETRY_COUNT=$(cat "$GUARD_FILE" 2>/dev/null || printf '0')
  case "$RETRY_COUNT" in
    ''|*[!0-9]*) RETRY_COUNT=0 ;;
  esac
fi

if [ "$RETRY_COUNT" -ge 3 ]; then
  rm -f "$GUARD_FILE"
  printf '%s\n' "$ALLOW_OUTPUT"
  exit 0
fi

if [ ! -s "$TOKEN_FILE" ]; then
  rm -f "$GUARD_FILE"
  printf '%s\n' "$ALLOW_OUTPUT"
  exit 0
fi

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
if [ -z "${TOKEN:-}" ]; then
  rm -f "$GUARD_FILE"
  printf '%s\n' "$ALLOW_OUTPUT"
  exit 0
fi

MESSAGES=$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$INBOX_URL" 2>/dev/null || true)

if [ -z "${MESSAGES:-}" ]; then
  rm -f "$GUARD_FILE"
  printf '%s\n' "$ALLOW_OUTPUT"
  exit 0
fi

COUNT=$(printf '%s' "$MESSAGES" | jq -r '(.messages // []) | length' 2>/dev/null || printf '0')
case "$COUNT" in
  ''|*[!0-9]*) COUNT=0 ;;
esac

if [ "$COUNT" -eq 0 ]; then
  rm -f "$GUARD_FILE"
  printf '%s\n' "$ALLOW_OUTPUT"
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
  rm -f "$GUARD_FILE"
  printf '%s\n' "$ALLOW_OUTPUT"
  exit 0
fi

printf '%s\n' $((RETRY_COUNT + 1)) > "$GUARD_FILE"
jq -nc --arg reason "You have $COUNT unread relay message(s). Please process them before stopping:\n$FORMATTED" '{
  decision: "block",
  reason: $reason
}'
