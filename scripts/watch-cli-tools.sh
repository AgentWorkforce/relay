#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_DIR="${npm_config_project:-$PWD}"

while [ "$#" -gt 0 ]; do
  case "$1" in
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
      # Other flags (e.g. --tool) are accepted for compatibility but ignored.
      :
      ;;
  esac
  shift
done

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory not found: $PROJECT_DIR"
  exit 1
fi

export RUST_LOG=debug
export AGENT_RELAY_MCP_COMMAND="node dist/cli/agent-relay-mcp.js"

concurrently -k \
  "(cd \"$CLI_REPO_DIR\" && npm run dev:watch)" \
  "cd \"$PROJECT_DIR\" && node --watch \"$CLI_REPO_DIR/packages/cli/dist/cli/index.js\" up"
