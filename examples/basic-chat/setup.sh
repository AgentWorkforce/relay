#!/bin/bash
# Basic Chat Setup Script
# Sets up two agents for a chat using agent-relay MCP tools

set -e

DATA_DIR="${1:-/tmp/agent-relay-chat}"
AGENT1="${2:-Alice}"
AGENT2="${3:-Bob}"

echo "Setting up basic chat in: $DATA_DIR"
echo "Agents: $AGENT1, $AGENT2"
echo ""

# Create agent directories
mkdir -p "$DATA_DIR/$AGENT1"
mkdir -p "$DATA_DIR/$AGENT2"

# Create instruction files
cat > "$DATA_DIR/$AGENT1/INSTRUCTIONS.md" << EOF
# You are $AGENT1

You're participating in a chat with $AGENT2 using agent-relay.

## How to send messages

Use the MCP tool:
\`\`\`
relay_send(to: "$AGENT2", message: "Your message")
\`\`\`

## How to check for messages

Use the MCP tool:
\`\`\`
relay_inbox()
\`\`\`

## Start the conversation

Say hello to $AGENT2!
EOF

cat > "$DATA_DIR/$AGENT2/INSTRUCTIONS.md" << EOF
# You are $AGENT2

You're participating in a chat with $AGENT1 using agent-relay.

## How to send messages

Use the MCP tool:
\`\`\`
relay_send(to: "$AGENT1", message: "Your message")
\`\`\`

## How to check for messages

Use the MCP tool:
\`\`\`
relay_inbox()
\`\`\`

## Wait for $AGENT1's message

Check your inbox and respond!
EOF

echo "Created:"
echo "  $DATA_DIR/$AGENT1/INSTRUCTIONS.md"
echo "  $DATA_DIR/$AGENT2/INSTRUCTIONS.md"
echo ""
echo "To start:"
echo "  Terminal 1: Read $DATA_DIR/$AGENT1/INSTRUCTIONS.md and start chatting"
echo "  Terminal 2: Read $DATA_DIR/$AGENT2/INSTRUCTIONS.md and respond"
