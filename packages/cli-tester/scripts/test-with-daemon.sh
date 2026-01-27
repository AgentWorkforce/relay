#!/bin/bash
# Full integration test with daemon
# This starts a local daemon and tests the complete spawn flow
#
# Usage: ./test-with-daemon.sh <cli>
# Example: ./test-with-daemon.sh cursor
#          DEBUG=1 ./test-with-daemon.sh cursor

set -e

CLI=${1:-cursor}

# Map CLI name to actual command
CLI_CMD="$CLI"
if [ "$CLI" = "cursor" ]; then
    CLI_CMD="agent"
fi

NAME="daemon-test-${CLI}"
SOCKET="/tmp/relay-pty-${NAME}.sock"

# Daemon configuration
DAEMON_PORT=${DAEMON_PORT:-3377}
DAEMON_HOST="127.0.0.1"
DAEMON_URL="http://${DAEMON_HOST}:${DAEMON_PORT}"
DATA_DIR="/tmp/relay-daemon-test"

# Cleanup function
cleanup() {
    echo ""
    echo "========================================"
    echo "  Cleaning up"
    echo "========================================"
    rm -f "$SOCKET"
    if [ -n "$DAEMON_PID" ]; then
        echo "Stopping daemon (PID: $DAEMON_PID)..."
        kill $DAEMON_PID 2>/dev/null || true
    fi
    if [ -n "$PTY_PID" ]; then
        echo "Stopping relay-pty (PID: $PTY_PID)..."
        kill $PTY_PID 2>/dev/null || true
    fi
    echo "Done."
}
trap cleanup EXIT

# Create data directory
mkdir -p "$DATA_DIR"

echo "========================================"
echo "  Full Daemon Integration Test: $CLI"
echo "========================================"
echo ""
echo "This test starts a real daemon and tests the complete flow:"
echo "  1. Start relay-daemon"
echo "  2. Start relay-pty with CLI"
echo "  3. Wait for agent registration"
echo "  4. Monitor the full flow"
echo ""
echo "Configuration:"
echo "  CLI:         $CLI_CMD"
echo "  Agent name:  $NAME"
echo "  Daemon URL:  $DAEMON_URL"
echo "  Data dir:    $DATA_DIR"
echo ""

# Check if daemon binary is available
if ! command -v relay-daemon &> /dev/null; then
    echo "WARNING: relay-daemon not found in PATH"
    echo ""
    echo "To build the daemon:"
    echo "  cd packages/daemon && npm run build"
    echo ""
    echo "Or run a daemon manually:"
    echo "  npm run daemon"
    echo ""
    echo "Then re-run this test."
    exit 1
fi

echo "========================================"
echo "  Phase 1: Starting Daemon"
echo "========================================"
echo ""

# Check if a daemon is already running
if curl -s "${DAEMON_URL}/health" > /dev/null 2>&1; then
    echo "Daemon already running at $DAEMON_URL"
    DAEMON_PID=""
else
    echo "Starting daemon on port $DAEMON_PORT..."

    # Start daemon in background with test configuration
    RELAY_DATA_DIR="$DATA_DIR" \
    RELAY_PORT="$DAEMON_PORT" \
    DEBUG="${DEBUG:-}" \
    relay-daemon > "$DATA_DIR/daemon.log" 2>&1 &

    DAEMON_PID=$!
    echo "Daemon started (PID: $DAEMON_PID)"

    # Wait for daemon to be ready
    echo "Waiting for daemon to be ready..."
    for i in $(seq 1 30); do
        if curl -s "${DAEMON_URL}/health" > /dev/null 2>&1; then
            echo "Daemon is ready!"
            break
        fi
        if [ $i -eq 30 ]; then
            echo "ERROR: Daemon failed to start within 30 seconds"
            echo ""
            echo "Daemon log:"
            cat "$DATA_DIR/daemon.log" | tail -50
            exit 1
        fi
        sleep 1
    done
fi

echo ""

echo "========================================"
echo "  Phase 2: Starting CLI with relay-pty"
echo "========================================"
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

# Build relay-pty args
RELAY_ARGS=(
    --name "$NAME"
    --socket "$SOCKET"
    --idle-timeout 300
)

# Enable verbose output
if [ -n "$DEBUG" ]; then
    RELAY_ARGS+=(--json-output)
fi

# Set daemon URL environment variable so relay-pty connects to our test daemon
export RELAY_DAEMON_URL="$DAEMON_URL"

echo "Starting relay-pty..."
if [ ${#CLI_ARGS[@]} -gt 0 ]; then
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" "${CLI_ARGS[@]}" 2>&1 &
else
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" 2>&1 &
fi

PTY_PID=$!
echo "relay-pty started (PID: $PTY_PID)"
echo ""

echo "========================================"
echo "  Phase 3: Monitoring Registration"
echo "========================================"
echo ""

# Poll for registration via daemon API
START_TIME=$(date +%s)
TIMEOUT_SEC=60

echo "Polling daemon for agent registration (timeout: ${TIMEOUT_SEC}s)..."
echo ""

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    # Check if PTY process is still running
    if ! kill -0 $PTY_PID 2>/dev/null; then
        echo ""
        echo "[$(date +%T)] ERROR: relay-pty exited after ${ELAPSED}s"
        echo ""
        echo "The CLI crashed or exited before completing registration."
        echo ""
        if [ -f "$DATA_DIR/daemon.log" ]; then
            echo "Daemon log (last 20 lines):"
            tail -20 "$DATA_DIR/daemon.log"
        fi
        exit 1
    fi

    # Query daemon for connected agents
    AGENTS=$(curl -s "${DAEMON_URL}/api/agents" 2>/dev/null || echo "[]")

    # Check if our agent is registered
    if echo "$AGENTS" | grep -q "\"$NAME\""; then
        echo ""
        echo "========================================"
        echo "  SUCCESS: Agent Registered!"
        echo "========================================"
        echo ""
        echo "Agent '$NAME' successfully registered with daemon after ${ELAPSED}s"
        echo ""
        echo "Connected agents:"
        echo "$AGENTS" | jq . 2>/dev/null || echo "$AGENTS"
        echo ""
        echo "Press Ctrl+C to stop the test, or leave running to interact with the CLI."

        # Keep running so user can interact
        wait $PTY_PID
        exit 0
    fi

    echo "[$(date +%T)] +${ELAPSED}s: Waiting for registration... (agents: $(echo "$AGENTS" | grep -o '"' | wc -l | xargs))"

    # Check timeout
    if [ $ELAPSED -ge $TIMEOUT_SEC ]; then
        echo ""
        echo "========================================"
        echo "  TIMEOUT: Registration Failed"
        echo "========================================"
        echo ""
        echo "Agent '$NAME' did not register within ${TIMEOUT_SEC}s"
        echo ""
        echo "This is the same timeout the real spawner would hit."
        echo ""
        echo "Debugging info:"
        echo ""
        echo "1. Connected agents from daemon:"
        echo "$AGENTS" | jq . 2>/dev/null || echo "$AGENTS"
        echo ""
        if [ -f "$DATA_DIR/daemon.log" ]; then
            echo "2. Daemon log (last 30 lines):"
            tail -30 "$DATA_DIR/daemon.log"
        fi
        echo ""
        echo "3. Check if CLI is stuck on a prompt (auth, trust, etc.)"
        echo ""
        exit 1
    fi

    sleep 2
done
