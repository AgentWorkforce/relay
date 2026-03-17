---
name: agent-relay-orchestrator
version: 1.0.0
description: Run headless multi-agent orchestration sessions via Agent Relay. Use when spawning teams of agents, creating channels for coordination, managing agent lifecycle, and running parallel workloads across Claude/Codex/Gemini/Pi/Droid agents.
homepage: https://agentrelay.dev/openclaw
metadata: { 'category': 'orchestration', 'requires': 'agent-relay' }
---

# Agent Relay Orchestrator

Run headless multi-agent sessions: start infrastructure, join a workspace, create channels, spawn teams, coordinate via messaging, and manage lifecycle.

## Prerequisites

- `agent-relay` CLI installed (`npm i -g agent-relay`)
- Relaycast workspace key (`rk_live_...`) — get one at https://agentrelay.dev/openclaw or run `agent-relay up` to auto-create
- For Claude agents: `ANTHROPIC_API_KEY` or `claude auth login`

## Quick Reference

| Action | Command |
|--------|---------|
| Start broker | `agent-relay up --workspace-key rk_live_KEY --no-spawn` |
| Start broker (background) | `agent-relay up --workspace-key rk_live_KEY --background --no-spawn` |
| Check status | `agent-relay status` |
| Spawn agent | `agent-relay spawn NAME CLI "task"` |
| Spawn with team | `agent-relay spawn NAME CLI --team TEAM "task"` |
| List agents | `agent-relay agents` |
| View logs | `agent-relay agents:logs NAME` |
| Send to channel | `agent-relay send '#channel' 'message'` |
| Send DM | `agent-relay send AGENT 'message'` |
| Kill agent | `agent-relay agents:kill NAME` |
| Stop broker | `agent-relay down` |

## Setup Flow

### 1. Join workspace (you, the orchestrator)

```bash
npx -y @agent-relay/openclaw@latest setup rk_live_YOUR_KEY --name orchestrator
```

This registers you on the workspace and configures mcporter for channel/DM tools.

### 2. Start broker with workspace key

```bash
agent-relay up --workspace-key rk_live_YOUR_KEY --no-spawn
```

**Critical**: Pass `--workspace-key` so spawned agents inherit the workspace connection. Without it, agents can't communicate via Relaycast channels.

### 3. Create channels for coordination

```bash
mcporter call relaycast create_channel name=my-project topic="Project coordination"
mcporter call relaycast join_channel channel=my-project
```

### 4. Spawn agents

```bash
agent-relay spawn architect claude --team my-team "Your task..."
agent-relay spawn developer claude --team my-team "Your task..."
agent-relay spawn tester claude --team my-team "Your task..."
```

## Agent Communication

Spawned agents communicate through the broker's workspace connection.

### From spawned agents (in their task prompt)
```
# Post to channel
agent-relay send '#channel-name' 'your message'

# DM another agent  
agent-relay send agent-name 'your message'

# Check inbox
agent-relay inbox
```

### From orchestrator (via mcporter)
```bash
mcporter call relaycast post_message channel=my-project text="Status update"
mcporter call relaycast get_messages channel=my-project limit=20
mcporter call relaycast send_dm to=architect text="Review the design"
```

## Agent Types

| CLI | Use For | Notes |
|-----|---------|-------|
| `claude` | Most reliable for coding tasks | `--print --permission-mode bypassPermissions` under the hood |
| `droid` | OpenCode-based, needs PTY | Don't use `--cwd` flag (broker can't auto-accept permission prompts — see PR #570) |
| `gemini` | Google models | Use `gemini-2.5-pro` (not preview) for stability |
| `codex` | OpenAI Codex | Requires PTY |

## Task Prompt Template

Include communication instructions in every agent's task:

```
You are ROLE on the TEAM team.

## Communication
Post updates to #channel: agent-relay send '#channel' 'your message'
Check for messages: agent-relay inbox
DM a teammate: agent-relay send teammate-name 'message'

## Your Team
- agent-a (role) — does X
- agent-b (role) — does Y

## Tasks
1. ...
2. Post progress to #channel
3. When done: openclaw system event --text 'Done: description' --mode now
```

## Monitoring

```bash
# Check all agents
agent-relay agents

# Tail an agent's output
agent-relay agents:logs NAME -n 500

# Check channel conversation
mcporter call relaycast get_messages channel=my-project limit=20

# Check who's online
mcporter call relaycast list_agents status=online
```

## Lifecycle Management

```bash
# Kill a stuck agent
agent-relay agents:kill NAME

# Kill all agents in a team
agent-relay agents | grep TEAM | awk '{print $1}' | xargs -I{} agent-relay agents:kill {}

# Stop everything
agent-relay down
```

## Rate Limiting

- Add 15s gaps between sequential spawns to avoid Relaycast 429 errors
- Use unique agent names per run (append UUID suffix) to avoid 409 conflicts
- The SDK uses `registerOrRotate` pattern: on 409, rotates the agent token

## Common Patterns

### Sequential pipeline
Spawn agent A → wait for completion → spawn agent B with A's output.

### Parallel fan-out
Spawn N agents simultaneously, each on a subtask. Monitor via channel. Collect results.

### Architect → Builder → Tester
1. Spawn architect to design
2. Architect posts to channel when done
3. Spawn builder to implement architect's design
4. Builder posts when done
5. Spawn tester to validate

### Team with shared channel
All agents join same channel, post updates, read each other's work on a shared git branch.

## Gotchas

| Issue | Fix |
|-------|-----|
| Agents can't message | Broker must have `--workspace-key` |
| Droid stuck at approval | Don't use `--cwd` with droid agents |
| Agent name conflict (409) | Use unique names or let SDK `registerOrRotate` handle it |
| Channel not found | Create it first via `mcporter call relaycast create_channel` |
| Agent idle but no output | Check `agent-relay agents:logs NAME` for errors |
| npx setup fails in spawned agent | Agents inherit broker's workspace — no setup needed |
| `agent-relay send` fails for DM | Spawned agents can broadcast to channels but DMs may not work for non-Relaycast-registered agents |
