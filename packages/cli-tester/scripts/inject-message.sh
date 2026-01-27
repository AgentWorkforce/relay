#!/bin/bash
# Send a message to a CLI via relay-pty socket
# Usage: ./inject-message.sh <session-name> <message>
# Example: ./inject-message.sh test-claude "What is 2+2?"

NAME=${1:-test-claude}
MESSAGE=${2:-"Test message from inject script"}
SOCKET="/tmp/relay-pty-${NAME}.sock"

if [ ! -S "$SOCKET" ]; then
    echo "Error: Socket not found: $SOCKET"
    echo ""
    echo "Make sure relay-pty is running with --name ${NAME}"
    echo "Run: test-cli.sh ${NAME#test-}"
    exit 1
fi

# Generate unique message ID
MSG_ID="manual-$(date +%s)-$RANDOM"

echo "Sending message to $NAME..."
echo "  Socket: $SOCKET"
echo "  Message ID: $MSG_ID"
echo "  Body: $MESSAGE"
echo ""

# Build JSON request
REQUEST=$(cat <<EOF
{"type":"inject","id":"$MSG_ID","from":"Tester","body":"$MESSAGE","priority":0}
EOF
)

# Send request and read response
# nc -U connects to Unix socket, -q 1 waits 1 second for response
echo "$REQUEST" | nc -U "$SOCKET" -q 2 | while read -r line; do
    if [ -n "$line" ]; then
        echo "Response: $line" | jq '.' 2>/dev/null || echo "Response: $line"
    fi
done

echo ""
echo "Message sent. Check the CLI session to see if it was delivered."
