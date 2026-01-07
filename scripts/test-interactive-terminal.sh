#!/usr/bin/env bash
#
# Test Interactive Terminal Flow
#
# This script sets up a Docker environment to test the interactive terminal
# WITHOUT requiring GitHub OAuth.
#
# Usage:
#   ./scripts/test-interactive-terminal.sh [command]
#
# Commands:
#   start   - Build, start, and auto-setup test user/workspace
#   stop    - Stop all containers
#   logs    - Show logs
#   rebuild - Rebuild images with code changes
#   clean   - Stop and remove all data
#   setup   - Just run the test setup (if containers already running)
#

set -euo pipefail

COMPOSE_FILE="docker-compose.dev.yml"
PROJECT_NAME="agent-relay-dev"
CLOUD_URL="http://localhost:4567"

log() {
  echo -e "\033[1;36m[test-terminal]\033[0m $*"
}

err() {
  echo -e "\033[1;31m[test-terminal]\033[0m $*" >&2
}

success() {
  echo -e "\033[1;32m[test-terminal]\033[0m $*"
}

check_docker() {
  if ! docker info >/dev/null 2>&1; then
    err "Docker is not running. Please start Docker and try again."
    exit 1
  fi
}

wait_for_cloud() {
  log "Waiting for cloud service..."
  for i in {1..30}; do
    if curl -sf "$CLOUD_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_workspace() {
  log "Waiting for workspace service..."
  for i in {1..20}; do
    if curl -sf "http://localhost:3888/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Setup test user and workspace (no OAuth needed!)
setup_test_environment() {
  log "Setting up test environment (no OAuth required)..."

  # Create a cookie jar for session
  COOKIE_JAR=$(mktemp)
  trap "rm -f $COOKIE_JAR" EXIT

  # Step 1: Login as test user
  log "Creating test user and logging in..."
  LOGIN_RESULT=$(curl -sf -X POST "$CLOUD_URL/api/test/login-as" \
    -H "Content-Type: application/json" \
    -d '{"username": "terminal-tester"}' \
    -c "$COOKIE_JAR" 2>&1) || {
    err "Failed to login. Is the cloud service running?"
    err "Response: $LOGIN_RESULT"
    return 1
  }

  USER_ID=$(echo "$LOGIN_RESULT" | jq -r '.userId // empty')
  if [[ -z "$USER_ID" ]]; then
    err "Failed to get user ID from login response"
    err "Response: $LOGIN_RESULT"
    return 1
  fi
  log "Logged in as user: $USER_ID"

  # Step 2: Create mock workspace pointing to the Docker workspace
  log "Creating test workspace..."
  WORKSPACE_RESULT=$(curl -sf -X POST "$CLOUD_URL/api/test/create-mock-workspace" \
    -H "Content-Type: application/json" \
    -d '{"name": "Terminal Test Workspace", "publicUrl": "http://workspace:3888"}' \
    -b "$COOKIE_JAR" 2>&1) || {
    err "Failed to create workspace"
    err "Response: $WORKSPACE_RESULT"
    return 1
  }

  WORKSPACE_ID=$(echo "$WORKSPACE_RESULT" | jq -r '.workspaceId // empty')
  if [[ -z "$WORKSPACE_ID" ]]; then
    err "Failed to get workspace ID"
    err "Response: $WORKSPACE_RESULT"
    return 1
  fi

  success "Test environment ready!"
  echo ""
  log "=============================================="
  log "  Interactive Terminal Test Environment"
  log "=============================================="
  echo ""
  log "Workspace ID: $WORKSPACE_ID"
  echo ""
  log "Test the interactive terminal (auto-login included):"
  echo ""
  echo "  Claude: $CLOUD_URL/api/test/auto-login?redirect=/providers/setup/claude?workspace=$WORKSPACE_ID"
  echo ""
  echo "  Codex:  $CLOUD_URL/api/test/auto-login?redirect=/providers/setup/codex?workspace=$WORKSPACE_ID"
  echo ""
  log "Or access the dashboard:"
  echo ""
  echo "  $CLOUD_URL/api/test/auto-login?redirect=/app"
  echo ""
  log "The terminal will show the CLI starting up."
  log "Type directly to interact with prompts."
  log "Auth URLs will trigger a popup modal."
  echo ""
  log "Commands:"
  log "  $0 logs     - View service logs"
  log "  $0 rebuild  - Rebuild after code changes"
  log "  $0 stop     - Stop services"
  log "  $0 clean    - Remove all data"
  echo ""
}

start_services() {
  check_docker

  log "Building images with latest code..."
  docker compose -f "$COMPOSE_FILE" build cloud workspace

  log "Starting services (including workspace)..."
  docker compose -f "$COMPOSE_FILE" --profile workspace up -d

  if ! wait_for_cloud; then
    err "Cloud service failed to start. Check logs with: $0 logs"
    exit 1
  fi

  if ! wait_for_workspace; then
    err "Workspace service failed to start. Check logs with: $0 logs"
    exit 1
  fi

  # Auto-setup test environment
  sleep 2
  setup_test_environment
}

rebuild_services() {
  check_docker
  log "Rebuilding images..."
  docker compose -f "$COMPOSE_FILE" build cloud workspace --no-cache
  log "Restarting services..."
  docker compose -f "$COMPOSE_FILE" --profile workspace up -d

  if ! wait_for_cloud; then
    err "Cloud service failed to start after rebuild"
    exit 1
  fi

  if ! wait_for_workspace; then
    err "Workspace service failed to start after rebuild"
    exit 1
  fi

  sleep 2
  setup_test_environment
}

stop_services() {
  check_docker
  log "Stopping services..."
  docker compose -f "$COMPOSE_FILE" --profile workspace down
  log "Services stopped."
}

show_logs() {
  check_docker
  docker compose -f "$COMPOSE_FILE" --profile workspace logs -f
}

clean_all() {
  check_docker
  log "Stopping services and removing volumes..."
  docker compose -f "$COMPOSE_FILE" --profile workspace down -v
  log "Cleaned up."
}

# Main
cd "$(dirname "$0")/.."

case "${1:-start}" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  logs)
    show_logs
    ;;
  rebuild)
    rebuild_services
    ;;
  clean)
    clean_all
    ;;
  setup)
    # Just run setup (containers must be running)
    if ! curl -sf "$CLOUD_URL/health" >/dev/null 2>&1; then
      err "Cloud service not running. Use '$0 start' first."
      exit 1
    fi
    setup_test_environment
    ;;
  help|--help|-h)
    echo "Usage: $0 {start|stop|logs|rebuild|clean|setup|help}"
    echo ""
    echo "Commands:"
    echo "  start   - Build, start, and auto-setup test environment"
    echo "  stop    - Stop all containers"
    echo "  logs    - Show service logs"
    echo "  rebuild - Rebuild images and restart"
    echo "  clean   - Stop and remove all data"
    echo "  setup   - Re-run test setup (if already running)"
    ;;
  *)
    echo "Usage: $0 {start|stop|logs|rebuild|clean|setup|help}"
    exit 1
    ;;
esac
