#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CLI_TOOL="claude"
if [ -n "${npm_config_tool:-}" ]; then
  CLI_TOOL="$npm_config_tool"
fi

DASHBOARD_PORT=3888
if [ -n "${npm_config_port:-}" ]; then
  DASHBOARD_PORT="$npm_config_port"
fi

PROJECT_DIR="/Users/khaliqgant/Projects/agent-workforce/test-broker-new"
if [ -n "${npm_config_project:-}" ]; then
  PROJECT_DIR="$npm_config_project"
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory not found: $PROJECT_DIR"
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tool=*)
      CLI_TOOL="${1#*=}"
      ;;
    --tool)
      shift
      if [ "$#" -gt 0 ]; then
        CLI_TOOL="$1"
      fi
      ;;
    --port=*)
      DASHBOARD_PORT="${1#*=}"
      ;;
    --port)
      shift
      if [ "$#" -gt 0 ]; then
        DASHBOARD_PORT="$1"
      fi
      ;;
    --project=*)
      PROJECT_DIR="${1#*=}"
      ;;
    --project)
      shift
      if [ "$#" -gt 0 ]; then
        PROJECT_DIR="$1"
      fi
      ;;
    *)
      if [ -z "$1" ]; then
        :
      elif [ "$1" = "--" ]; then
        :
      else
        CLI_TOOL="$1"
      fi
      ;;
  esac
  shift
done

if [ -z "${CLI_TOOL}" ]; then
  CLI_TOOL="claude"
fi

export RUST_LOG=debug
export RELAY_DASHBOARD_STATIC_DIR=/Users/khaliqgant/Projects/agent-workforce/relay-dashboard/packages/dashboard/out
export RELAYCAST_MCP_COMMAND="node /Users/khaliqgant/Projects/agent-workforce/relaycast/packages/mcp/dist/stdio.js"
export AGENT_RELAY_BIN=/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/target/debug/agent-relay-broker
export RELAY_DASHBOARD_BINARY=/Users/khaliqgant/Projects/agent-workforce/relay-dashboard/packages/dashboard-server/dist/start.js

concurrently -k \
  "(cd \"$CLI_REPO_DIR\" && npm run dev:watch)" \
  "cd \"$PROJECT_DIR\" && node --watch /Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/dist/src/cli/bootstrap.js start dashboard.js ${CLI_TOOL} --port ${DASHBOARD_PORT}"
