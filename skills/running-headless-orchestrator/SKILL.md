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

| Step | Command/Tool |
|------|--------------|
| Verify installation | `which agent-relay` or `npx agent-relay --version` |
| Start infrastructure | `agent-relay up --background --no-dashboard` |
| Check status | `agent-relay status` |
| Spawn worker | `agent-relay spawn Worker1 claude "task"` |
| List workers | `agent-relay agents` |
| View worker logs | `agent-relay agents:logs Worker1` |
| Send message | `agent-relay send Worker1 "message"` |
| Release worker | `agent-relay release Worker1` |
| Stop infrastructure | `agent-relay down` |

## Bootstrap Flow

### Step 0: Verify Installation

```bash
# Check if agent-relay is installed
which agent-relay || npx agent-relay --version

# If not installed, install globally
npm install -g agent-relay

# Or use npx (no install needed)
npx agent-relay --version
```

### Step 1: Start Infrastructure

```bash
# Start broker in background (no dashboard needed for headless)
agent-relay up --background --no-dashboard

# Verify it's running
agent-relay status
```

The broker:
- Auto-creates a Relaycast workspace if `RELAY_API_KEY` not set
- Removes `CLAUDECODE` env var when spawning (fixes nested session error)
- Persists state to `.agent-relay/`

### Step 2: Spawn Workers via MCP

```
mcp__relaycast__add_agent(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

### Step 3: Monitor and Coordinate

```
# Check for worker messages
mcp__relaycast__check_inbox()

# Send follow-up instructions
mcp__relaycast__send_dm(to: "Worker1", text: "Also add unit tests")

# List active workers
mcp__relaycast__list_agents()
```

### Step 4: Release Workers

```
mcp__relaycast__remove_agent(name: "Worker1")
```

### Step 5: Shutdown (optional)

```bash
agent-relay down
```

## CLI Commands for Orchestration

**Use the `agent-relay` CLI extensively for monitoring and managing workers.** The CLI provides essential visibility into agent activity.

### Spawning and Messaging

```bash
# Spawn a worker
agent-relay spawn Worker1 claude "Implement auth module"

# Send message to worker
agent-relay send Worker1 "Add unit tests too"

# Release when done
agent-relay release Worker1
```

### Monitoring Workers (Essential)

```bash
# List all active agents with status
agent-relay agents

# View real-time output from a worker (critical for debugging)
agent-relay agents:logs Worker1

# View recent message history
agent-relay history

# Check overall system status
agent-relay status
```

### Troubleshooting

```bash
# Kill unresponsive worker
agent-relay agents:kill Worker1

# Check system health
agent-relay health

# View metrics
agent-relay metrics
```

**Tip:** Run `agent-relay agents:logs <name>` frequently to monitor worker progress and catch errors early.

## Orchestrator Instructions Template

Give your lead agent these instructions:

```
You are an autonomous orchestrator. Bootstrap the relay infrastructure and manage a team of workers.

## Step 1: Verify Installation
Run: which agent-relay || npx agent-relay --version
If not found: npm install -g agent-relay

## Step 2: Start Infrastructure
Run: agent-relay up --background --no-dashboard
Verify: agent-relay status (should show "running")

## Step 3: Manage Your Team

Spawn workers:
  agent-relay spawn Worker1 claude "Task description"

Monitor workers (do this frequently):
  agent-relay agents          # List active workers
  agent-relay agents:logs Worker1  # View worker output/progress

Send instructions:
  agent-relay send Worker1 "Additional instructions"

Release when done:
  agent-relay release Worker1

## Protocol
- Workers will ACK when they receive tasks
- Workers will send DONE when complete
- Use `agent-relay agents:logs <name>` to monitor progress
- Use `agent-relay history` to see message flow
```

## Lifecycle Events

The broker emits these events (available via SDK subscriptions):

| Event | When |
|-------|------|
| `agent_spawned` | Worker process started |
| `worker_ready` | Worker connected to relay |
| `agent_idle` | Worker waiting for messages |
| `agent_exited` | Worker process ended |
| `agent_permanently_dead` | Worker failed after retries |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `agent-relay: command not found` | Install with `npm i -g agent-relay` or use `npx agent-relay` |
| "Nested session" error | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var |
| Broker not starting | Check `agent-relay status`; may need `agent-relay down` first |
| Workers not connecting | Ensure broker started; check `agent-relay agents` |
| Not monitoring workers | Use `agent-relay agents:logs <name>` frequently to track progress |
| Workers seem stuck | Check logs with `agent-relay agents:logs <name>` for errors |
| Messages not delivered | Check `agent-relay history` to verify message flow |

## Prerequisites

1. **agent-relay CLI installed** (required)
   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For MCP tools** (optional): Relaycast MCP server configured in Claude's MCP settings
