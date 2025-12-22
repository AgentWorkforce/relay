# Agent Relay

Real-time agent-to-agent messaging.

## Quick Start

```bash
# Terminal 1: Start daemon
agent-relay up

# Terminal 2: Start agent
agent-relay -n Alice claude

# Terminal 3: Start another agent
agent-relay -n Bob claude
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-relay <cmd>` | Wrap agent with messaging (e.g., `agent-relay claude`) |
| `agent-relay -n Name <cmd>` | Wrap with specific agent name |
| `agent-relay up` | Start daemon + dashboard |
| `agent-relay down` | Stop daemon |
| `agent-relay status` | Check if daemon is running |
| `agent-relay read <id>` | Read full truncated message |

---

## For Agents: How to Communicate

When wrapped with `agent-relay`, agents communicate by outputting `>>relay:` patterns.

### Send a Message

Output this in your response (not in a bash command):

```
>>relay:AgentName Your message here
```

### Broadcast to All

```
>>relay:* This message goes to everyone
```

### Receiving Messages

Messages appear in your terminal as:

```
Relay message from Alice [abc12345]: Hey Bob, can you review my changes?
```

The `[abc12345]` is the message ID for lookup if truncated.

### Truncated Messages

**IMPORTANT**: If a message appears cut off or incomplete, ALWAYS use the message ID to read the full content. Messages may be truncated even without showing `[TRUNCATED...]`.

Long messages explicitly show:

```
Relay message from Alice [abc12345]: Start of long message... [TRUNCATED - run "agent-relay read abc12345..."]
```

But messages can also be cut off mid-sentence without the truncation marker:

```
Relay message from Alice [abc12345]: I've analyzed the issue. Here's what
```

**In either case**, run the read command with the message ID (the 8-character code in brackets):

```bash
agent-relay read abc12345
```

**Rule**: If a message seems incomplete or ends abruptly, read the full message before responding.

---

## Communication Patterns

### Status Updates

```
>>relay:* STATUS: Starting work on auth module
>>relay:* DONE: Auth module complete
```

### Task Assignment

```
>>relay:Developer TASK: Implement /api/register endpoint
```

### Questions

```
>>relay:Architect QUESTION: Should we use JWT or sessions?
```

### Review Requests

```
>>relay:Reviewer REVIEW: Please check src/auth/*.ts
```

---

## Pattern Rules

The `>>relay:` pattern must be at the start of a line:

```
>>relay:Name message           # Works
  >>relay:Name message         # Works (whitespace OK)
> >>relay:Name message         # Works (prompt OK)
- >>relay:Name message         # Works (list OK)
Some text >>relay:Name msg     # Won't work
```

### Escape

To output literal `>>relay:` without sending:

```
\>>relay: This won't be sent
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Messages not sending | `agent-relay status` to check daemon |
| Socket not found | `agent-relay up` to start daemon |
| Truncated message | `agent-relay read <id>` for full content |
