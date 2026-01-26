#!/bin/bash
# Test agent registration flow - monitors what happens during spawn
# This tests the critical registration step that's timing out for cursor
#
# Usage: ./test-registration.sh <cli> [timeout_seconds]
# Example: ./test-registration.sh cursor 60
#          DEBUG_SPAWN=1 ./test-registration.sh cursor

set -e

CLI=${1:-cursor}
TIMEOUT_SEC=${2:-60}

# Map CLI name to actual command
CLI_CMD="$CLI"
if [ "$CLI" = "cursor" ]; then
    CLI_CMD="agent"
fi

NAME="reg-test-${CLI}"
SOCKET="/tmp/relay-pty-${NAME}.sock"

# Test data directories (mimic real daemon structure)
TEST_DATA_DIR="/tmp/relay-registration-test"
AGENTS_FILE="$TEST_DATA_DIR/agents.json"
CONNECTED_FILE="$TEST_DATA_DIR/connected-agents.json"

# Create directories
mkdir -p "$TEST_DATA_DIR"

# Initialize empty registration files
echo '{"agents":[],"updatedAt":'$(date +%s000)'}' > "$CONNECTED_FILE"
echo '{}' > "$AGENTS_FILE"

# Cleanup function
cleanup() {
    echo ""
    echo "========================================"
    echo "  Final State"
    echo "========================================"
    echo ""
    echo "Connected agents file ($CONNECTED_FILE):"
    cat "$CONNECTED_FILE" 2>/dev/null | jq . 2>/dev/null || cat "$CONNECTED_FILE" 2>/dev/null || echo "  (empty/missing)"
    echo ""
    echo "Agents registry file ($AGENTS_FILE):"
    cat "$AGENTS_FILE" 2>/dev/null | jq . 2>/dev/null || cat "$AGENTS_FILE" 2>/dev/null || echo "  (empty/missing)"
    echo ""
    echo "Cleaning up processes..."
    rm -f "$SOCKET"
    pkill -f "relay-pty.*${NAME}" 2>/dev/null || true
}
trap cleanup EXIT

# Remove stale socket
rm -f "$SOCKET"

echo "========================================"
echo "  Registration Flow Test: $CLI"
echo "========================================"
echo ""
echo "This test monitors the registration files that the spawner polls."
echo "When the spawner times out, it's because these files don't show"
echo "the agent as registered within 30 seconds."
echo ""
echo "Test config:"
echo "  CLI:            $CLI_CMD"
echo "  Name:           $NAME"
echo "  Socket:         $SOCKET"
echo "  Timeout:        ${TIMEOUT_SEC}s"
echo "  Connected file: $CONNECTED_FILE"
echo "  Agents file:    $AGENTS_FILE"
echo ""

# Build CLI arguments
CLI_ARGS=()
case $CLI in
    claude)
        CLI_ARGS+=(--dangerously-skip-permissions)
        ;;
    cursor)
        CLI_ARGS+=(--force)
        ;;
esac

echo "Command: $CLI_CMD ${CLI_ARGS[*]}"
echo ""
echo "========================================"
echo "  Phase 1: Starting CLI"
echo "========================================"
echo ""

# Start relay-pty in background
RELAY_ARGS=(
    --name "$NAME"
    --socket "$SOCKET"
    --idle-timeout 300
    --json-output
)

if [ ${#CLI_ARGS[@]} -gt 0 ]; then
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" "${CLI_ARGS[@]}" 2>&1 &
else
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" 2>&1 &
fi

PTY_PID=$!
echo "[$(date +%T)] Started relay-pty (PID: $PTY_PID)"

# Give it a moment to start
sleep 1

# Check if process is still running
if ! kill -0 $PTY_PID 2>/dev/null; then
    echo "[$(date +%T)] ERROR: relay-pty exited immediately"
    wait $PTY_PID || true
    exit 1
fi

echo "[$(date +%T)] relay-pty is running"
echo ""

echo "========================================"
echo "  Phase 2: Monitoring Registration"
echo "========================================"
echo ""
echo "Polling for agent registration (timeout: ${TIMEOUT_SEC}s)..."
echo "In a real spawn, the daemon would update these files."
echo ""

# Poll for registration (simulating what spawner does)
START_TIME=$(date +%s)
POLL_COUNT=0

while true; do
    POLL_COUNT=$((POLL_COUNT + 1))
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    # Check if process is still running
    if ! kill -0 $PTY_PID 2>/dev/null; then
        echo ""
        echo "[$(date +%T)] ERROR: relay-pty exited after ${ELAPSED}s"
        echo ""
        echo "This is likely the issue - the CLI crashed or exited before registration."
        echo "Check the output above for error messages."
        wait $PTY_PID || true
        exit 1
    fi

    # Check socket exists
    if [ -S "$SOCKET" ]; then
        # Try to get status from socket
        STATUS=$(echo '{"type":"status"}' | timeout 2 nc -U "$SOCKET" 2>/dev/null || echo "timeout")
        if [ "$STATUS" != "timeout" ]; then
            echo "[$(date +%T)] Poll #$POLL_COUNT: Socket active, status: $(echo "$STATUS" | head -c 100)..."
        else
            echo "[$(date +%T)] Poll #$POLL_COUNT: Socket exists but no response"
        fi
    else
        echo "[$(date +%T)] Poll #$POLL_COUNT: Socket not yet created"
    fi

    # Check timeout
    if [ $ELAPSED -ge $TIMEOUT_SEC ]; then
        echo ""
        echo "========================================"
        echo "  TIMEOUT after ${ELAPSED}s"
        echo "========================================"
        echo ""
        echo "This simulates what happens when the spawner times out."
        echo "In a real scenario, the daemon would need to see this agent"
        echo "and update the registration files within 30 seconds."
        echo ""
        echo "To debug further:"
        echo "  1. Check if the CLI started correctly (auth issues?)"
        echo "  2. Check if relay-pty connected to the daemon"
        echo "  3. Check daemon logs for this agent name"
        exit 1
    fi

    sleep 1
done
