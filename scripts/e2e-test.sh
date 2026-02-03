#!/bin/bash
#
# E2E Test for Agent Relay
# Tests the full agent lifecycle: up -> spawn -> release -> down
#
# Usage:
#   ./scripts/e2e-test.sh              # Run with ANTHROPIC_API_KEY from env
#   ./scripts/e2e-test.sh --daemon-only # Test daemon without spawning agent
#
# Requires: ANTHROPIC_API_KEY environment variable (unless --daemon-only)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
AGENT_NAME="e2e-test-agent"
DASHBOARD_PORT=3889  # Use different port to avoid conflicts with running instances
SPAWN_TIMEOUT=120
DAEMON_ONLY=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --daemon-only)
      DAEMON_ONLY=true
      shift
      ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_phase() { echo -e "\n${CYAN}========================================${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}========================================${NC}\n"; }

# Ensure we're in the project directory
cd "$PROJECT_DIR"

echo ""
log_phase "E2E Test: Full Agent Lifecycle"

# Check for API key (unless daemon-only mode)
if [ "$DAEMON_ONLY" = false ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  log_error "ANTHROPIC_API_KEY environment variable not set"
  echo ""
  echo "Options:"
  echo "  1. Run with API key:    ANTHROPIC_API_KEY=sk-... ./scripts/e2e-test.sh"
  echo "  2. Run daemon-only:     ./scripts/e2e-test.sh --daemon-only"
  exit 1
fi

log_info "Configuration:"
log_info "  Agent name:     $AGENT_NAME"
log_info "  Dashboard port: $DASHBOARD_PORT"
log_info "  Daemon only:    $DAEMON_ONLY"

# Cleanup function
cleanup() {
  echo ""
  log_phase "Cleanup"

  # Try to release agent if it exists
  if [ "$DAEMON_ONLY" = false ]; then
    "$PROJECT_DIR/dist/src/cli/index.js" release "$AGENT_NAME" --port "$DASHBOARD_PORT" 2>/dev/null || true
  fi

  # Stop daemon
  log_info "Stopping daemon..."
  "$PROJECT_DIR/dist/src/cli/index.js" down --force --timeout 10000 2>/dev/null || true

  log_info "Cleanup complete."
}
trap cleanup EXIT

# Phase 0: Build check
log_phase "Phase 0: Build Check"

if [ ! -f "$PROJECT_DIR/dist/src/cli/index.js" ]; then
  log_info "Building project..."
  npm run build
else
  log_info "Build exists, skipping (run 'npm run build' to rebuild)"
fi

# Phase 1: Start daemon with dashboard
log_phase "Phase 1: Starting Daemon"

# Kill any existing daemon on this port
"$PROJECT_DIR/dist/src/cli/index.js" down --force --timeout 5000 2>/dev/null || true
sleep 1

"$PROJECT_DIR/dist/src/cli/index.js" up --dashboard --port "$DASHBOARD_PORT" &
DAEMON_PID=$!
log_info "Daemon started (PID: $DAEMON_PID)"

# Wait for daemon to be ready (check health endpoint)
log_info "Waiting for daemon to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${DASHBOARD_PORT}/health" > /dev/null 2>&1; then
    log_info "Daemon is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    log_error "Daemon failed to start within 30 seconds"
    exit 1
  fi
  sleep 1
done

# If daemon-only mode, stop here
if [ "$DAEMON_ONLY" = true ]; then
  log_phase "Daemon-Only Test Complete"
  log_info "Daemon is running at http://127.0.0.1:$DASHBOARD_PORT"
  log_info "Health: $(curl -s http://127.0.0.1:${DASHBOARD_PORT}/health)"
  echo ""
  log_info "=== DAEMON TEST PASSED ==="
  exit 0
fi

# Phase 2: Spawn agent
log_phase "Phase 2: Spawning Claude Agent"

log_info "Spawning agent '$AGENT_NAME'..."
"$PROJECT_DIR/dist/src/cli/index.js" spawn "$AGENT_NAME" claude "Say hello and then immediately exit. Do not do any work." --port "$DASHBOARD_PORT"

SPAWN_EXIT_CODE=$?
if [ $SPAWN_EXIT_CODE -ne 0 ]; then
  log_error "Spawn command failed with exit code $SPAWN_EXIT_CODE"
  exit 1
fi
log_info "Spawn command succeeded!"

# Phase 3: Wait for agent registration
log_phase "Phase 3: Verifying Agent Registration"

log_info "Polling for agent registration (timeout: ${SPAWN_TIMEOUT}s)..."
START_TIME=$(date +%s)

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  # Query daemon for connected agents
  AGENTS=$(curl -s "http://127.0.0.1:${DASHBOARD_PORT}/api/agents" 2>/dev/null || echo "[]")

  # Check if our agent is registered
  if echo "$AGENTS" | grep -q "\"$AGENT_NAME\""; then
    echo ""
    log_info "SUCCESS: Agent '$AGENT_NAME' registered after ${ELAPSED}s"
    echo ""
    log_info "Connected agents:"
    echo "$AGENTS" | jq . 2>/dev/null || echo "$AGENTS"
    break
  fi

  echo "[$(date +%T)] +${ELAPSED}s: Waiting for agent registration..."

  # Check timeout
  if [ $ELAPSED -ge $SPAWN_TIMEOUT ]; then
    echo ""
    log_error "Agent '$AGENT_NAME' did not register within ${SPAWN_TIMEOUT}s"
    echo ""
    log_info "Connected agents:"
    echo "$AGENTS" | jq . 2>/dev/null || echo "$AGENTS"
    exit 1
  fi

  sleep 2
done

# Phase 4: Release agent
log_phase "Phase 4: Releasing Agent"

log_info "Releasing agent '$AGENT_NAME'..."
"$PROJECT_DIR/dist/src/cli/index.js" release "$AGENT_NAME" --port "$DASHBOARD_PORT"

RELEASE_EXIT_CODE=$?
if [ $RELEASE_EXIT_CODE -ne 0 ]; then
  log_error "Release command failed with exit code $RELEASE_EXIT_CODE"
  exit 1
fi
log_info "Release command succeeded!"

# Phase 5: Verify agent was released
log_phase "Phase 5: Verifying Agent Release"

sleep 3
AGENTS_AFTER=$(curl -s "http://127.0.0.1:${DASHBOARD_PORT}/api/agents" 2>/dev/null || echo "[]")

if echo "$AGENTS_AFTER" | grep -q "\"$AGENT_NAME\""; then
  log_warn "Agent still appears in list after release (may be disconnecting)"
  echo "Agents: $AGENTS_AFTER"
else
  log_info "SUCCESS: Agent '$AGENT_NAME' no longer in agents list"
fi

# Phase 6: Stop daemon (handled by cleanup trap)
echo ""
log_info "=== E2E TEST PASSED ==="
