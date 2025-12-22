* Use the `bd` tool instead of markdown to coordinate all work and tasks.
* NEVER commit changes unless the user explicitly asks you to.

# Using bv as an AI sidecar

bv is a fast terminal UI for Beads projects (.beads/beads.jsonl). It renders lists/details and precomputes dependency metrics (PageRank, critical path, cycles, etc.) so you instantly see blockers and execution order. For agents, it's a graph sidecar: instead of parsing JSONL or risking hallucinated traversal, call the robot flags to get deterministic, dependency-aware outputs.

*IMPORTANT: As an agent, you must ONLY use bv with the robot flags, otherwise you'll get stuck in the interactive TUI that's intended for human usage only!*

- bv --robot-help — shows all AI-facing commands.
- bv --robot-insights — JSON graph metrics (PageRank, betweenness, HITS, critical path, cycles) with top-N summaries for quick triage.
- bv --robot-plan — JSON execution plan: parallel tracks, items per track, and unblocks lists showing what each item frees up.
- bv --robot-priority — JSON priority recommendations with reasoning and confidence.
- bv --robot-recipes — list recipes (default, actionable, blocked, etc.); apply via bv --recipe <name> to pre-filter/sort before other flags.
- bv --robot-diff --diff-since <commit|date> — JSON diff of issue changes, new/closed items, and cycles introduced/resolved.

Use these commands instead of hand-rolling graph logic; bv already computes the hard parts so agents can act safely and quickly.

## Integrating with Beads (dependency-aware task planning)

Beads provides a lightweight, dependency-aware issue database and a CLI (`bd`) for selecting "ready work," setting priorities, and tracking status. Project: [steveyegge/beads](https://github.com/steveyegge/beads)

Recommended conventions
- **Single source of truth**: Use **Beads** for task status/priority/dependencies.
- **Shared identifiers**: Use the Beads issue id (e.g., `bd-123`) as identifiers and prefix message subjects with `[bd-123]`.

Typical flow (agents)
1) **Pick ready work** (Beads)
   - `bd ready --json` → choose one item (highest priority, no blockers)
2) **Announce start**
   - Update status: `bd update <id> --status=in_progress`
3) **Work and update**
   - Make progress on the task
4) **Complete**
   - `bd close <id> --reason "Completed"` (Beads is status authority)

Pitfalls to avoid
- Don't create or manage tasks in markdown; treat Beads as the single task queue.
- Always include `bd-###` in commit messages for traceability.

---

# Agent Instructions for agent-relay

> **Copy this file to your project** to enable AI agents to communicate with each other using agent-relay.

## Overview

This project uses [agent-relay](https://github.com/khaliqgant/agent-relay) for real-time agent-to-agent messaging. There are two communication modes:

1. **Tmux Wrapper Mode (Recommended)** - Real-time messaging via Unix sockets with tmux session management
2. **File-Based Team Mode** - Asynchronous messaging via file system (simpler, more reliable)

---

## Quick Start: Tmux Wrapper (Recommended)

Use the tmux wrapper for real-time messaging:

```bash
# Start daemon (dashboard starts automatically)
relay -f                    # foreground mode with dashboard

# Wrap your agent with tmux (real-time)
relay wrap -n PlayerX claude
relay wrap -n PlayerO claude
```

### Flags
- `-q, --quiet` - Disable debug logging
- `--no-dashboard` - Disable web dashboard
- `--stop` - Stop the daemon
- `--status` - Show daemon status

### Why tmux?
- Real terminal: you attach directly to tmux (no double PTY).
- Background capture/parse of `>>relay:` without touching stdout.
- Reliable injection via `tmux send-keys`.

---

## Team Communication

If you have an INSTRUCTIONS.md file in `/tmp/agent-relay-team/{YourName}/`, use these commands:

```bash
# Check your inbox (non-blocking)
relay team check -n YourName --no-wait

# Send message to teammate
relay team send -n YourName -t RecipientName -m "Your message"

# Broadcast to all
relay team send -n YourName -t "*" -m "Your message"

# Team status
relay team status
```

**Check your inbox periodically and broadcast status updates!**

---

## Quick Reference

### Sending Messages (Real-Time Mode)

**Inline format** (simple messages):
```
>>relay:AgentName Your message here
>>relay:* Broadcast to all agents
```

**Block format** (structured data):
```
[[RELAY]]{"to":"AgentName","type":"message","body":"Your message"}[[/RELAY]]
```

### Receiving Messages

Messages appear in your terminal as:
```
Relay message from SenderName: Message content here
```

Or in your inbox file as:
```markdown
## Message from SenderName | 2024-01-15T10:30:00Z
Message content here
```

---

## Mode 1: Tmux Wrapper (Real-Time) - RECOMMENDED

Use this when you're wrapped with `relay wrap`.

### CRITICAL: How to Send Messages

**You (the AI agent) must OUTPUT the >>relay pattern as part of your response.** Do not wait for user input. The pattern is detected from your terminal output.

**Correct - Output this directly:**
```
>>relay:PlayerO I've finished the API refactor. Ready for your review.
```

**Wrong - Don't use bash commands for real-time messaging:**
```bash
# This uses file-based inbox, NOT real-time socket delivery
relay team send -n MyName -t PlayerO -m "message"
```

### Pattern Requirements

The `>>relay:` pattern must appear on its own line. It can have common terminal/markdown prefixes:

```
>>relay:AgentName message          Works
  >>relay:AgentName message        Works (leading whitespace OK)
> >>relay:AgentName message        Works (input prompt OK)
$ >>relay:AgentName message        Works (shell prompt OK)
- >>relay:AgentName message        Works (list items OK)
* >>relay:AgentName message        Works (asterisk lists OK)
Some text >>relay:AgentName msg    Won't work (not at line start)
```

### Examples

**Direct message:**
```
>>relay:PlayerO Your turn! I played X at center.
```

**Broadcast to all agents:**
```
>>relay:* I've completed the authentication module. Ready for review.
```

**Structured data:**
```
[[RELAY]]
{"to": "PlayerO", "type": "action", "body": "Task completed", "data": {"files": ["auth.ts"]}}
[[/RELAY]]
```

### Receiving Messages

When another agent sends you a message, it appears in your terminal as:
```
Relay message from PlayerO: Their message content here
```

Respond by outputting another `>>relay:` pattern.

### IMPORTANT: Handling Truncated Messages

**CRITICAL**: If a message appears cut off or incomplete, ALWAYS use the message ID to read the full content. Messages may be truncated even without showing `[TRUNCATED...]`.

Long messages (>500 chars) explicitly show:
```
Relay message from PlayerO [abc123def]: Beginning of message... [TRUNCATED - run "relay read abc123def" for full message]
```

But messages can also be cut off mid-sentence without the truncation marker:
```
Relay message from PlayerO [abc123def]: I've analyzed the issue. Here's what
```

**In either case**, run the read command with the message ID (the 8-character code in brackets):
```bash
relay read abc123def
```

This retrieves the complete message from the database.

**Rule**: If a message seems incomplete or ends abruptly, read the full message before responding.

### Escaping

To output literal `>>relay:` without triggering the parser:
```
\>>relay: This won't be sent as a message
```

---

## Mode 2: File-Based Team Mode (Asynchronous)

Use this for scripts, automation, or when tmux wrapping isn't available.

### Setup a Team

```bash
# Create team from JSON config
relay team setup -f team-config.json

# Or use inline JSON
relay team setup -c '{"name":"myteam","agents":[{"name":"Dev","cli":"claude","role":"Developer"}]}'

# Start a team (setup + listen for messages)
relay team start -f team-config.json
```

### Sending Messages

```bash
# Send to one agent
relay team send -n YourName -t RecipientName -m "Your message"

# Broadcast to all agents
relay team send -n YourName -t "*" -m "Broadcast message"
```

### Reading Messages

```bash
# Read inbox (non-blocking)
relay team check -n YourName --no-wait

# Wait for messages (blocking)
relay team check -n YourName

# Read and clear inbox
relay team check -n YourName --clear
```

### Message Format in Inbox

Messages in your inbox file look like:
```markdown
## Message from SenderName | 2024-01-15T10:30:00Z
The actual message content here.

## Message from AnotherAgent | 2024-01-15T10:31:00Z
Another message.
```

---

## Available Commands

Just 4 commands:

| Command | Description |
|---------|-------------|
| `relay` | Start daemon + dashboard (`--no-dashboard` to disable, `--stop`, `--status`) |
| `relay wrap` | Wrap agent CLI with relay messaging |
| `relay team` | Team operations (subcommands below) |
| `relay read` | Read full message by ID (for truncated messages) |

### Team Subcommands

| Subcommand | Description |
|------------|-------------|
| `relay team setup` | Create a team from JSON config |
| `relay team status` | Show team status with message counts |
| `relay team send` | Send message to teammate(s) |
| `relay team check` | Check your inbox |
| `relay team listen` | Watch inboxes and spawn agents on messages |
| `relay team start` | Start a team (setup + listen + spawn) |

---

## Message Types

| Type | Use Case |
|------|----------|
| `message` | General communication (default) |
| `action` | Commands, task assignments |
| `state` | Status updates, progress reports |
| `thinking` | Share reasoning (for transparency) |

---

## Coordination Patterns

### Task Handoff

```
>>relay:Developer TASK: Implement user registration endpoint
Requirements:
- POST /api/register
- Validate email format
- Hash password with bcrypt
- Return JWT token
```

### Status Updates

```
>>relay:* STATUS: Starting work on authentication module
>>relay:* DONE: Authentication module complete, ready for review
>>relay:Reviewer REVIEW: Please review src/auth/*.ts
```

### Requesting Help

```
>>relay:Architect QUESTION: Should we use JWT or session-based auth?
>>relay:* BLOCKED: Need database credentials to proceed
```

### Code Review Flow

```
# Developer requests review
>>relay:Reviewer REVIEW: src/api/users.ts - Added pagination support

# Reviewer provides feedback
>>relay:Developer FEEDBACK: Line 45 - Consider using cursor-based pagination for better performance

# Developer confirms fix
>>relay:Reviewer FIXED: Updated to cursor-based pagination, please re-review
```

---

## Agent Naming

Agent names follow the AdjectiveNoun format:
- `BlueLake`, `GreenCastle`, `RedMountain`, `SwiftFalcon`

Names are auto-generated if not specified, or you can set your own with `-n`:
```bash
relay wrap -n MyCustomName claude
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Messages not sending | Check daemon: `relay --status` |
| Inbox empty | Verify agent name and data directory |
| Socket not found | Start daemon: `relay -f` |
| Permission denied | Check data directory permissions |

### Check Daemon Status
```bash
relay --status
```

### Restart Daemon
```bash
relay --stop && relay -f
```

---

## More Information

- [Full Documentation](https://github.com/khaliqgant/agent-relay)
- [Protocol Specification](https://github.com/khaliqgant/agent-relay/blob/main/docs/PROTOCOL.md)
- [Examples](https://github.com/khaliqgant/agent-relay/tree/main/examples)
