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

# Track whether Relay is configured without reading credential material into
# this hook. Workspace keys must never be placed in injected context.
WORKSPACE_CONFIGURED=0
if [ -n "${RELAY_API_KEY:-}" ] || [ -s "$KEY_FILE" ]; then
  WORKSPACE_CONFIGURED=1
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
  if [ "$WORKSPACE_CONFIGURED" -eq 1 ]; then
    CONTEXT=$(printf 'Relaycast is connected as %s. Use the Agent Relay MCP tools for DMs, channels, inbox checks, and worker coordination. Follow the ACK/DONE protocol: acknowledge new assignments promptly, and send DONE when the task is complete. To spawn workers, use run_shell_command with: RELAY_AGENT_NAME=WorkerName gemini -y -i "task prompt" &. Never print the workspace key or construct an observer URL from it. Observation requires a separately provisioned, read-only observer token delivered through an explicit secret handoff.' "$AGENT_NAME")
  else
    CONTEXT=$(printf 'Relaycast is connected as %s. Use the Agent Relay MCP tools for DMs, channels, inbox checks, and worker coordination. Follow the ACK/DONE protocol: acknowledge new assignments promptly, and send DONE when the task is complete. To spawn workers, use run_shell_command with: RELAY_AGENT_NAME=WorkerName gemini -y -i "task prompt" &.' "$AGENT_NAME")
  fi
elif [ "$WORKSPACE_CONFIGURED" -eq 1 ]; then
  CONTEXT='Relaycast workspace key is configured. If the relay tools report "Not registered", call the register tool with your exact agent name before using messaging tools. Never print the workspace key or construct an observer URL from it. Observation requires a separately provisioned, read-only observer token delivered through an explicit secret handoff.'
else
  CONTEXT='Relaycast is connected. A workspace was auto-created. Use the Agent Relay MCP tools for messaging and worker coordination.'
fi

jq -nc --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $context
  }
}'
