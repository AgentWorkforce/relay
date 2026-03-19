#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${PLUGIN_DIR}/.env"
RELAY_DIR="${HOME}/.relay"
KEY_FILE="${RELAY_DIR}/workspace-key"
TOKEN_FILE="${RELAY_DIR}/token"
STATE_FILE="${RELAY_DIR}/codex-session.json"
DEFAULT_BASE_URL="https://api.relaycast.dev"

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
  value=$(trim "${1:-$DEFAULT_BASE_URL}")
  value=${value%/}
  printf '%s' "${value:-$DEFAULT_BASE_URL}"
}

json_value() {
  local payload="$1"
  local query="$2"
  printf '%s' "$payload" | jq -r "$query // empty" 2>/dev/null || true
}

sanitize() {
  printf '%s' "${1:-}" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//' | cut -c1-64
}

derive_workspace_name() {
  local user host suffix
  user=$(sanitize "${USER:-${USERNAME:-codex}}")
  host=$(hostname 2>/dev/null | cut -d '.' -f 1 | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//' | cut -c1-20)
  suffix=$(date +%s)
  printf 'codex-%s-%s-%s' "${user:-codex}" "${host:-local}" "$suffix" | cut -c1-64
}

read_existing_agent_name() {
  if [ -f "$STATE_FILE" ] && command_exists jq; then
    jq -r '.agentName // empty' "$STATE_FILE" 2>/dev/null || true
  fi
}

derive_agent_name() {
  local explicit existing user host suffix
  explicit=$(trim "${RELAY_AGENT_NAME:-}")
  if [ -n "$explicit" ]; then
    sanitize "$explicit"
    return
  fi

  existing=$(trim "$(read_existing_agent_name)")
  if [ -n "$existing" ]; then
    sanitize "$existing"
    return
  fi

  user=$(sanitize "${USER:-${USERNAME:-codex}}")
  host=$(hostname 2>/dev/null | cut -d '.' -f 1 | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//' | cut -c1-20)
  suffix=$(date +%s | tail -c 7)
  printf 'codex-%s-%s-%s' "${user:-codex}" "${host:-local}" "$suffix" | cut -c1-64
}

write_file() {
  local path="$1"
  local content="$2"
  printf '%s' "$content" > "$path"
}

create_workspace() {
  local base_url="$1"
  local name="$2"
  curl -fsS \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg name "$name" '{name: $name}')" \
    "${base_url}/v1/workspaces" 2>/dev/null || true
}

register_v1_agents() {
  local base_url="$1"
  local workspace_key="$2"
  local agent_name="$3"
  curl -fsS \
    -X POST \
    -H "Authorization: Bearer ${workspace_key}" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg name "$agent_name" '{name: $name, agent_type: "agent", type: "agent"}')" \
    "${base_url}/v1/agents" 2>/dev/null || true
}

register_v1_register() {
  local base_url="$1"
  local workspace_key="$2"
  local agent_name="$3"
  curl -fsS \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg workspace "$workspace_key" --arg name "$agent_name" '{workspace: $workspace, name: $name, cli: "codex", type: "agent"}')" \
    "${base_url}/v1/register" 2>/dev/null || true
}

persist_state() {
  local base_url="$1"
  local workspace_key="$2"
  local workspace_id="$3"
  local agent_id="$4"
  local agent_name="$5"
  local token="$6"

  write_file "$KEY_FILE" "$workspace_key"
  write_file "$TOKEN_FILE" "$token"
  jq -nc \
    --arg baseUrl "$base_url" \
    --arg workspaceKey "$workspace_key" \
    --arg workspaceId "$workspace_id" \
    --arg agentId "$agent_id" \
    --arg agentName "$agent_name" \
    --arg token "$token" \
    --arg updatedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      baseUrl: $baseUrl,
      workspaceKey: $workspaceKey,
      workspaceId: $workspaceId,
      agentId: $agentId,
      agentName: $agentName,
      token: $token,
      cli: "codex",
      updatedAt: $updatedAt
    }' > "$STATE_FILE"
}

main() {
  load_env

  if ! command_exists curl || ! command_exists jq; then
    exit 0
  fi

  mkdir -p "$RELAY_DIR"

  local base_url workspace_key workspace_id agent_name registration token registered_name agent_id
  base_url=$(normalize_base_url "${RELAY_BASE_URL:-}")
  workspace_key=$(trim "${RELAY_API_KEY:-}")
  workspace_id=""

  if [ -z "$workspace_key" ] && [ -s "$KEY_FILE" ]; then
    workspace_key=$(trim "$(cat "$KEY_FILE" 2>/dev/null || true)")
  fi

  if [ -z "$workspace_key" ]; then
    local created
    created=$(create_workspace "$base_url" "$(derive_workspace_name)")
    workspace_key=$(json_value "$created" '.api_key')
    [ -z "$workspace_key" ] && workspace_key=$(json_value "$created" '.apiKey')
    [ -z "$workspace_key" ] && workspace_key=$(json_value "$created" '.data.api_key')
    [ -z "$workspace_key" ] && workspace_key=$(json_value "$created" '.data.apiKey')
    workspace_id=$(json_value "$created" '.workspace_id')
    [ -z "$workspace_id" ] && workspace_id=$(json_value "$created" '.workspaceId')
    [ -z "$workspace_id" ] && workspace_id=$(json_value "$created" '.data.workspace_id')
    [ -z "$workspace_id" ] && workspace_id=$(json_value "$created" '.data.workspaceId')
  fi

  [ -z "$workspace_key" ] && exit 0

  agent_name=$(derive_agent_name)
  registration=$(register_v1_agents "$base_url" "$workspace_key" "$agent_name")
  if [ -z "$registration" ]; then
    registration=$(register_v1_register "$base_url" "$workspace_key" "$agent_name")
  fi
  [ -z "$registration" ] && exit 0

  token=$(json_value "$registration" '.token')
  [ -z "$token" ] && token=$(json_value "$registration" '.data.token')
  registered_name=$(json_value "$registration" '.name')
  [ -z "$registered_name" ] && registered_name=$(json_value "$registration" '.data.name')
  agent_id=$(json_value "$registration" '.id')
  [ -z "$agent_id" ] && agent_id=$(json_value "$registration" '.agent_id')
  [ -z "$agent_id" ] && agent_id=$(json_value "$registration" '.data.id')
  [ -z "$agent_id" ] && agent_id=$(json_value "$registration" '.data.agent_id')
  [ -z "$workspace_id" ] && workspace_id=$(json_value "$registration" '.workspace_id')
  [ -z "$workspace_id" ] && workspace_id=$(json_value "$registration" '.workspaceId')
  [ -z "$workspace_id" ] && workspace_id=$(json_value "$registration" '.data.workspace_id')
  [ -z "$workspace_id" ] && workspace_id=$(json_value "$registration" '.data.workspaceId')

  [ -z "$token" ] && exit 0
  [ -z "$registered_name" ] && registered_name="$agent_name"
  [ -z "$agent_id" ] && agent_id="$registered_name"
  [ -z "$workspace_id" ] && workspace_id="ws_unknown"

  persist_state "$base_url" "$workspace_key" "$workspace_id" "$agent_id" "$registered_name" "$token"
}

main "$@"
