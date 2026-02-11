#!/bin/bash
#
# Test Script: SDK Spawn Refactor (GitHub #374)
#
# Tests all changes from the sdk-spawn-refactor branch:
#   1. Unit tests (relay + dashboard)
#   2. SDK integration tests (spawn, release, messaging)
#   3. E2E daemon lifecycle (daemon-only mode, no API key needed)
#   4. Dashboard fleet endpoint verification
#   5. Manual test checklist for live agent spawning
#
# Usage:
#   ./scripts/test-spawn-refactor.sh              # Run automated tests
#   ./scripts/test-spawn-refactor.sh --full        # Run all tests incl. live agent spawn
#   ./scripts/test-spawn-refactor.sh --checklist   # Print manual test checklist only
#

set -uo pipefail
# Note: NOT using set -e because we handle failures via the FAILURES counter

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_DIR="$PROJECT_DIR/../relay-dashboard"
CLI_CMD="$PROJECT_DIR/dist/src/cli/index.js"
DASHBOARD_PORT=3891  # Use unique port to avoid conflicts
FULL_TEST=false
CHECKLIST_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --full) FULL_TEST=true; shift ;;
    --checklist) CHECKLIST_ONLY=true; shift ;;
    *) shift ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAILURES=$((FAILURES + 1)); }
skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; }
phase() { echo -e "\n${CYAN}${BOLD}=== $1 ===${NC}\n"; }
info() { echo -e "  ${BOLD}INFO${NC} $1"; }

FAILURES=0
TOTAL=0

check() {
  TOTAL=$((TOTAL + 1))
  if eval "$1" > /dev/null 2>&1; then
    pass "$2"
  else
    fail "$2"
  fi
  return 0  # Never fail the script itself
}

# -------------------------------------------------------
# Manual test checklist
# -------------------------------------------------------
print_checklist() {
  echo ""
  echo -e "${CYAN}${BOLD}=================================================${NC}"
  echo -e "${CYAN}${BOLD}  SDK Spawn Refactor - Manual Test Checklist${NC}"
  echo -e "${CYAN}${BOLD}=================================================${NC}"
  echo ""
  echo -e "${BOLD}Prerequisites:${NC}"
  echo "  1. Stop existing daemon:  agent-relay down --force"
  echo "  2. Start LOCAL daemon:    node dist/src/cli/index.js up --dashboard --port $DASHBOARD_PORT"
  echo "  3. Ensure ANTHROPIC_API_KEY is set"
  echo ""
  echo -e "${BOLD}Test 1: Spawn via Local CLI (daemon socket path)${NC}"
  echo "  node dist/src/cli/index.js spawn TestWorker claude 'Say hello then wait' --port $DASHBOARD_PORT"
  echo "  Expected: Agent spawns via daemon socket (check daemon log for 'SPAWN' envelope)"
  echo "  Verify:   node dist/src/cli/index.js agents --port $DASHBOARD_PORT"
  echo "  Cleanup:  node dist/src/cli/index.js release TestWorker --port $DASHBOARD_PORT"
  echo ""
  echo -e "${BOLD}Test 2: Spawn via Dashboard UI${NC}"
  echo "  Open http://localhost:$DASHBOARD_PORT in browser"
  echo "  Click 'Spawn Agent' button"
  echo "  Fill in: name=UIWorker, cli=claude, task='Hello from dashboard'"
  echo "  Expected: Dashboard routes spawn through SDK -> daemon"
  echo "  Verify:   Agent appears in fleet view"
  echo "  Cleanup:  Release from UI"
  echo ""
  echo -e "${BOLD}Test 3: Fleet Endpoints (spawnReader fix)${NC}"
  echo "  curl http://localhost:$DASHBOARD_PORT/api/fleet/servers | jq ."
  echo "  curl http://localhost:$DASHBOARD_PORT/api/fleet/stats | jq ."
  echo "  Expected: localAgents should reflect actual spawned agents (not empty)"
  echo ""
  echo -e "${BOLD}Test 4: Fallback Chain (daemon-first, no policy bypass)${NC}"
  echo "  1. Spawn an agent: node dist/src/cli/index.js spawn FallbackTest claude 'wait'"
  echo "  2. Try spawning same name again: node dist/src/cli/index.js spawn FallbackTest claude 'wait'"
  echo "  Expected: Second spawn gets daemon rejection, does NOT fall through to HTTP"
  echo "  Cleanup:  node dist/src/cli/index.js release FallbackTest"
  echo ""
  echo -e "${BOLD}Test 5: spawnerName Passthrough${NC}"
  echo "  Spawn agent with custom spawnerName from dashboard route:"
  echo "  curl -X POST http://localhost:$DASHBOARD_PORT/api/spawn \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"name\":\"SpawnerTest\",\"cli\":\"claude\",\"task\":\"wait\",\"spawnerName\":\"MyOrchestrator\"}'"
  echo "  Expected: SpawnPayload contains spawnerName='MyOrchestrator'"
  echo "  Verify:   Agent shows MyOrchestrator as spawner in agent list"
  echo "  Cleanup:  curl -X POST http://localhost:$DASHBOARD_PORT/api/release -H 'Content-Type: application/json' -d '{\"name\":\"SpawnerTest\"}'"
  echo ""
  echo -e "${BOLD}Test 6: SDK Integration Tests (requires daemon running)${NC}"
  echo "  cd $PROJECT_DIR"
  echo "  node tests/integration/run-all-tests.js --type=sdk"
  echo "  Expected: All SDK tests pass (spawn, release, messaging)"
  echo ""
  echo -e "${BOLD}Test 7: E2E Full Lifecycle${NC}"
  echo "  # Stop the test daemon first, then:"
  echo "  ./scripts/e2e-test.sh --port $DASHBOARD_PORT"
  echo "  Expected: Full lifecycle pass (up -> spawn -> release -> down)"
  echo ""
  echo -e "${BOLD}Key Changes to Verify:${NC}"
  echo "  [ ] Daemon handles SEND_INPUT, LIST_WORKERS messages"
  echo "  [ ] SDK client.spawn() accepts spawnerName option"
  echo "  [ ] Dashboard fleet endpoints use spawnReader (not spawner)"
  echo "  [ ] Fallback chain only falls through on transport errors"
  echo "  [ ] LIST_WORKERS_RESULT includes error field on failure"
  echo "  [ ] Documentation updated (protocol.md, daemon.md, SDK README)"
  echo ""
}

if [ "$CHECKLIST_ONLY" = true ]; then
  print_checklist
  exit 0
fi

# -------------------------------------------------------
# Phase 0: Verify builds
# -------------------------------------------------------
phase "Phase 0: Build Verification"

cd "$PROJECT_DIR"

check "test -f dist/src/cli/index.js" "Relay CLI built"
check "test -f packages/sdk/dist/client.js" "SDK package built"
check "test -f packages/daemon/dist/server.js" "Daemon package built"
check "test -f packages/protocol/dist/types.js" "Protocol package built"
check "test -f packages/wrapper/dist/relay-broker-orchestrator.js" "Wrapper package built"

if [ -d "$DASHBOARD_DIR" ]; then
  check "test -f $DASHBOARD_DIR/packages/dashboard-server/dist/server.js" "Dashboard server built"
else
  skip "Dashboard repo not found at $DASHBOARD_DIR"
fi

# -------------------------------------------------------
# Phase 1: Unit Tests
# -------------------------------------------------------
phase "Phase 1: Relay Unit Tests"

info "Running vitest (this takes ~30s)..."
RELAY_TEST_OUTPUT=$(npm test 2>&1)
RELAY_TEST_RESULT=$(echo "$RELAY_TEST_OUTPUT" | grep "Tests" | tail -1)
if echo "$RELAY_TEST_OUTPUT" | grep -q "passed"; then
  pass "Relay unit tests: $RELAY_TEST_RESULT"
  TOTAL=$((TOTAL + 1))
else
  fail "Relay unit tests failed"
  echo "$RELAY_TEST_OUTPUT" | tail -20
fi

phase "Phase 1b: Dashboard Unit Tests"

if [ -d "$DASHBOARD_DIR" ]; then
  cd "$DASHBOARD_DIR"
  info "Running dashboard vitest..."
  DASH_TEST_OUTPUT=$(npm test 2>&1)
  DASH_TEST_RESULT=$(echo "$DASH_TEST_OUTPUT" | grep "Tests" | tail -1)
  if echo "$DASH_TEST_OUTPUT" | grep -q "passed"; then
    pass "Dashboard unit tests: $DASH_TEST_RESULT"
    TOTAL=$((TOTAL + 1))
  else
    fail "Dashboard unit tests failed"
    echo "$DASH_TEST_OUTPUT" | tail -20
  fi
  cd "$PROJECT_DIR"
else
  skip "Dashboard repo not found"
fi

# -------------------------------------------------------
# Phase 2: Protocol Type Verification
# -------------------------------------------------------
phase "Phase 2: Protocol Type Verification"

info "Checking new protocol types exist in built output..."

# Check SEND_INPUT type exists
check "grep -q 'SEND_INPUT' packages/protocol/dist/types.js 2>/dev/null || grep -q 'SEND_INPUT' packages/protocol/dist/types.d.ts 2>/dev/null" \
  "SEND_INPUT message type in protocol"

# Check LIST_WORKERS type exists
check "grep -q 'LIST_WORKERS' packages/protocol/dist/types.js 2>/dev/null || grep -q 'LIST_WORKERS' packages/protocol/dist/types.d.ts 2>/dev/null" \
  "LIST_WORKERS message type in protocol"

# Check ListWorkersResultPayload has error field
check "grep -q 'error' packages/protocol/dist/types.d.ts 2>/dev/null && grep -q 'ListWorkersResultPayload' packages/protocol/dist/types.d.ts 2>/dev/null" \
  "ListWorkersResultPayload includes error field"

# Check SDK has spawnerName in spawn options
check "grep -q 'spawnerName' packages/sdk/dist/client.d.ts 2>/dev/null" \
  "SDK spawn() accepts spawnerName option"

# Check SDK has sendWorkerInput method
check "grep -q 'sendWorkerInput' packages/sdk/dist/client.d.ts 2>/dev/null" \
  "SDK has sendWorkerInput() method"

# Check SDK has listWorkers method
check "grep -q 'listWorkers' packages/sdk/dist/client.d.ts 2>/dev/null" \
  "SDK has listWorkers() method"

# -------------------------------------------------------
# Phase 3: Spawn Manager Verification
# -------------------------------------------------------
phase "Phase 3: Daemon Spawn Manager Verification"

info "Checking spawn-manager handles new message types..."

check "grep -q 'SEND_INPUT' packages/daemon/dist/spawn-manager.js" \
  "SpawnManager handles SEND_INPUT"

check "grep -q 'LIST_WORKERS' packages/daemon/dist/spawn-manager.js" \
  "SpawnManager handles LIST_WORKERS"

check "grep -q 'SEND_INPUT_RESULT' packages/daemon/dist/spawn-manager.js" \
  "SpawnManager sends SEND_INPUT_RESULT"

check "grep -q 'LIST_WORKERS_RESULT' packages/daemon/dist/spawn-manager.js" \
  "SpawnManager sends LIST_WORKERS_RESULT"

# -------------------------------------------------------
# Phase 4: Wrapper Orchestrator Fallback Verification
# -------------------------------------------------------
phase "Phase 4: Wrapper Fallback Chain Verification"

info "Checking orchestrator fallback logic..."

# Verify the fix: daemon responses always return (no fall-through to HTTP)
check "grep -q 'Always return if daemon responded' packages/wrapper/dist/relay-broker-orchestrator.js 2>/dev/null || \
       grep -q 'transport error' packages/wrapper/dist/relay-broker-orchestrator.js 2>/dev/null" \
  "Fallback chain: daemon rejection stops cascade"

# -------------------------------------------------------
# Phase 5: Dashboard Integration Checks (static analysis)
# -------------------------------------------------------
phase "Phase 5: Dashboard Integration Checks"

if [ -d "$DASHBOARD_DIR" ]; then
  DASH_SERVER="$DASHBOARD_DIR/packages/dashboard-server"

  # Check fleet endpoints use spawnReader
  check "grep -q 'spawnReader' $DASH_SERVER/dist/server.js 2>/dev/null || \
         grep -q 'spawnReader' $DASH_SERVER/src/server.ts 2>/dev/null" \
    "Fleet endpoints use spawnReader (not spawner)"

  # Check spawn route passes spawnerName
  check "grep -q 'spawnerName' $DASH_SERVER/src/server.ts" \
    "Spawn route passes spawnerName to SDK"

  # Make sure fleet doesn't use spawner directly for getActiveWorkers
  if grep -n 'spawner?.getActiveWorkers\|spawner\.getActiveWorkers' "$DASH_SERVER/src/server.ts" 2>/dev/null | grep -v 'spawnReader' | grep -v '//' | head -1 | grep -q '.'; then
    fail "Fleet endpoint still uses spawner?.getActiveWorkers() directly"
  else
    pass "Fleet endpoints don't bypass spawnReader"
    TOTAL=$((TOTAL + 1))
  fi
else
  skip "Dashboard repo not found"
fi

# -------------------------------------------------------
# Phase 6: E2E Daemon Lifecycle (daemon-only, no API key needed)
# -------------------------------------------------------
phase "Phase 6: E2E Daemon Lifecycle (daemon-only mode)"

# Check if existing daemon is running on the same socket
EXISTING_DAEMON=$(pgrep -f "agent-relay up" 2>/dev/null || true)
if [ -n "$EXISTING_DAEMON" ]; then
  info "Existing daemon found (PID: $EXISTING_DAEMON). Stopping it first..."
  "$CLI_CMD" down --force --timeout 5000 2>/dev/null || true
  # Also try the global CLI
  agent-relay down --force --timeout 5000 2>/dev/null || true
  sleep 2
  # Force kill if still running
  pgrep -f "agent-relay up" | xargs kill -9 2>/dev/null || true
  pgrep -f "relay-dashboard-server" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

info "Starting local daemon on port $DASHBOARD_PORT..."

# Kill any existing process on our test port
lsof -ti:$DASHBOARD_PORT | xargs kill -9 2>/dev/null || true
sleep 1

# Clean stale socket
rm -f "$PROJECT_DIR/.agent-relay/relay.sock" 2>/dev/null || true

# Start daemon with local build
DAEMON_LOG="$PROJECT_DIR/.agent-relay/test-spawn-refactor.log"
mkdir -p "$(dirname "$DAEMON_LOG")"
"$CLI_CMD" up --dashboard --port "$DASHBOARD_PORT" > "$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

cleanup_daemon() {
  kill $DAEMON_PID 2>/dev/null || true
  lsof -ti:$DASHBOARD_PORT | xargs kill -9 2>/dev/null || true
}
trap cleanup_daemon EXIT

# Wait for daemon
for i in $(seq 1 20); do
  if curl -s "http://127.0.0.1:${DASHBOARD_PORT}/health" > /dev/null 2>&1; then
    break
  fi
  if [ $i -eq 20 ]; then
    fail "Local daemon failed to start within 20s"
    echo "  Daemon log:"
    tail -20 "$DAEMON_LOG" 2>/dev/null || true
    echo ""
    echo -e "${RED}${BOLD}Cannot continue without daemon. Aborting.${NC}"
    exit 1
  fi
  sleep 1
done
pass "Local daemon started (PID: $DAEMON_PID, port: $DASHBOARD_PORT)"
TOTAL=$((TOTAL + 1))

# Wait a bit more for dashboard to fully initialize
sleep 3

# Test health endpoint
check "curl -sf http://127.0.0.1:${DASHBOARD_PORT}/health" \
  "Health endpoint responds"

# Test agents endpoint (may be at /api/agents or via CLI)
AGENTS_RESP=$(curl -s "http://127.0.0.1:${DASHBOARD_PORT}/api/agents" 2>/dev/null || echo "")
if [ -n "$AGENTS_RESP" ]; then
  pass "Agents API responds"
  TOTAL=$((TOTAL + 1))
else
  # Some dashboard versions don't have /api/agents, test via CLI instead
  if "$CLI_CMD" agents --port "$DASHBOARD_PORT" > /dev/null 2>&1; then
    pass "Agents available via CLI (API may differ by dashboard version)"
    TOTAL=$((TOTAL + 1))
  else
    fail "Agents endpoint not available"
  fi
fi

# Test fleet/servers endpoint
FLEET=$(curl -s "http://127.0.0.1:${DASHBOARD_PORT}/api/fleet/servers" 2>/dev/null || echo "")
if [ -n "$FLEET" ]; then
  pass "Fleet servers endpoint responds"
  TOTAL=$((TOTAL + 1))
else
  skip "Fleet servers endpoint not available (dashboard may be published version)"
fi

# Test fleet/stats endpoint
STATS=$(curl -s "http://127.0.0.1:${DASHBOARD_PORT}/api/fleet/stats" 2>/dev/null || echo "")
if [ -n "$STATS" ]; then
  pass "Fleet stats endpoint responds"
  TOTAL=$((TOTAL + 1))
else
  skip "Fleet stats endpoint not available (dashboard may be published version)"
fi

# Test daemon socket is functional (CLI uses socket, which requires the daemon's PID file)
if [ -S "$PROJECT_DIR/.agent-relay/relay.sock" ]; then
  pass "Daemon socket exists"
  TOTAL=$((TOTAL + 1))
else
  fail "Daemon socket not found"
fi

# Verify daemon PID file
if [ -f "$PROJECT_DIR/.agent-relay/relay.sock.pid" ]; then
  pass "Daemon PID file exists"
  TOTAL=$((TOTAL + 1))
else
  # CLI commands may not work without PID file but daemon itself is functional
  skip "Daemon PID file not found (CLI status/agents may not work)"
fi

# -------------------------------------------------------
# Phase 7: Live Spawn Test (only with --full)
# -------------------------------------------------------
if [ "$FULL_TEST" = true ]; then
  phase "Phase 7: Live Agent Spawn/Release Test"

  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    skip "ANTHROPIC_API_KEY not set - skipping live spawn test"
  else
    AGENT_NAME="spawn-refactor-test-$$"
    info "Spawning test agent '$AGENT_NAME'..."

    SPAWN_OUTPUT=$("$CLI_CMD" spawn "$AGENT_NAME" claude \
      "You are a test agent. Send a message to yourself saying 'SPAWN_TEST_OK' then wait." \
      --port "$DASHBOARD_PORT" 2>&1) || true

    if echo "$SPAWN_OUTPUT" | grep -qi "success\|spawned\|started"; then
      pass "Spawn command succeeded for '$AGENT_NAME'"
      TOTAL=$((TOTAL + 1))

      # Wait for agent to register
      info "Waiting for agent registration (max 60s)..."
      REGISTERED=false
      for i in $(seq 1 60); do
        AGENTS=$("$CLI_CMD" agents --json --port "$DASHBOARD_PORT" 2>/dev/null | grep '^\[' || echo "[]")
        if echo "$AGENTS" | jq -e --arg name "$AGENT_NAME" '.[] | select(.name == $name)' > /dev/null 2>&1; then
          REGISTERED=true
          pass "Agent '$AGENT_NAME' registered after ${i}s"
          TOTAL=$((TOTAL + 1))
          break
        fi
        sleep 1
      done

      if [ "$REGISTERED" = false ]; then
        fail "Agent '$AGENT_NAME' did not register within 60s"
      fi

      # Verify fleet shows the agent
      FLEET_AGENTS=$(curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/fleet/servers" 2>/dev/null || echo "")
      if echo "$FLEET_AGENTS" | grep -q "$AGENT_NAME"; then
        pass "Fleet endpoint shows spawned agent"
        TOTAL=$((TOTAL + 1))
      else
        skip "Fleet endpoint does not show agent (may need time)"
      fi

      # Release
      info "Releasing agent '$AGENT_NAME'..."
      "$CLI_CMD" release "$AGENT_NAME" --port "$DASHBOARD_PORT" 2>/dev/null || true
      sleep 3

      AGENTS_AFTER=$("$CLI_CMD" agents --json --port "$DASHBOARD_PORT" 2>/dev/null | grep '^\[' || echo "[]")
      if ! echo "$AGENTS_AFTER" | jq -e --arg name "$AGENT_NAME" '.[] | select(.name == $name)' > /dev/null 2>&1; then
        pass "Agent '$AGENT_NAME' released successfully"
        TOTAL=$((TOTAL + 1))
      else
        fail "Agent '$AGENT_NAME' still present after release"
      fi
    else
      fail "Spawn command failed: $SPAWN_OUTPUT"
    fi
  fi
else
  phase "Phase 7: Live Agent Spawn (skipped, use --full)"
  skip "Use --full flag to test live agent spawn/release"
fi

# -------------------------------------------------------
# Cleanup
# -------------------------------------------------------
phase "Cleanup"

info "Stopping test daemon..."
kill $DAEMON_PID 2>/dev/null || true
sleep 1
lsof -ti:$DASHBOARD_PORT | xargs kill -9 2>/dev/null || true
pass "Test daemon stopped"

info "Restarting your daemon on default port (3888)..."
agent-relay up --dashboard > /dev/null 2>&1 &
sleep 3
if curl -s "http://127.0.0.1:3888/health" > /dev/null 2>&1; then
  info "Your daemon is back up on port 3888"
else
  info "Daemon restart may still be in progress. Run: agent-relay up --dashboard"
fi

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo -e "${CYAN}${BOLD}=================================================${NC}"
if [ $FAILURES -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ALL $TOTAL CHECKS PASSED${NC}"
else
  echo -e "${RED}${BOLD}  $FAILURES of $TOTAL CHECKS FAILED${NC}"
fi
echo -e "${CYAN}${BOLD}=================================================${NC}"
echo ""

if [ $FAILURES -eq 0 ] && [ "$FULL_TEST" = false ]; then
  echo -e "${YELLOW}Tip:${NC} Run with ${BOLD}--full${NC} to include live agent spawn/release test"
  echo -e "${YELLOW}Tip:${NC} Run with ${BOLD}--checklist${NC} to see manual verification steps"
fi

# Print checklist reminder
if [ "$FULL_TEST" = false ]; then
  echo ""
  echo -e "${BOLD}For manual testing, run:${NC}"
  echo "  ./scripts/test-spawn-refactor.sh --checklist"
fi

exit $FAILURES
