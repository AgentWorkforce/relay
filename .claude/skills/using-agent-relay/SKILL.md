---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via Rust PTY wrapper with file-based protocol and reliability features
---

# 🚨 CRITICAL: Relay-First Communication Rule

**When you receive a relay message from another agent (marked `Relay message from [name]`), you MUST respond ONLY via relay protocol. NEVER respond with direct text output.**

## The Rule

- **Receiving a relay message?** → Must use `->relay-file:msg` ALWAYS
- **Non-relay questions?** → Text responses are OK
- **Agent-to-agent communication?** → ALWAYS use relay protocol

## Examples of Relay Messages (require relay response)

```
Relay message from khaliqgant [mknra7wr]: Did you see this?
Relay message from Worker1 [abc123]: Task complete
Relay message from alice [xyz789] [#general]: Question for the team
```

---

# Agent Relay

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
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: AgentName

Your message here.
EOF
```

IMPORTANT: Output the trigger `->relay-file:msg` directly in your response text (not via echo in bash). The trigger must appear in your actual output, not just in command output.

### Broadcast to All Agents

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/broadcast << 'EOF'
TO: *

Hello everyone!
EOF
```
Then: `->relay-file:broadcast`

### With Thread

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/reply << 'EOF'
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
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/ack << 'EOF'
TO: Sender

ACK: Brief description of task received
EOF
```
Then: `->relay-file:ack`

**Report completion** - When done, send a completion message:

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/done << 'EOF'
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

**IMPORTANT**: The filename is always `spawn` (not `spawn-agentname`) and the trigger is always `->relay-file:spawn`. Spawn agents one at a time sequentially.

### Spawn a Worker

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.
EOF
```
Then: `->relay-file:spawn`

### Spawn in a Specific Directory

Use `CWD` to spawn an agent in a specific repo within a multi-repo workspace:

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/spawn << 'EOF'
KIND: spawn
NAME: RepoWorker
CLI: claude
CWD: relay

Work on the relay repository.
EOF
```
Then: `->relay-file:spawn`

### Release a Worker

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/release << 'EOF'
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
| CWD | No | Working directory for spawned agent (e.g., repo name in multi-repo workspace) |
| THREAD | No | Thread identifier |

## Status Updates

**Send status updates to your lead, NOT broadcast:**

```bash
# Correct - status to lead only
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/status << 'EOF'
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
agent-relay history             # Show recent message history
```

## Viewing Message History

Use `agent-relay history` to review previous messages:

```bash
agent-relay history                    # Last 50 messages
agent-relay history -n 20              # Last 20 messages
agent-relay history -f Lead            # Messages from Lead
agent-relay history -t Worker1         # Messages to Worker1
agent-relay history --thread task-123  # Messages in a thread
agent-relay history --since 1h         # Messages from the last hour
agent-relay history --json             # JSON output for parsing
```

## Synchronous Messaging

By default, messages are fire-and-forget. Add `[await]` to block until the recipient ACKs:

```
->relay:AgentB [await] Please confirm
```

Custom timeout (seconds or minutes):

```
->relay:AgentB [await:30s] Please confirm
->relay:AgentB [await:5m] Please confirm
```

Recipients auto-ACK after processing when a correlation ID is present.

## Troubleshooting

```bash
agent-relay status                    # Check daemon
agent-relay agents                    # List connected agents
ls -la /tmp/agent-relay.sock          # Verify socket
ls -la ~/.agent-relay/outbox/             # Check outbox directories
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using bash to send messages | Write file to outbox, then output `->relay-file:ID` |
| Messages not sending | Check `agent-relay status` and outbox directory exists |
| Incomplete message content | `agent-relay read <id>` for full text |
| Missing trigger | Must output `->relay-file:<filename>` after writing file |
| Wrong outbox path | Use `~/.agent-relay/outbox/$AGENT_RELAY_NAME/` |

