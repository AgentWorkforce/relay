---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via file-based protocol with reliability features including retry escalation and inbox notifications
---

# CRITICAL: Relay-First Communication Rule

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

**TWO STEPS REQUIRED:**

**Step 1:** EXECUTE this bash command (you MUST run it via your Bash/shell tool, not just display it):

```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: AgentName

Your message here.
EOF
```

**Step 2:** Output the trigger `->relay-file:msg` directly in your response text (after the bash command succeeds).

CRITICAL: You must EXECUTE the bash command above - do NOT just display it as a code block. The file must actually be created on disk. Then output the trigger as plain text.

> **Note**: `$AGENT_RELAY_OUTBOX` is automatically set by agent-relay when spawning agents.

### Broadcast to All Agents

```bash
cat > $AGENT_RELAY_OUTBOX/broadcast << 'EOF'
TO: *

Hello everyone!
EOF
```
Then: `->relay-file:broadcast`

### With Thread

```bash
cat > $AGENT_RELAY_OUTBOX/reply << 'EOF'
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

## Agent Naming (Local vs Bridge)

**Local communication** uses plain agent names. The `project:` prefix is **ONLY** for cross-project bridge mode.

| Context | Correct | Incorrect |
|---------|---------|-----------|
| Local (same project) | `TO: Lead` | `TO: project:lead` |
| Local (same project) | `TO: Worker1` | `TO: myproject:Worker1` |
| Bridge (cross-project) | `TO: frontend:Designer` | N/A |

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge it before starting work:

```bash
cat > $AGENT_RELAY_OUTBOX/ack << 'EOF'
TO: Sender

ACK: Brief description of task received
EOF
```
Then: `->relay-file:ack`

**Report completion** - When done, send a completion message:

```bash
cat > $AGENT_RELAY_OUTBOX/done << 'EOF'
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

Channel messages include `[#channel]`:
```
Relay message from Alice [abc123] [#general]: Hello everyone!
```

**When you see `[#general]`**: Reply to `*` (broadcast), NOT to the sender directly.

## Spawning & Releasing Agents

**IMPORTANT**: The filename is always `spawn` and the trigger is always `->relay-file:spawn`. Spawn agents one at a time sequentially.

### Spawn a Worker

```bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.
EOF
```
Then: `->relay-file:spawn`

### CLI Options

| CLI Value | Description |
|-----------|-------------|
| `claude` | Claude Code (Anthropic) |
| `codex` | Codex CLI (OpenAI) |
| `gemini` | Gemini CLI (Google) |
| `aider` | Aider coding assistant |
| `goose` | Goose AI assistant |

### Release a Worker

```bash
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: WorkerName
EOF
```
Then: `->relay-file:release`

## When You Are Spawned

If you were spawned by another agent:

1. **Check who spawned you**: `echo $AGENT_RELAY_SPAWNER`
2. **Your first message** is your task from your spawner - reply to THEM
3. **Report status** to your spawner, not broadcast

```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: $AGENT_RELAY_SPAWNER

ACK: Starting on the task.
EOF
```
Then: `->relay-file:msg`

## Synchronous Messaging

By default, messages are fire-and-forget. Add `[await]` to block until the recipient ACKs:

```
->relay:AgentB [await] Please confirm
->relay:AgentB [await:30s] Please confirm
```

## Viewing Message History

```bash
agent-relay history                    # Last 50 messages
agent-relay history -n 20              # Last 20 messages
agent-relay history -f Lead            # Messages from Lead
agent-relay history -t Worker1         # Messages to Worker1
agent-relay history --thread task-123  # Messages in a thread
agent-relay history --since 1h         # Messages from the last hour
```

## Headers Reference

| Header | Required | Description |
|--------|----------|-------------|
| TO | Yes (messages) | Target agent/channel |
| KIND | No | `message` (default), `spawn`, `release` |
| NAME | Yes (spawn/release) | Agent name |
| CLI | Yes (spawn) | CLI to use |
| CWD | No | Working directory for spawned agent |
| THREAD | No | Thread identifier |

## Status Updates

**Send status updates to your lead, NOT broadcast:**

```bash
cat > $AGENT_RELAY_OUTBOX/status << 'EOF'
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

## Troubleshooting

```bash
agent-relay status                    # Check daemon
agent-relay agents                    # List connected agents
ls -la /tmp/agent-relay.sock          # Verify socket
```

| Mistake | Fix |
|---------|-----|
| Using bash to send messages | Write file to outbox, then output `->relay-file:ID` |
| Messages not sending | Check `agent-relay status` and outbox directory exists |
| Missing trigger | Must output `->relay-file:<filename>` after writing file |
| Wrong outbox path | Use `$AGENT_RELAY_OUTBOX` environment variable |
