#!/bin/bash
# Test CLI spawn flow - simulates real spawner behavior
# This is a more realistic test that mimics what AgentSpawner does
#
# Usage: ./test-spawn.sh <cli> [--interactive]
# Example: ./test-spawn.sh cursor
#          ./test-spawn.sh cursor --interactive
#          DEBUG_SPAWN=1 ./test-spawn.sh cursor

set -e

CLI=${1:-cursor}
INTERACTIVE=""
if [ "$2" = "--interactive" ]; then
    INTERACTIVE="1"
fi

# Map CLI name to actual command (cursor installs as 'agent')
CLI_CMD="$CLI"
if [ "$CLI" = "cursor" ]; then
    CLI_CMD="agent"
fi

NAME="spawn-test-${CLI}"
SOCKET="/tmp/relay-pty-${NAME}.sock"
RELAY_DATA_DIR="/tmp/relay-test-data"

# Create test data directories
mkdir -p "$RELAY_DATA_DIR"

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    rm -f "$SOCKET"
    pkill -f "relay-pty.*${NAME}" 2>/dev/null || true
}
trap cleanup EXIT

# Remove stale socket if exists
rm -f "$SOCKET"

echo "========================================"
echo "  Spawn Flow Test: $CLI"
echo "========================================"
echo ""
echo "This test simulates what AgentSpawner.spawn() does:"
echo "  1. Builds command with appropriate flags"
echo "  2. Starts relay-pty with the CLI"
echo "  3. Monitors for daemon registration"
echo ""
echo "Session name: $NAME"
echo "Socket path:  $SOCKET"
echo "Data dir:     $RELAY_DATA_DIR"
echo ""

# Build CLI arguments exactly like spawner does
CLI_ARGS=()

# Add args based on CLI type
case $CLI in
    claude)
        # Claude: add --dangerously-skip-permissions in non-interactive mode
        if [ -z "$INTERACTIVE" ]; then
            CLI_ARGS+=(--dangerously-skip-permissions)
            echo "[spawn] Adding --dangerously-skip-permissions (non-interactive mode)"
        fi
        ;;
    cursor)
        # Cursor: add --force in non-interactive mode
        if [ -z "$INTERACTIVE" ]; then
            CLI_ARGS+=(--force)
            echo "[spawn] Adding --force (non-interactive mode)"
        fi
        ;;
    codex)
        # Codex: supports device flow for headless
        if [ -z "$INTERACTIVE" ]; then
            CLI_ARGS+=(login --device-auth)
            echo "[spawn] Adding login --device-auth (non-interactive mode)"
        fi
        ;;
    copilot)
        # Copilot: needs auth login command, device flow for headless
        if [ -z "$INTERACTIVE" ]; then
            CLI_ARGS+=(auth login --device)
            echo "[spawn] Adding auth login --device (non-interactive mode)"
        else
            CLI_ARGS+=(auth login)
            echo "[spawn] Adding auth login (interactive mode)"
        fi
        ;;
    opencode)
        # OpenCode: needs auth login command
        CLI_ARGS+=(auth login)
        echo "[spawn] Adding auth login"
        ;;
    droid)
        # Droid: needs --login flag
        CLI_ARGS+=(--login)
        echo "[spawn] Adding --login"
        ;;
esac

echo ""
echo "Command: $CLI_CMD ${CLI_ARGS[*]}"
echo ""

# Build relay-pty args
RELAY_ARGS=(
    --name "$NAME"
    --socket "$SOCKET"
    --idle-timeout 300
)

# Enable JSON output for debugging
if [ -n "$DEBUG_SPAWN" ] || [ -n "$DEBUG" ]; then
    RELAY_ARGS+=(--json-output)
    echo "[debug] JSON output enabled"
fi

echo "========================================"
echo "  Starting CLI with relay-pty"
echo "========================================"
echo ""
echo "Press Ctrl+C to stop."
echo ""
echo "In another terminal, you can:"
echo "  - Check socket status: echo '{\"type\":\"status\"}' | nc -U $SOCKET"
echo "  - Inject message: echo '{\"type\":\"inject\",\"body\":\"test\"}' | nc -U $SOCKET"
echo "  - Monitor registration: watch -n1 'cat $RELAY_DATA_DIR/*.json 2>/dev/null || echo no files'"
echo ""

# Start the CLI with relay-pty
# In a real spawn, this would be done via AgentSpawner which handles registration waiting
if [ ${#CLI_ARGS[@]} -gt 0 ]; then
    exec relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" "${CLI_ARGS[@]}"
else
    exec relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD"
fi
