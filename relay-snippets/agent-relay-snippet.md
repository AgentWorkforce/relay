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

## Sending Messages

Write a file to your outbox, then output the trigger:

```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: AgentName

Your message here.
EOF
```

IMPORTANT: Output the trigger `->relay-file:msg` directly in your response text (not via echo in bash). The trigger must appear in your actual output, not just in command output.

> **Note**: `$AGENT_RELAY_OUTBOX` is automatically set by agent-relay when spawning agents. Data is stored in `.agent-relay/` within your project directory.

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
| Bridge (to another lead) | `TO: otherproject:lead` | N/A |

**Common mistake**: Using `project:lead` when communicating locally. This will fail because the relay looks for an agent literally named "project:lead".

```bash
# CORRECT - local communication to Lead agent
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Lead

Status update here.
EOF
```

```bash
# WRONG - project: prefix is only for bridge mode
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: project:lead

This will fail locally!
EOF
```

## Spawning & Releasing

**IMPORTANT**: The filename is always `spawn` (not `spawn-agentname`) and the trigger is always `->relay-file:spawn`. Spawn agents one at a time sequentially.

```bash
# Spawn
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.
EOF
```
Then: `->relay-file:spawn`

```bash
# Release
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: WorkerName
EOF
```
Then: `->relay-file:release`

## When You Are Spawned

If you were spawned by another agent:

1. **Check who spawned you**: `echo $AGENT_RELAY_SPAWNER`
2. **Your first message** is your task from your spawner - reply to THEM, not "spawner"
3. **Report status** to your spawner (your lead), not broadcast

```bash
# Check your spawner
echo "I was spawned by: $AGENT_RELAY_SPAWNER"

# Reply to your spawner
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: $AGENT_RELAY_SPAWNER

ACK: Starting on the task.
EOF
```
Then: `->relay-file:msg`

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Content here
```

Channel messages include `[#channel]`:
```
Relay message from Alice [abc123] [#general]: Hello!
```
Reply to the channel shown, not the sender.

## Protocol

- **ACK** when you receive a task: `ACK: Brief description`
- **DONE** when complete: `DONE: What was accomplished`
- Send status to your **lead** (the agent in `$AGENT_RELAY_SPAWNER`), not broadcast

## Headers Reference

| Header | Required | Description |
|--------|----------|-------------|
| TO | Yes (messages) | Target agent/channel |
| KIND | No | `message` (default), `spawn`, `release` |
| NAME | Yes (spawn/release) | Agent name |
| CLI | Yes (spawn) | CLI to use |
| THREAD | No | Thread identifier |
