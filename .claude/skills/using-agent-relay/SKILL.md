---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via tmux wrapper (sub-5ms latency) or file-based team inbox for async workflows
---

# Using agent-relay

## Overview

Real-time agent-to-agent messaging. Two modes: **tmux wrapper** (real-time, sub-5ms) and **file-based team** (async, simpler).

## When to Use

- Multiple agents coordinating on shared codebase
- Turn-based interactions (games, reviews, task handoff)
- Parallel task distribution
- Real-time Claude/Codex/Gemini collaboration

**Don't use:** Single agent, cross-host networking, guaranteed delivery required.

## Quick Reference

| Pattern | Description |
|---------|-------------|
| `->relay:Name <<<`...`>>>` | **Default format** - always use fenced format |
| `->relay:* <<<`...`>>>` | Broadcast to all agents |
| `[[RELAY]]{"to":"Name","body":"msg"}[[/RELAY]]` | Structured JSON |
| `\->relay:` | Escape (literal output) |
| `relay read <id>` | Read truncated message |

## CLI Commands

```bash
relay -f                    # Start daemon + dashboard
relay --status              # Check daemon
relay --stop                # Stop daemon
relay wrap -n Alice claude  # Wrap agent with messaging
relay read abc123           # Read truncated message
```

### Team Commands (file-based)

```bash
relay team send -n You -t Recipient -m "Message"
relay team send -n You -t "*" -m "Broadcast"
relay team check -n You --no-wait     # Non-blocking
relay team check -n You --clear       # Clear after read
relay team status                     # Show team
```

## Sending Messages (Tmux Mode)

**Output the pattern directly** - don't use bash commands. Always use the fenced format:

```
->relay:BlueLake <<<
I've finished the API refactor.>>>

->relay:* <<<
STATUS: Starting auth module.>>>
```

### Fenced Format (Default)

The fenced format is the default for all messages:

```
->relay:Reviewer <<<
REVIEW REQUEST: Auth Module

Please check:
- src/auth/login.ts
- src/auth/session.ts

Key changes:
1. Added JWT validation
2. Fixed session expiry>>>
```

**CRITICAL:** Always end with `>>>` at the end of the last line of content! The `<<<` opens, `>>>` closes.

**Limits:** Fenced messages max 200 lines. For longer content, send summary with reference ID.

**Fallback:** If you forget `>>>`, message auto-closes on double blank line.

### Pattern Rules

Pattern must be at line start (whitespace/prefixes OK):

```
->relay:Name message          # Works
  ->relay:Name message        # Works
- ->relay:Name message        # Works
Some text ->relay:Name msg    # Won't work
```

## Receiving Messages

Messages appear as:
```
Relay message from Alice [abc123]: Message here
```

### Truncated Messages

Long messages show `[TRUNCATED...]`. Read full content:
```bash
relay read abc123
```

**Rule:** If message ends abruptly, always read full message before responding.

## Coordination Patterns

```
# Task assignment
->relay:Developer <<<
TASK: Implement /api/register>>>

# Status broadcast
->relay:* <<<
STATUS: Starting auth module>>>

->relay:* <<<
DONE: Auth complete>>>

# Review request
->relay:Reviewer <<<
REVIEW: src/auth/*.ts>>>

# Question
->relay:Architect <<<
QUESTION: JWT or sessions?>>>

# Blocked
->relay:* <<<
BLOCKED: Need DB credentials>>>
```

## Spawning Agents

Any agent can spawn worker agents to delegate tasks:

```
# Spawn a worker
->relay:spawn WorkerName cli "task description"

# Examples
->relay:spawn Dev1 claude "Implement the login endpoint"
->relay:spawn Tester claude "Write unit tests for auth module"

# Release when done
->relay:release WorkerName
```

Workers run in separate tmux windows and can communicate back via `->relay:` patterns.

## Multi-Project Bridge

```bash
# Bridge multiple projects
relay bridge ~/auth ~/frontend ~/api

# Cross-project messaging
@relay:projectId:agent Message
@relay:*:lead Broadcast to leads
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using bash to send real-time messages | Output `->relay:` directly as text |
| Messages not sending | `relay --status` to check daemon |
| Incomplete message content | `relay read <id>` for full text |
| Pattern not at line start | Move `->relay:` to beginning |
| Forgetting to clear inbox | Use `--clear` flag |

## Troubleshooting

```bash
relay --status                    # Check daemon
relay --stop && relay -f          # Restart
ls -la /tmp/agent-relay.sock      # Verify socket
```
