#!/usr/bin/env bash

set -euo pipefail

TOKEN="${RELAY_TOKEN:-}"
[ -z "$TOKEN" ] && exit 0

BASE_URL="${RELAY_BASE_URL:-https://api.relaycast.dev}"
BASE_URL="${BASE_URL%/}"

if ! MESSAGES="$(
  curl -fsS \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "$BASE_URL/v1/inbox/check" 2>/dev/null
)"; then
  exit 0
fi

COUNT="$(printf '%s' "$MESSAGES" | jq -r '.messages | if type == "array" then length else 0 end' 2>/dev/null || printf '0')"
[ "$COUNT" -eq 0 ] && exit 0

FORMATTED="$(
  printf '%s' "$MESSAGES" | jq -r '
    .messages[:20][] |
    (
      if ((.channel // "") | length) > 0
      then "Relay message from \(.from // "unknown") in #\(.channel)\(if ((.id // "") | length) > 0 then " [\(.id)]" else "" end): \((.text // "") | gsub("[\\r\\n]+"; " "))"
      else "Relay message from \(.from // "unknown")\(if ((.id // "") | length) > 0 then " [\(.id)]" else "" end): \((.text // "") | gsub("[\\r\\n]+"; " "))"
      end
    )
  ' 2>/dev/null
)"

[ -z "${FORMATTED:-}" ] && exit 0

printf 'Relay inbox update (%s unread):\n%s\nPlease read and respond to these relay messages.\n' "$COUNT" "$FORMATTED"
