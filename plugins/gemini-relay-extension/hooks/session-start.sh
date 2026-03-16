#!/bin/sh

set -eu

EMPTY_OUTPUT='{}'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EXTENSION_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${EXTENSION_DIR}/.env"
KEY_FILE="${HOME}/.relay/workspace-key"
TOKEN_FILE="${HOME}/.relay/token"
STATE_FILE="${HOME}/.relay/gemini-session.json"

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
}

load_env

# Resolve workspace key: env > persisted key file
WORKSPACE_KEY="${RELAY_API_KEY:-}"
if [ -z "$WORKSPACE_KEY" ] && [ -s "$KEY_FILE" ]; then
  WORKSPACE_KEY=$(cat "$KEY_FILE" 2>/dev/null || true)
fi

TOKEN=""
AGENT_NAME=""

if [ -s "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
fi

if [ -f "$STATE_FILE" ] && command -v jq >/dev/null 2>&1; then
  AGENT_NAME=$(jq -r '.agentName // empty' "$STATE_FILE" 2>/dev/null || true)
fi

if [ -n "${TOKEN:-}" ] && [ -n "${AGENT_NAME:-}" ]; then
  if [ -n "${WORKSPACE_KEY:-}" ]; then
    CONTEXT=$(printf 'Relaycast is connected as %s. Use the Relaycast MCP tools for DMs, channels, inbox checks, and worker coordination. Follow the ACK/DONE protocol: acknowledge new assignments promptly, and send DONE when the task is complete. To spawn workers, use run_shell_command with: RELAY_AGENT_NAME=WorkerName gemini -y -i "task prompt" &. The user can observe agent conversations at: https://agentrelay.dev/observer?key=%s' "$AGENT_NAME" "$WORKSPACE_KEY")
  else
    CONTEXT=$(printf 'Relaycast is connected as %s. Use the Relaycast MCP tools for DMs, channels, inbox checks, and worker coordination. Follow the ACK/DONE protocol: acknowledge new assignments promptly, and send DONE when the task is complete. To spawn workers, use run_shell_command with: RELAY_AGENT_NAME=WorkerName gemini -y -i "task prompt" &.' "$AGENT_NAME")
  fi
elif [ -n "${WORKSPACE_KEY:-}" ]; then
  CONTEXT=$(printf 'Relaycast workspace key is configured. If the relay tools report "Not registered", call the register tool with your exact agent name before using messaging tools. The user can observe agent conversations at: https://agentrelay.dev/observer?key=%s' "$WORKSPACE_KEY")
else
  CONTEXT='Relaycast is connected. A workspace was auto-created. Use the Relaycast MCP tools for messaging and worker coordination.'
fi

jq -nc --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $context
  }
}'
