#!/bin/bash
# Claude Code plugin hook to check agent-relay inbox
# Triggered on PostToolUse to notify agent of pending messages

# Get agent name from environment
AGENT_NAME="${AGENT_RELAY_NAME:-}"
DATA_DIR="${AGENT_RELAY_DIR:-$HOME/.agent-relay}"

# Silent exit if no agent name (not running in relay context)
[ -z "$AGENT_NAME" ] && exit 0

INBOX_PATH="$DATA_DIR/$AGENT_NAME/inbox.md"

# Silent exit if no inbox
[ ! -f "$INBOX_PATH" ] && exit 0

# Check for actual messages
CONTENT=$(cat "$INBOX_PATH" 2>/dev/null)
if ! echo "$CONTENT" | grep -q "## Message from"; then
    exit 0
fi

# Count messages
MSG_COUNT=$(echo "$CONTENT" | grep -c "## Message from")

# Check if MCP is available (daemon must be running)
PROJECT_ROOT="$(pwd)"
RELAY_SOCKET="${RELAY_SOCKET:-$PROJECT_ROOT/.agent-relay/relay.sock}"
MCP_AVAILABLE=0
if [ -S "$RELAY_SOCKET" ]; then
    MCP_AVAILABLE=1
fi

# Output notification (this appears in Claude's context)
cat << EOF

--- RELAY NOTIFICATION ---
You have $MSG_COUNT message(s) in your inbox!

$CONTENT

EOF

# Show MCP tools reminder only if daemon is running
if [ "$MCP_AVAILABLE" -eq 1 ]; then
    cat << 'EOF'
--- MCP TOOLS AVAILABLE ---
Use MCP tools for agent coordination:

  relay_send(to, message)      - Send message to agent/channel
  relay_spawn(name, cli, task) - Create worker agent
  relay_inbox()                - Check your messages
  relay_who()                  - List online agents
  relay_release(name)          - Stop a worker agent
  relay_status()               - Check connection status

Prefer MCP tools over file protocol when available.
Fallback: use ->relay-file: if MCP unavailable.

EOF
fi

cat << 'EOF'
--- END RELAY ---

ACTION REQUIRED: Respond to these messages using the relay protocol.

EOF

exit 0
