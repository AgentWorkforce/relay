#!/bin/bash
#
# E2E Test for Agent Relay
# Tests the full agent lifecycle: up -> spawn -> release -> down
#
# Usage:
#   ./scripts/e2e-test.sh                    # Run with ANTHROPIC_API_KEY from env
#   ./scripts/e2e-test.sh --daemon-only      # Test daemon without spawning agent
#   ./scripts/e2e-test.sh --port 3888        # Use custom port
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
while [[ $# -gt 0 ]]; do
  case $1 in
    --daemon-only)
      DAEMON_ONLY=true
      shift
      ;;
    --port)
      DASHBOARD_PORT="$2"
      shift 2
      ;;
    --port=*)
      DASHBOARD_PORT="${1#*=}"
      shift
      ;;
    *)
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

# Cross-platform timeout function (macOS doesn't have timeout by default)
# Returns 124 on timeout (like GNU timeout)
run_with_timeout() {
  local timeout_sec=$1
  shift
  if command -v timeout &> /dev/null; then
    timeout "$timeout_sec" "$@"
  elif command -v gtimeout &> /dev/null; then
    gtimeout "$timeout_sec" "$@"
  else
    # Fallback: run without timeout but with a background monitor
    "$@" &
    local pid=$!
    local count=0
    while kill -0 $pid 2>/dev/null; do
      sleep 1
      count=$((count + 1))
      if [ $count -ge $timeout_sec ]; then
        kill -9 $pid 2>/dev/null
        wait $pid 2>/dev/null
        return 124
      fi
    done
    wait $pid
    return $?
  fi
}

# Ensure we're in the project directory
cd "$PROJECT_DIR"

# Determine which CLI command to use
# ALWAYS prefer local dist to test the actual build, fall back to global only if local doesn't exist
if [ -f "$PROJECT_DIR/dist/src/cli/index.js" ]; then
  CLI_CMD="$PROJECT_DIR/dist/src/cli/index.js"
elif command -v agent-relay &> /dev/null; then
  CLI_CMD="agent-relay"
else
  echo "ERROR: No CLI found. Run 'npm run build' first."
  exit 1
fi

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
log_info "  CLI command:    $CLI_CMD"

# Cleanup function (safety net - runs on exit/error)
cleanup() {
  echo ""
  log_phase "Cleanup (safety net)"

  # Try to release agent if it exists
  if [ "$DAEMON_ONLY" = false ]; then
    run_with_timeout 5 "$CLI_CMD" release "$AGENT_NAME" --port "$DASHBOARD_PORT" 2>/dev/null || true
  fi

  # Stop daemon (with timeout to prevent hanging)
  log_info "Ensuring daemon is stopped..."
  run_with_timeout 10 "$CLI_CMD" down --force --timeout 5000 2>/dev/null || true

  # Force kill any remaining processes if timeout occurred
  pkill -9 -f "relay-dashboard-server.*--port.*$DASHBOARD_PORT" 2>/dev/null || true

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

# Kill any existing daemon (with timeout to prevent hanging)
run_with_timeout 10 "$CLI_CMD" down --force --timeout 5000 2>/dev/null || true

# Kill any process using our target port (ensures dashboard can bind)
if command -v lsof &> /dev/null; then
  lsof -ti:$DASHBOARD_PORT | xargs kill -9 2>/dev/null || true
fi
sleep 1

# Start daemon in background, redirect output to log file
DAEMON_LOG="$PROJECT_DIR/.agent-relay/e2e-daemon.log"
mkdir -p "$(dirname "$DAEMON_LOG")"
"$CLI_CMD" up --dashboard --port "$DASHBOARD_PORT" > "$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
log_info "Daemon started (PID: $DAEMON_PID)"
log_info "Daemon log: $DAEMON_LOG"

# Wait for daemon to be ready (check health endpoint)
log_info "Waiting for daemon to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${DASHBOARD_PORT}/health" > /dev/null 2>&1; then
    log_info "Daemon is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    log_error "Daemon failed to start within 30 seconds"
    log_error "Daemon log tail:"
    tail -30 "$DAEMON_LOG" 2>/dev/null || echo "(no log)"
    exit 1
  fi
  # Show progress every 5 seconds
  if [ $((i % 5)) -eq 0 ]; then
    echo "  Still waiting... (${i}s)"
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

# Phase 2: Test CLI Commands
log_phase "Phase 2: Testing CLI Commands"

# Test --version flag
log_info "Testing: agent-relay --version"
VERSION_OUTPUT=$("$CLI_CMD" --version)
if [ -z "$VERSION_OUTPUT" ]; then
  log_error "--version returned empty output"
  exit 1
fi
log_info "  Output: $VERSION_OUTPUT"

# Test version command
log_info "Testing: agent-relay version"
if ! "$CLI_CMD" version > /dev/null 2>&1; then
  log_error "version command failed"
  exit 1
fi

# Test status command (with timeout to ensure it doesn't hang)
log_info "Testing: agent-relay status (with 10s timeout)"
if ! run_with_timeout 10 "$CLI_CMD" status; then
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    log_error "status command timed out (hung for >10s)"
  else
    log_error "status command failed with exit code $EXIT_CODE"
  fi
  exit 1
fi
log_info "  status command completed without hanging"

# Test agents command (should show only Dashboard initially)
log_info "Testing: agent-relay agents"
"$CLI_CMD" agents || true

# Test agents --json and verify no user agents (only Dashboard)
log_info "Testing: agent-relay agents --json"
# Filter to only get JSON line (skip any log output like dotenv messages)
AGENTS_JSON=$("$CLI_CMD" agents --json 2>/dev/null | grep '^\[')
if [ -z "$AGENTS_JSON" ]; then
  log_error "agents --json returned empty output"
  exit 1
fi

# Count agents (excluding Dashboard which is internal)
AGENT_COUNT=$(echo "$AGENTS_JSON" | jq '[.[] | select(.name != "Dashboard")] | length' 2>/dev/null || echo "0")
log_info "  User agents before spawn: $AGENT_COUNT"
if [ "$AGENT_COUNT" != "0" ]; then
  log_error "Expected 0 user agents before spawn, got $AGENT_COUNT"
  echo "$AGENTS_JSON" | jq . 2>/dev/null || echo "$AGENTS_JSON"
  exit 1
fi
log_info "  VERIFIED: No user agents connected (as expected)"

# Test who command
log_info "Testing: agent-relay who"
"$CLI_CMD" who || true

# Test history command (hidden but functional)
log_info "Testing: agent-relay history"
"$CLI_CMD" history --limit 5 2>/dev/null || true

# Test read command (should fail gracefully with invalid ID)
log_info "Testing: agent-relay read (with invalid ID)"
"$CLI_CMD" read invalid-id 2>/dev/null || true

# Test update --check (just checks, doesn't install)
log_info "Testing: agent-relay update --check"
"$CLI_CMD" update --check 2>/dev/null || true

# Test doctor command
log_info "Testing: agent-relay doctor"
"$CLI_CMD" doctor 2>/dev/null || true

# Test health command
log_info "Testing: agent-relay health"
"$CLI_CMD" health 2>/dev/null || true

# Test cloud status (should work even if not linked)
log_info "Testing: agent-relay cloud status"
"$CLI_CMD" cloud status 2>/dev/null || true

# Test create-agent --help (don't actually wrap anything)
log_info "Testing: agent-relay create-agent --help"
"$CLI_CMD" create-agent --help > /dev/null 2>&1 || true

# Test bridge --help
log_info "Testing: agent-relay bridge --help"
"$CLI_CMD" bridge --help > /dev/null 2>&1 || true

log_info "All CLI command tests passed!"

# Phase 3: Spawn agent
log_phase "Phase 3: Spawning Claude Agent"

log_info "Spawning agent '$AGENT_NAME'..."
"$CLI_CMD" spawn "$AGENT_NAME" claude "You are a test agent. Say 'Ready for testing' and then wait. Do not exit until you receive a message telling you to exit." --port "$DASHBOARD_PORT"

SPAWN_EXIT_CODE=$?
if [ $SPAWN_EXIT_CODE -ne 0 ]; then
  log_error "Spawn command failed with exit code $SPAWN_EXIT_CODE"
  exit 1
fi
log_info "Spawn command succeeded!"

# Phase 4: Wait for agent registration
log_phase "Phase 4: Verifying Agent Registration"

log_info "Polling for agent registration (timeout: ${SPAWN_TIMEOUT}s)..."
START_TIME=$(date +%s)

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  # Use CLI agents command to check registration (--json for parseable output)
  # Capture full JSON (skip any preamble lines before the array)
  RAW_AGENTS=$("$CLI_CMD" agents --json 2>/dev/null || true)
  AGENTS=$(echo "$RAW_AGENTS" | sed -n '/^\[/,$p')
  if [ -z "$AGENTS" ] || ! echo "$AGENTS" | jq empty >/dev/null 2>&1; then
    AGENTS="[]"
  fi

  # Check if our agent is registered
  if echo "$AGENTS" | jq -e --arg name "$AGENT_NAME" '.[] | select(.name == $name)' >/dev/null 2>&1; then
    echo ""
    log_info "SUCCESS: Agent '$AGENT_NAME' registered after ${ELAPSED}s"

    # Verify exactly 1 user agent
    AGENT_COUNT=$(echo "$AGENTS" | jq '[.[] | select(.name != "Dashboard")] | length' 2>/dev/null || echo "0")
    log_info "  User agents after spawn: $AGENT_COUNT"
    if [ "$AGENT_COUNT" != "1" ]; then
      log_error "Expected 1 user agent after spawn, got $AGENT_COUNT"
      echo "$AGENTS" | jq . 2>/dev/null || echo "$AGENTS"
      exit 1
    fi
    log_info "  VERIFIED: Exactly 1 user agent connected"
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
    "$CLI_CMD" agents 2>/dev/null || true
    exit 1
  fi

  sleep 2
done

# Phase 5: Release agent
log_phase "Phase 5: Releasing Agent"

log_info "Releasing agent '$AGENT_NAME'..."
"$CLI_CMD" release "$AGENT_NAME" --port "$DASHBOARD_PORT"

RELEASE_EXIT_CODE=$?
if [ $RELEASE_EXIT_CODE -ne 0 ]; then
  log_error "Release command failed with exit code $RELEASE_EXIT_CODE"
  exit 1
fi
log_info "Release command succeeded!"

# Phase 6: Verify agent was released
log_phase "Phase 6: Verifying Agent Release"

# Wait for agent to fully disconnect
sleep 3

# Poll for agent to be removed (may take a moment)
log_info "Verifying agent was released..."
RELEASE_VERIFIED=false
for i in $(seq 1 10); do
  # Filter to only get JSON line (skip any log output like dotenv messages)
  AGENTS_AFTER=$("$CLI_CMD" agents --json 2>/dev/null | grep '^\[' || echo "[]")
  AGENT_COUNT=$(echo "$AGENTS_AFTER" | jq '[.[] | select(.name != "Dashboard")] | length' 2>/dev/null || echo "0")

  if [ "$AGENT_COUNT" = "0" ]; then
    RELEASE_VERIFIED=true
    break
  fi

  if [ $i -lt 10 ]; then
    echo "  Still waiting for agent to disconnect... (${i}s)"
    sleep 1
  fi
done

if [ "$RELEASE_VERIFIED" = true ]; then
  log_info "  User agents after release: 0"
  log_info "  VERIFIED: No user agents connected (as expected)"
  log_info "SUCCESS: Agent '$AGENT_NAME' released and disconnected"
else
  log_error "Expected 0 user agents after release, got $AGENT_COUNT"
  echo "$AGENTS_AFTER" | jq . 2>/dev/null || echo "$AGENTS_AFTER"
  exit 1
fi

# Phase 7: Stop daemon gracefully (verify down doesn't hang)
log_phase "Phase 7: Stopping Daemon"

log_info "Testing: agent-relay down (with 15s timeout)"
if ! run_with_timeout 15 "$CLI_CMD" down --timeout 10000; then
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    log_error "down command timed out (hung for >15s)"
    exit 1
  else
    # Exit code 1 might mean "not running" which is ok
    log_warn "down command exited with code $EXIT_CODE (may already be stopped)"
  fi
else
  log_info "  down command completed without hanging"
fi

# Verify daemon is actually stopped
sleep 1
if curl -s "http://127.0.0.1:${DASHBOARD_PORT}/health" > /dev/null 2>&1; then
  log_error "Daemon still responding after down command"
  exit 1
fi
log_info "  VERIFIED: Daemon is stopped"

echo ""
log_info "=== E2E TEST PASSED ==="
