---
description: Send a message to a specific agent or broadcast to all agents
---

# Send Relay Message

Send a message to an agent or broadcast to all connected agents.

Parse $ARGUMENTS for:
- **Target**: Agent name or `*` for broadcast
- **Message**: The message content

Format: `/agent-relay:send <target> <message>`

## How to Send

Use the file-based relay protocol:

```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: <target>

<message>
EOF
```

Then output: `->relay-file:msg`

If `$AGENT_RELAY_OUTBOX` is not set, use the MCP tool `relay_send` if available, or fall back to the CLI.

## Examples

- `/agent-relay:send Worker1 Please prioritize the auth module` - Direct message
- `/agent-relay:send * Team standup: report your status` - Broadcast to all
- `/agent-relay:send #general New API endpoint is ready for review` - Channel message
