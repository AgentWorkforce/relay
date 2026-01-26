#!/bin/bash
# Full spawn simulation - replicates the EXACT spawner flow
# This is the most accurate test for debugging registration timeouts
#
# Usage: ./test-full-spawn.sh <cli> [interactive]
# Example: ./test-full-spawn.sh cursor           # Non-interactive (with --force)
#          ./test-full-spawn.sh cursor true      # Interactive (no --force, like setup terminal)
#          DEBUG=1 ./test-full-spawn.sh cursor true

set -e

CLI=${1:-cursor}
INTERACTIVE=${2:-false}

# Map CLI to command
CLI_CMD="$CLI"
if [ "$CLI" = "cursor" ]; then
    CLI_CMD="agent"
fi

# Generate name
if [ "$INTERACTIVE" = "true" ]; then
    TIMESTAMP=$(date +%s | tail -c 8)
    RANDOM_SUFFIX=$(head /dev/urandom | tr -dc 'a-z0-9' | head -c 4)
    NAME="__setup__${CLI}-${TIMESTAMP}${RANDOM_SUFFIX}"
else
    NAME="spawn-test-${CLI}"
fi

SOCKET="/tmp/relay-pty-${NAME}.sock"
LOG_FILE="/tmp/relay-spawn-${NAME}.log"
REGISTRATION_TIMEOUT=30

echo "========================================"
echo "  Full Spawn Simulation: $CLI"
echo "========================================"
echo ""
echo "Mode: $([ "$INTERACTIVE" = "true" ] && echo "INTERACTIVE (setup terminal)" || echo "NON-INTERACTIVE (normal spawn)")"
echo ""
echo "Configuration:"
echo "  CLI:                 $CLI_CMD"
echo "  Agent name:          $NAME"
echo "  Interactive:         $INTERACTIVE"
echo "  Registration timeout: ${REGISTRATION_TIMEOUT}s"
echo ""

# Build CLI args based on mode
CLI_ARGS=()
if [ "$INTERACTIVE" != "true" ]; then
    case $CLI in
        cursor)
            CLI_ARGS+=(--force)
            echo "  Adding: --force (non-interactive cursor)"
            ;;
        claude)
            CLI_ARGS+=(--dangerously-skip-permissions)
            echo "  Adding: --dangerously-skip-permissions (non-interactive claude)"
            ;;
        copilot)
            # Copilot uses device flow for headless auth
            CLI_ARGS+=(auth login --device)
            echo "  Adding: auth login --device (non-interactive copilot)"
            ;;
        codex)
            # Codex supports device flow
            CLI_ARGS+=(login --device-auth)
            echo "  Adding: login --device-auth (non-interactive codex)"
            ;;
    esac
else
    echo "  No auto-accept flags (interactive mode)"
    # For interactive copilot, still need auth login command
    if [ "$CLI" = "copilot" ]; then
        CLI_ARGS+=(auth login)
        echo "  Adding: auth login (interactive copilot)"
    fi
fi
echo ""

# Cleanup
cleanup() {
    echo ""
    echo "========================================"
    echo "  Cleanup"
    echo "========================================"
    rm -f "$SOCKET"
    if [ -n "$PTY_PID" ] && kill -0 $PTY_PID 2>/dev/null; then
        echo "Stopping relay-pty (PID: $PTY_PID)..."
        kill $PTY_PID 2>/dev/null || true
    fi
    echo ""
    echo "Log file: $LOG_FILE"
    if [ -f "$LOG_FILE" ]; then
        echo ""
        echo "Last 30 lines of output:"
        echo "----------------------------------------"
        tail -30 "$LOG_FILE"
        echo "----------------------------------------"
    fi
}
trap cleanup EXIT

# Remove stale files
rm -f "$SOCKET" "$LOG_FILE"

echo "========================================"
echo "  Phase 1: Start PTY"
echo "========================================"
echo ""

# This is what spawner does: pty.start()
RELAY_ARGS=(
    --name "$NAME"
    --socket "$SOCKET"
    --idle-timeout 300
)

if [ -n "$DEBUG" ]; then
    RELAY_ARGS+=(--json-output)
fi

echo "[$(date +%T)] Starting: relay-pty ${RELAY_ARGS[*]} -- $CLI_CMD ${CLI_ARGS[*]}"
echo ""

# Start relay-pty and capture output
if [ ${#CLI_ARGS[@]} -gt 0 ]; then
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" "${CLI_ARGS[@]}" > "$LOG_FILE" 2>&1 &
else
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" > "$LOG_FILE" 2>&1 &
fi
PTY_PID=$!

echo "[$(date +%T)] PTY started (PID: $PTY_PID)"

# Brief wait for startup
sleep 1

if ! kill -0 $PTY_PID 2>/dev/null; then
    echo "[$(date +%T)] ERROR: PTY exited immediately!"
    echo ""
    cat "$LOG_FILE"
    exit 1
fi

echo "[$(date +%T)] PTY is running"
echo ""

echo "========================================"
echo "  Phase 2: Wait for Registration"
echo "========================================"
echo ""
echo "In the real spawner, this calls waitForAgentRegistration()"
echo "which polls connected-agents.json and agents.json for ${REGISTRATION_TIMEOUT}s"
echo ""
echo "Without a daemon, these files won't be updated, causing timeout."
echo "But we can still see if the CLI starts successfully."
echo ""

# Simulate the spawner's registration polling
START_TIME=$(date +%s)
POLL_COUNT=0

while true; do
    POLL_COUNT=$((POLL_COUNT + 1))
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    # Check if PTY is still running
    if ! kill -0 $PTY_PID 2>/dev/null; then
        echo ""
        echo "[$(date +%T)] PTY exited after ${ELAPSED}s (${POLL_COUNT} polls)"
        echo ""
        echo "Exit could be normal (auth complete) or an error."
        echo "Check log output below."
        exit 0
    fi

    # Check socket status
    SOCKET_STATUS="no socket"
    if [ -S "$SOCKET" ]; then
        RESPONSE=$(echo '{"type":"status"}' | timeout 1 nc -U "$SOCKET" 2>/dev/null | head -1 || echo "")
        if [ -n "$RESPONSE" ]; then
            IDLE=$(echo "$RESPONSE" | grep -o '"agent_idle":[^,}]*' | cut -d: -f2 || echo "?")
            QUEUE=$(echo "$RESPONSE" | grep -o '"queue_length":[^,}]*' | cut -d: -f2 || echo "?")
            SOCKET_STATUS="idle=$IDLE queue=$QUEUE"
        else
            SOCKET_STATUS="no response"
        fi
    fi

    # Log poll (like spawner does for first 3 and every 10th)
    if [ $POLL_COUNT -le 3 ] || [ $((POLL_COUNT % 10)) -eq 0 ]; then
        echo "[$(date +%T)] Poll #$POLL_COUNT: elapsed=${ELAPSED}s socket=[$SOCKET_STATUS]"
    fi

    # Check registration timeout (what spawner does)
    if [ $ELAPSED -ge $REGISTRATION_TIMEOUT ]; then
        echo ""
        echo "========================================"
        echo "  REGISTRATION TIMEOUT (${REGISTRATION_TIMEOUT}s)"
        echo "========================================"
        echo ""
        echo "This is where the real spawner would fail with:"
        echo "  'Agent registration timeout'"
        echo ""
        echo "The CLI started but didn't register with daemon."
        echo ""
        echo "Possible causes:"
        if [ "$INTERACTIVE" = "true" ]; then
            echo "  1. CLI is waiting for user input (trust prompt, auth)"
            echo "  2. No daemon running to register with"
            echo "  3. CLI crashed silently"
        else
            echo "  1. --force flag not working as expected"
            echo "  2. No daemon running to register with"
            echo "  3. CLI has other blocking prompts"
        fi
        echo ""
        echo "To see what the CLI is doing, check the log file:"
        echo "  cat $LOG_FILE"
        echo ""
        echo "Or tail it live in another terminal:"
        echo "  tail -f $LOG_FILE"
        echo ""

        # Show recent output
        echo "Recent output (last 20 lines):"
        echo "----------------------------------------"
        tail -20 "$LOG_FILE" 2>/dev/null || echo "(no output)"
        echo "----------------------------------------"
        echo ""
        echo "Process is still running. Press Enter to stop."
        read -r
        exit 1
    fi

    sleep 0.5
done
