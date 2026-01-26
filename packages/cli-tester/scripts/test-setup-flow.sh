#!/bin/bash
# Test the EXACT setup terminal flow used for provider onboarding
# This replicates what TerminalProviderSetup.tsx does when you click "Connect"
#
# The setup flow:
# 1. Frontend calls POST /api/workspaces/{id}/agents with { name, provider, interactive: true }
# 2. Spawner runs: relay-pty --name __setup__cursor-xxx -- agent (NO --force flag!)
# 3. Spawner waits up to 30s for agent to register with daemon
# 4. If timeout, spawn fails with "Agent registration timeout"
#
# Usage: ./test-setup-flow.sh <cli> [timeout_seconds]
# Example: ./test-setup-flow.sh cursor 60
#          DEBUG=1 ./test-setup-flow.sh cursor

set -e

CLI=${1:-cursor}
TIMEOUT_SEC=${2:-60}

# Generate setup agent name like frontend does
TIMESTAMP=$(date +%s | tail -c 8)
RANDOM_SUFFIX=$(head /dev/urandom | tr -dc 'a-z0-9' | head -c 4)
NAME="__setup__${CLI}-${TIMESTAMP}${RANDOM_SUFFIX}"

# Map CLI to command
CLI_CMD="$CLI"
if [ "$CLI" = "cursor" ]; then
    CLI_CMD="agent"
fi

SOCKET="/tmp/relay-pty-${NAME}.sock"

echo "========================================"
echo "  Setup Terminal Flow Test: $CLI"
echo "========================================"
echo ""
echo "This test replicates the EXACT flow from TerminalProviderSetup.tsx"
echo ""
echo "Key difference from test-spawn.sh:"
echo "  - interactive=true means NO auto-accept flags (--force, etc.)"
echo "  - This is how setup terminals work - user must respond to prompts"
echo ""
echo "Configuration:"
echo "  CLI:          $CLI_CMD"
echo "  Agent name:   $NAME"
echo "  Socket:       $SOCKET"
echo "  Interactive:  true (no --force, no --dangerously-skip-permissions)"
echo "  Timeout:      ${TIMEOUT_SEC}s"
echo ""

# Interactive mode - no auto-accept flags, but some CLIs need auth subcommands
CLI_ARGS=()
case $CLI in
    copilot)
        CLI_ARGS+=(auth login)
        ;;
    opencode)
        CLI_ARGS+=(auth login)
        ;;
    droid)
        CLI_ARGS+=(--login)
        ;;
    codex)
        CLI_ARGS+=(login)
        ;;
esac

if [ ${#CLI_ARGS[@]} -gt 0 ]; then
    echo "Command: relay-pty --name $NAME -- $CLI_CMD ${CLI_ARGS[*]}"
else
    echo "Command: relay-pty --name $NAME -- $CLI_CMD"
fi
echo "         (no auto-accept flags because interactive=true)"
echo ""

# Cleanup
cleanup() {
    echo ""
    echo "Cleaning up..."
    rm -f "$SOCKET"
    if [ -n "$PTY_PID" ]; then
        kill $PTY_PID 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Remove stale socket
rm -f "$SOCKET"

echo "========================================"
echo "  Starting Setup Terminal"
echo "========================================"
echo ""

# Build relay-pty args
RELAY_ARGS=(
    --name "$NAME"
    --socket "$SOCKET"
    --idle-timeout 300
)

# Add verbose output
if [ -n "$DEBUG" ]; then
    RELAY_ARGS+=(--json-output)
    echo "[DEBUG] JSON output enabled"
    echo ""
fi

# Start in background so we can monitor
if [ ${#CLI_ARGS[@]} -gt 0 ]; then
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" "${CLI_ARGS[@]}" 2>&1 &
else
    relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" 2>&1 &
fi
PTY_PID=$!

echo "[$(date +%T)] Started relay-pty (PID: $PTY_PID)"
echo ""
echo "The CLI is now running. In a real setup flow, you would see"
echo "the terminal output in the browser and respond to prompts there."
echo ""
echo "Watch for:"
echo "  - Trust prompts (workspace trust, etc.)"
echo "  - Auth URL being printed"
echo "  - Any errors or crashes"
echo ""

# Give it a moment
sleep 2

# Check if still running
if ! kill -0 $PTY_PID 2>/dev/null; then
    echo "[$(date +%T)] ERROR: relay-pty exited immediately!"
    echo ""
    echo "This means the CLI crashed on startup."
    echo "Common causes:"
    echo "  - CLI not installed"
    echo "  - Missing dependencies"
    echo "  - Permission issues"
    exit 1
fi

echo "========================================"
echo "  Monitoring (${TIMEOUT_SEC}s timeout)"
echo "========================================"
echo ""
echo "In a real spawn, the spawner would poll registration files here."
echo "The timeout you're seeing is because this polling fails."
echo ""
echo "Press Ctrl+C to stop, or wait for timeout."
echo ""

START_TIME=$(date +%s)

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    # Check process
    if ! kill -0 $PTY_PID 2>/dev/null; then
        echo ""
        echo "[$(date +%T)] CLI exited after ${ELAPSED}s"
        echo ""
        echo "If this was unexpected, check the output above for errors."
        echo "If the CLI authenticated and exited normally, that's OK."
        exit 0
    fi

    # Check socket
    if [ -S "$SOCKET" ]; then
        STATUS=$(echo '{"type":"status"}' | timeout 2 nc -U "$SOCKET" 2>/dev/null | head -1 || echo "")
        if [ -n "$STATUS" ]; then
            IDLE=$(echo "$STATUS" | grep -o '"agent_idle":[^,}]*' | cut -d: -f2 || echo "unknown")
            echo "[$(date +%T)] +${ELAPSED}s: Socket OK, idle=$IDLE"
        else
            echo "[$(date +%T)] +${ELAPSED}s: Socket exists, no status response"
        fi
    else
        echo "[$(date +%T)] +${ELAPSED}s: Waiting for socket..."
    fi

    # Timeout check
    if [ $ELAPSED -ge $TIMEOUT_SEC ]; then
        echo ""
        echo "========================================"
        echo "  Test Complete (${TIMEOUT_SEC}s elapsed)"
        echo "========================================"
        echo ""
        echo "The CLI ran for ${TIMEOUT_SEC}s without exiting."
        echo ""
        echo "If this were a real spawn:"
        echo "  - The spawner would have timed out at 30s"
        echo "  - You'd see 'Agent registration timeout' error"
        echo ""
        echo "To continue interacting with the CLI, the process"
        echo "is still running. Press Enter to stop it."
        read -r
        exit 0
    fi

    sleep 3
done
