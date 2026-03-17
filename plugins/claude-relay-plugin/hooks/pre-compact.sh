#!/usr/bin/env bash

set -euo pipefail

AGENT_NAME="${RELAY_AGENT_NAME:-unknown}"
WORKSPACE_KEY="${RELAY_API_KEY:-${RELAY_WORKSPACE:-unknown}}"
WORKERS_JSON="${RELAY_WORKERS_JSON:-}"
WORKERS_FILE="${RELAY_WORKERS_FILE:-$PWD/.agent-relay/team/workers.json}"

short_workspace() {
  local value="$1"
  if [ "${#value}" -le 16 ]; then
    printf '%s' "$value"
  else
    printf '%s...' "${value:0:16}"
  fi
}

render_workers_from_json() {
  local json="$1"
  printf '%s' "$json" | jq -r '
    if type == "array" then .
    elif (type == "object" and (.workers | type == "array")) then .workers
    else []
    end
    | if length == 0 then "  (none)"
      else map(
        "  - \(.name // "unknown"): \(.status // "running")" +
        (if ((.task // "") | length) > 0 then " - \"" + (.task | gsub("[\\r\\n]+"; " ")) + "\"" else "" end)
      ) | join("\n")
      end
  ' 2>/dev/null
}

WORKERS_BLOCK='  (none)'
if [ -n "$WORKERS_JSON" ]; then
  RENDERED="$(render_workers_from_json "$WORKERS_JSON" || true)"
  [ -n "${RENDERED:-}" ] && WORKERS_BLOCK="$RENDERED"
elif [ -f "$WORKERS_FILE" ]; then
  RENDERED="$(render_workers_from_json "$(cat "$WORKERS_FILE")" || true)"
  [ -n "${RENDERED:-}" ] && WORKERS_BLOCK="$RENDERED"
fi

printf '## Relay State (preserve across compaction)\n'
printf -- '- Connected as: %s\n' "$AGENT_NAME"
printf -- '- Workspace: %s\n' "$(short_workspace "$WORKSPACE_KEY")"
printf ' - Spawned workers:\n%s\n' "$WORKERS_BLOCK" | sed '1s/^ //'
