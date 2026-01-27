#!/bin/bash
# Test a specific CLI with relay-pty
# Usage: ./test-cli.sh <cli> [extra-args...]
# Example: ./test-cli.sh claude
#          ./test-cli.sh codex --device-auth
#          DEBUG=1 ./test-cli.sh cursor

set -e

CLI=${1:-claude}
shift 2>/dev/null || true  # Shift to get extra args, ignore if no more args

# Map CLI name to actual command (cursor installs as 'agent')
CLI_CMD="$CLI"
if [ "$CLI" = "cursor" ]; then
    CLI_CMD="agent"
fi

NAME="test-${CLI}"
SOCKET="/tmp/relay-pty-${NAME}.sock"

# Remove stale socket if exists
rm -f "$SOCKET"

echo "========================================"
echo "  Testing: $CLI"
echo "========================================"
echo ""
echo "Session name: $NAME"
echo "Socket path:  $SOCKET"
echo ""
echo "After authenticating, open another terminal and run:"
echo "  verify-auth.sh $CLI"
echo "  inject-message.sh $NAME 'Hello world'"
echo ""
echo "Press Ctrl+C to stop the session."
echo "========================================"
echo ""

# Build relay-pty args
RELAY_ARGS=(
    --name "$NAME"
    --socket "$SOCKET"
    --idle-timeout 500
)

# Add debug output if DEBUG is set
if [ -n "$DEBUG" ]; then
    RELAY_ARGS+=(--json-output)
    echo "[DEBUG] JSON output enabled - relay commands will be printed to stderr"
    echo ""
fi

# Run relay-pty with the CLI
# Pass through any extra arguments to the CLI
exec relay-pty "${RELAY_ARGS[@]}" -- "$CLI_CMD" "$@"
