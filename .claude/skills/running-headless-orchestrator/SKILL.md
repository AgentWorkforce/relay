---
name: running-headless-orchestrator
description: Use when an agent needs to self-bootstrap agent-relay and autonomously manage a team of workers - covers infrastructure startup, agent spawning, lifecycle monitoring, and team coordination without human intervention
---

# Headless Orchestrator

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

## Overview

A headless orchestrator is an agent that:

1. Starts the relay infrastructure itself (`agent-relay up`)
2. Spawns and manages worker agents
3. Monitors agent lifecycle events
4. Coordinates work without human intervention

## When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

## Quick Reference

| Step                              | Command/Tool                                            |
| --------------------------------- | ------------------------------------------------------- |
| Verify installation               | `command -v agent-relay` or `npx agent-relay --version` |
| Verify Node runtime if shim fails | `node --version` or fix mise/asdf first                 |
| Start infrastructure              | `agent-relay up --no-dashboard --verbose`               |
| Check status                      | `agent-relay status`                                    |
| Spawn worker                      | `agent-relay spawn Worker1 claude "task"`               |
| List workers                      | `agent-relay who`                                       |
| View worker logs                  | `agent-relay agents:logs Worker1`                       |
| Send DM to worker                 | `agent-relay send Worker1 "message"`                    |
| Post to channel                   | `agent-relay send '#general' "message"`                 |
| Read worker's unread DM replies   | `agent-relay inbox --agent Worker1`                     |
| Read full DM conversation history | `agent-relay history --to Worker1`                      |
| Release worker                    | `agent-relay release Worker1`                           |
| Stop infrastructure               | `agent-relay down`                                      |

## Bootstrap Flow

### Step 0: Verify Installation

```bash
# Check if agent-relay is available
command -v agent-relay || npx agent-relay --version

# If your shell reports a mise/asdf shim error, fix Node first
node --version
# e.g. for mise: mise use -g node@22.22.1

# If not installed, install globally
npm install -g agent-relay

# Or use npx (no global install)
npx agent-relay --version
```

### Step 1: Start Infrastructure

Prefer a **foreground stdio broker** first. Background mode can be flaky in some environments and may report "started" while `agent-relay status` still shows `STOPPED`.

```bash
# Preferred: run broker in foreground/stdin mode and keep the session open
agent-relay up --no-dashboard --verbose
```

Verify broker readiness before spawning any workers:

```bash
# Must show "running" before you spawn workers
agent-relay status
```

The broker:

- Auto-creates a Relaycast workspace if `RELAY_API_KEY` not set
- Removes `CLAUDECODE` env var when spawning (fixes nested session error)
- Persists state to `.agent-relay/`

### Step 2: Spawn Workers via MCP

```
mcp__relaycast__agent_add(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

CLI equivalent:

```bash
agent-relay spawn Worker1 claude "Implement the authentication module following the existing patterns"
```

### Step 3: Monitor and Coordinate

```
# Check if workers have replied (returns unread counts — not the content)
mcp__relaycast__message_inbox_check()

# List Worker1's DM conversations (use `as` to specify the agent)
mcp__relaycast__message_dm_list(as: "Worker1")

# Send a targeted DM to a specific worker
mcp__relaycast__message_dm_send(to: "Worker1", text: "Also add unit tests")

# Broadcast to all agents on a channel
mcp__relaycast__message_post(channel: "general", text: "All workers: wrap up current task")

# List active workers
mcp__relaycast__agent_list()
```

### Step 4: Release Workers

```
mcp__relaycast__agent_remove(name: "Worker1")
```

### Step 5: Shutdown (optional)

```bash
agent-relay down
```

## CLI Commands for Orchestration

**Use the `agent-relay` CLI extensively for monitoring and managing workers.** The CLI provides essential visibility into agent activity.

### Channel vs DM — When to Use Each

**DM** — targeted, private, for responses you need to read back:

- `agent-relay send Worker1 "message"` — sends a DM to Worker1
- `mcp__relaycast__message_dm_send(to: "Worker1", text: "...")` — same via MCP
- Worker replies arrive as DMs back to the sender

**Channel post** — broadcast, visible to all agents on that channel:

- `agent-relay send '#general' "message"` — posts to #general (`#` prefix required)
- `mcp__relaycast__message_post(channel: "general", text: "...")` — same via MCP
- Use for coordination messages, status updates, announcements

**Critical: `history` only shows channel messages, not DMs.**
After sending a DM to a worker, their reply will NOT appear in `agent-relay history`.
Use `inbox --agent` or `message_dm_list` to read DM replies.

`inbox --agent <name>` shows only **unread** notifications — once read, they disappear.
For the **full conversation thread** (including already-read messages) use `history --to <agent>`.

```bash
# WRONG — history (no flags) will not show DM replies from workers
agent-relay history

# Read a worker's UNREAD DM replies (clears after reading)
agent-relay inbox --agent Worker1

# Read the full DM conversation history with a worker (read + unread)
agent-relay history --to Worker1

# Read only the thread between two specific agents
agent-relay history --to Worker1 --from Orchestrator
```

```
# WRONG — inbox_check only tells you there are unread messages, not what they say
mcp__relaycast__message_inbox_check()

# RIGHT — list Worker1's DM conversations and content (as = the agent to read as)
mcp__relaycast__message_dm_list(as: "Worker1")
```

### Spawning and Messaging

```bash
# Spawn a worker
agent-relay spawn Worker1 claude "Implement auth module"

# Send a DM to a specific worker (replies readable via inbox --agent)
agent-relay send Worker1 "Add unit tests too"

# Broadcast to all workers via channel
agent-relay send '#general' "Team: wrap up and report status"

# Read Worker1's DM reply
agent-relay inbox --agent Worker1

# Release when done
agent-relay release Worker1
```

### Monitoring Workers (Essential)

```bash
# Show currently active agents
agent-relay who

# View real-time output from a worker (critical for debugging)
agent-relay agents:logs Worker1

# Read DM replies from a specific worker
agent-relay inbox --agent Worker1

# View channel message history (channel posts only — not DMs)
agent-relay history --to '#general'

# Check overall system status
agent-relay status
```

### Troubleshooting

```bash
# Kill unresponsive worker
agent-relay agents:kill Worker1

# Re-check broker status
agent-relay status

# If a worker looks stuck, inspect its logs first
agent-relay agents:logs Worker1
```

**Tip:** Run `agent-relay agents:logs <name>` frequently to monitor worker progress and catch errors early.

## Orchestrator Instructions Template

Give your lead agent these instructions:

```
You are an autonomous orchestrator. Bootstrap the relay infrastructure and manage a team of workers.

## Step 1: Verify Installation
Run: command -v agent-relay || npx agent-relay --version
If you hit a mise/asdf shim error: verify Node first with `node --version`, then fix the runtime manager
If not found: npm install -g agent-relay

## Step 2: Start Infrastructure
Run: agent-relay up --no-dashboard --verbose
Verify: agent-relay status (should show "running")

## Step 3: Manage Your Team

Spawn workers:
  agent-relay spawn Worker1 claude "Task description"

Monitor workers (do this frequently):
  agent-relay who              # List active workers
  agent-relay agents:logs Worker1  # View worker output/progress

Send targeted DM instructions:
  agent-relay send Worker1 "Additional instructions"

Broadcast to all workers:
  agent-relay send '#general' "All workers: prioritize the auth module"

Read worker replies (DMs are not visible in history):
  agent-relay inbox --agent Worker1

Release when done:
  agent-relay release Worker1

## Protocol
- Workers will ACK when they receive tasks
- Workers will send DONE when complete
- Use `agent-relay agents:logs <name>` to monitor progress
- Use `agent-relay inbox --agent <name>` to read **unread** DM replies from a worker (clears after reading)
- Use `agent-relay history --to <name>` to re-read the full DM conversation (read + unread)
- Use `agent-relay history --to '#general'` to see channel message flow
- Do NOT use `agent-relay history` alone to check worker replies — it only shows channel posts, DM replies are invisible there
```

## Lifecycle Events

The broker emits these events (available via SDK subscriptions):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

## Common Mistakes

| Mistake                                                    | Fix                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-relay: command not found` or mise/asdf shim error   | Ensure Node is available first (`node --version`); if a shim is broken, fix the runtime manager, then install/use `agent-relay`                                           |
| "Nested session" error                                     | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var                                                                                        |
| Broker not starting                                        | Try `agent-relay down` first, then use foreground `agent-relay up --no-dashboard --verbose` to see readiness logs                                                         |
| Background broker says started but status is STOPPED       | Prefer foreground mode for that project/session; background mode may have detached incorrectly                                                                            |
| Spawn fails with `internal reply dropped`                  | Broker likely is not fully ready yet; wait for readiness, then spawn one worker first                                                                                     |
| Workers not connecting                                     | Ensure broker started; check `agent-relay who` and worker logs                                                                                                            |
| Not monitoring workers                                     | Use `agent-relay agents:logs <name>` frequently to track progress                                                                                                         |
| Workers seem stuck                                         | Check logs with `agent-relay agents:logs <name>` for errors                                                                                                               |
| Messages not delivered                                     | Check `agent-relay history --to '#general'` for channel messages; use `agent-relay inbox --agent <name>` for DMs                                                          |
| Worker replies not showing in history                      | Expected — `history` only shows channel posts. Use `agent-relay inbox --agent <name>` (unread only) or `agent-relay history --to <name>` (full thread) to read DM replies |
| `inbox_check` shows unread but can't see content           | `inbox_check` only returns counts. Use `mcp__relaycast__message_dm_list(as: "<name>")` to list conversations, or `agent-relay inbox --agent <name>` via CLI               |
| `inbox --agent` showed messages once but now shows nothing | `inbox` only shows **unread** — already-read messages won't reappear. Use `agent-relay history --to <name>` to re-read the full conversation                              |
| Sent to wrong destination                                  | `agent-relay send Worker1 "..."` = DM; `agent-relay send '#general' "..."` = channel broadcast. The `#` prefix is required for channels                                   |

## Prerequisites

1. **agent-relay CLI installed** (required)

   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For MCP tools** (optional): Relaycast MCP server configured in Claude's MCP settings
