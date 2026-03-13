#!/bin/sh

set -eu

EMPTY_OUTPUT='{}'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EXTENSION_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${EXTENSION_DIR}/.env"
TOKEN_FILE="${HOME}/.relay/token"
STATE_FILE="${HOME}/.relay/gemini-session.json"
WORKERS_FILE="${HOME}/.relay/gemini-workers.json"
BASE_URL="https://www.relaycast.dev/api"
AFTER_AGENT_DIR="${TMPDIR:-/tmp}/relay-afteragent"
BEFORE_MODEL_DIR="${TMPDIR:-/tmp}/relay-beforemodel"

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
}

load_env

if [ -n "${RELAY_BASE_URL:-}" ]; then
  BASE_URL="$RELAY_BASE_URL"
fi

INPUT=$(cat)
SESSION_ID=""
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi

if [ -n "$SESSION_ID" ]; then
  SAFE_SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
  rm -f "${AFTER_AGENT_DIR}/${SAFE_SESSION_ID}.count"
  rm -f "${BEFORE_MODEL_DIR}/${SAFE_SESSION_ID}.last-check"
fi

if [ -s "$WORKERS_FILE" ] && command -v jq >/dev/null 2>&1 && [ -n "${RELAY_API_KEY:-}" ]; then
  jq -r '.[]? | if type == "string" then . else .name // empty end' "$WORKERS_FILE" 2>/dev/null | while IFS= read -r worker; do
    if [ -z "$worker" ]; then
      continue
    fi
    curl -fsS -X POST \
      -H "Authorization: Bearer ${RELAY_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg name "$worker" '{name: $name, reason: "Gemini session ended", delete_agent: false}')" \
      "${BASE_URL}/v1/agents/release" >/dev/null 2>&1 || true
  done
fi

if [ -s "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
  if [ -n "${TOKEN:-}" ]; then
    curl -fsS -X POST \
      -H "Authorization: Bearer ${TOKEN}" \
      "${BASE_URL}/v1/agents/disconnect" >/dev/null 2>&1 || true
  fi
fi

rm -f "$TOKEN_FILE" "$STATE_FILE"
rm -f "$WORKERS_FILE"

printf '%s\n' "$EMPTY_OUTPUT"
