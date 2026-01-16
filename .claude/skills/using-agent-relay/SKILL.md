---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via Rust PTY wrapper with file-based protocol and reliability features
---

# Using Agent Relay

Real-time agent-to-agent messaging via file-based protocol.

## Reliability Features

The relay system includes automatic reliability improvements:

- **Escalating retry** - If you don't acknowledge a message, it will be re-sent with increasing urgency:
  - First attempt: `Relay message from Alice [abc123]: ...`
  - Second attempt: `[RETRY] Relay message from Alice [abc123]: ...`
  - Third+ attempt: `[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc123]: ...`

- **Unread indicator** - During long tasks, you'll see pending message counts:
  ```
  📬 2 unread messages (from: Alice, Bob)
  ```

**Always acknowledge messages** to prevent retry escalation.

## Sending Messages

Write a file to your outbox, then output the trigger:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: AgentName

Your message here.
EOF
```

Then output: `->relay-file:msg`

### Broadcast to All Agents

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/broadcast << 'EOF'
TO: *

Hello everyone!
EOF
```
Then: `->relay-file:broadcast`

### With Thread

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/reply << 'EOF'
TO: AgentName
THREAD: issue-123

Response in thread context.
EOF
```
Then: `->relay-file:reply`

## Message Format

```
TO: Target
THREAD: optional-thread

Message body (everything after blank line)
```

| TO Value | Behavior |
|----------|----------|
| `AgentName` | Direct message |
| `*` | Broadcast to all |
| `#channel` | Channel message |

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge it before starting work:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/ack << 'EOF'
TO: Sender

ACK: Brief description of task received
EOF
```
Then: `->relay-file:ack`

**Report completion** - When done, send a completion message:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/done << 'EOF'
TO: Sender

DONE: Brief summary of what was completed
EOF
```
Then: `->relay-file:done`

**Priority handling** - If you see `[RETRY]` or `[URGENT]` tags, respond immediately.

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Content here
```

Messages with retry escalation:
```
[RETRY] Relay message from Alice [abc123]: Did you receive my message?
[URGENT - PLEASE ACKNOWLEDGE] Relay message from Alice [abc123]: Please respond!
```

### Channel Routing (Important!)

Messages from #general (broadcast channel) include a `[#general]` indicator:
```
Relay message from Alice [abc123] [#general]: Hello everyone!
```

**When you see `[#general]`**: Reply to `*` (broadcast), NOT to the sender directly.

## Spawning & Releasing Agents

### Spawn a Worker

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.
Can be multiple lines.
EOF
```
Then: `->relay-file:spawn`

### Release a Worker

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/release << 'EOF'
KIND: release
NAME: WorkerName
EOF
```
Then: `->relay-file:release`

## Headers Reference

| Header | Required | Description |
|--------|----------|-------------|
| TO | Yes (messages) | Target agent/channel |
| KIND | No | `message` (default), `spawn`, `release` |
| NAME | Yes (spawn/release) | Agent name |
| CLI | Yes (spawn) | CLI to use |
| THREAD | No | Thread identifier |

## Status Updates

**Send status updates to your lead, NOT broadcast:**

```bash
# Correct - status to lead only
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/status << 'EOF'
TO: Lead

STATUS: Working on auth module
EOF
```
Then: `->relay-file:status`

## CLI Commands

```bash
agent-relay status              # Check daemon status
agent-relay agents              # List active agents
agent-relay agents:logs <name>  # View agent output
agent-relay agents:kill <name>  # Kill a spawned agent
agent-relay read <id>           # Read truncated message
```

## Synchronous Messaging (Planned)

For turn-based coordination where you need to wait for a response:

### Blocking Messages with `[await]`

Add AWAIT header to block until response:

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/turn << 'EOF'
TO: Worker
AWAIT: 60s

Your turn. Play a card.
EOF
```
Then: `->relay-file:turn`

When you receive a message marked `[awaiting]`, the sender is waiting for your response:

```
Relay message from Coordinator [abc123] [awaiting]: Your turn. Play a card.
```

**Note:** `AWAIT` header is coming in a future release. Currently all messages are fire-and-forget.

## Troubleshooting

```bash
agent-relay status                    # Check daemon
agent-relay agents                    # List connected agents
ls -la /tmp/agent-relay.sock          # Verify socket
ls -la /tmp/relay-outbox/             # Check outbox directories
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using bash to send messages | Write file to outbox, then output `->relay-file:ID` |
| Messages not sending | Check `agent-relay status` and outbox directory exists |
| Incomplete message content | `agent-relay read <id>` for full text |
| Missing trigger | Must output `->relay-file:<filename>` after writing file |
| Wrong outbox path | Use `/tmp/relay-outbox/$AGENT_RELAY_NAME/` |

## Legacy Format (Deprecated)

The inline `->relay:Target <<<message>>>` format still works but file-based is preferred for reliability.
