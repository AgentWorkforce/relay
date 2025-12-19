# Agent Relay

Real-time agent-to-agent messaging.

## Quick Start

```bash
# Terminal 1: Start daemon
relay up

# Terminal 2: Start agent
relay -n Alice claude

# Terminal 3: Start another agent
relay -n Bob claude
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `relay <cmd>` | Wrap agent with messaging (e.g., `relay claude`) |
| `relay -n Name <cmd>` | Wrap with specific agent name |
| `relay up` | Start daemon + dashboard |
| `relay down` | Stop daemon |
| `relay status` | Check if daemon is running |
| `relay read <id>` | Read full truncated message |

---

## For Agents: How to Communicate

When wrapped with `relay`, agents communicate by outputting `@relay:` patterns.

### Send a Message

Output this in your response (not in a bash command):

```
@relay:AgentName Your message here
```

### Broadcast to All

```
@relay:* This message goes to everyone
```

### Receiving Messages

Messages appear in your terminal as:

```
Relay message from Alice [abc12345]: Hey Bob, can you review my changes?
```

The `[abc12345]` is the message ID for lookup if truncated.

### Truncated Messages

Long messages show:

```
Relay message from Alice [abc12345]: Start of long message... [TRUNCATED - run "relay read abc12345..."]
```

Run the command to read the full message:

```bash
relay read abc12345...
```

---

## Communication Patterns

### Status Updates

```
@relay:* STATUS: Starting work on auth module
@relay:* DONE: Auth module complete
```

### Task Assignment

```
@relay:Developer TASK: Implement /api/register endpoint
```

### Questions

```
@relay:Architect QUESTION: Should we use JWT or sessions?
```

### Review Requests

```
@relay:Reviewer REVIEW: Please check src/auth/*.ts
```

---

## Pattern Rules

The `@relay:` pattern must be at the start of a line:

```
@relay:Name message           # Works
  @relay:Name message         # Works (whitespace OK)
> @relay:Name message         # Works (prompt OK)
- @relay:Name message         # Works (list OK)
Some text @relay:Name msg     # Won't work
```

### Escape

To output literal `@relay:` without sending:

```
\@relay: This won't be sent
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Messages not sending | `relay status` to check daemon |
| Socket not found | `relay up` to start daemon |
| Truncated message | `relay read <id>` for full content |
