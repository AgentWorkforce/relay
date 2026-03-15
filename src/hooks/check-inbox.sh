#!/bin/bash
# Claude Code hook to check agent-relay inbox
# Add to .claude/settings.json PostToolUse hooks

# Get agent name from environment or argument
AGENT_NAME="${AGENT_RELAY_NAME:-$1}"
DATA_DIR="${AGENT_RELAY_DIR:-/tmp/agent-relay-team}"
# Project root for MCP detection (use environment or derive from DATA_DIR parent)
PROJECT_ROOT="${AGENT_RELAY_PROJECT:-$(dirname "$DATA_DIR")}"

# Silent exit if no agent name
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

# Check if MCP is available (requires BOTH .mcp.json AND broker socket accessible)
# Note: Only check PROJECT_ROOT, not cwd, to avoid false positives when hook runs from different dir
RELAY_SOCKET="${RELAY_SOCKET:-/tmp/agent-relay.sock}"
MCP_AVAILABLE=0
if [ -f "$PROJECT_ROOT/.mcp.json" ] && [ -S "$RELAY_SOCKET" ]; then
    MCP_AVAILABLE=1
fi

# Output notification (this appears in Claude's context)
cat << EOF

--- RELAY NOTIFICATION ---
You have $MSG_COUNT message(s) in your inbox!

$CONTENT

EOF

# Show MCP tools reminder only if MCP is configured
if [ "$MCP_AVAILABLE" -eq 1 ]; then
    cat << 'EOF'
--- MCP TOOLS AVAILABLE ---
Primary API for agent coordination.

Quick Reference:
  mcp__relaycast__message_dm_send(to, text)    → Send DM to agent
  mcp__relaycast__message_post(channel, text) → Post to channel
  mcp__relaycast__agent_add(name, cli, task)  → Create worker agent
  mcp__relaycast__message_inbox_check()       → Check your messages
  mcp__relaycast__agent_list()                → List online agents
  mcp__relaycast__agent_remove(name)          → Stop a worker agent

Use MCP tools for all agent communication.

EOF
fi

cat << EOF
--- END RELAY ---

ACTION REQUIRED: Respond to these messages, then clear inbox with:
node $DATA_DIR/../dist/cli/index.js team-check -n $AGENT_NAME -d $DATA_DIR --clear --no-wait

EOF

exit 0
