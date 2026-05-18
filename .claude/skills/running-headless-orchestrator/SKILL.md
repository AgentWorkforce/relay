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
| Check status                      | `agent-relay status --wait-for=10`                      |
| Spawn worker                      | `agent-relay spawn Worker1 claude "task"`               |
| List workers                      | `agent-relay who`                                       |
| View worker logs                  | `agent-relay agents:logs Worker1`                       |
| Send DM to worker                 | `agent-relay send Worker1 "message"`                    |
| Post to channel                   | `agent-relay send '#general' "message"`                 |
| Read worker DM replies            | `agent-relay replies Worker1`                           |
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

```bash
# Starts a detached broker in headless mode and returns after API readiness
agent-relay up --no-dashboard --verbose
```

Verify broker readiness before spawning any workers:

```bash
# Must show "RUNNING" before you spawn workers
agent-relay status --wait-for=10
```

When verifying from a source checkout or throwaway git worktree, run these
commands from the project/worktree root. The CLI writes runtime state to
`.agent-relay/` and may create `.mcp.json`; clean those files after validation
if the worktree should remain clean.

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

```bash
# Read Worker1's DM replies with full content (chronological, untruncated)
agent-relay replies Worker1

# Machine-readable: full text + direction, safe to parse in a loop
agent-relay replies Worker1 --json

# Send a targeted DM to a specific worker
agent-relay send Worker1 "Also add unit tests"

# Broadcast to all agents on a channel
agent-relay send '#general' "All workers: wrap up current task"

# List active workers (structured status for polling)
agent-relay who --json
```

> **The spawning orchestrator is not a registered relaycast agent.** The
> `mcp__relaycast__message_*` / `agent_list` MCP tools require a registered
> identity and will fail for you with `Not registered. Call agent.register
first.` Use the `agent-relay` CLI for all reading, sending, and listing.
> Add `--json` to any read command (`replies`, `history`, `inbox`, `who`)
> when you need full, untruncated, parseable output.

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

`agent-relay replies <agent>` is the canonical command for reading worker DM replies; it returns full text in chronological order.

```bash
# Read a worker's DM replies
agent-relay replies Worker1

# Equivalent full DM conversation history for the no --unread case
agent-relay history --to Worker1

# Read only the thread between two specific agents
agent-relay history --to Worker1 --from Orchestrator
```

```bash
# WRONG — MCP message tools require a registered agent identity; as the
# spawning orchestrator you are not registered and these return
# "Not registered. Call agent.register first."
mcp__relaycast__message_inbox_check()
mcp__relaycast__message_dm_list(as: "Worker1")

# RIGHT — read via the CLI. --json gives full untruncated text plus the
# `direction` field, which is the reliable substrate for substantive
# payloads (diffs, grep counts, GO/NO-GO reasoning).
agent-relay replies Worker1 --json
```

### Detecting task completion

Poll worker replies with `replies --since` and exit when an inbound completion sentinel matches. Filtering `--json` output on `direction == "inbound"` prevents false positives from the orchestrator's own outbound DMs.

```bash
worker="Worker1"
sentinel='done|completed|finished|failed'

while true; do
  match=$(
    agent-relay replies "$worker" --since 30s --json |
      jq -r '.[] | select(.direction == "inbound") | .text' |
      grep -Eim1 "$sentinel" || true
  )

  if [ -n "$match" ]; then
    printf 'Matched completion reply from %s: %s\n' "$worker" "$match"
    break
  fi

  sleep 5
done
```

Adjust the sentinel pattern for your workflow; this is a polling recipe, not a separate CLI subcommand.

### Spawning and Messaging

```bash
# Spawn a worker
agent-relay spawn Worker1 claude "Implement auth module"

# Send a DM to a specific worker (replies readable via replies)
agent-relay send Worker1 "Add unit tests too"

# Broadcast to all workers via channel
agent-relay send '#general' "Team: wrap up and report status"

# Read Worker1's DM reply
agent-relay replies Worker1

# Release when done
agent-relay release Worker1
```

### Monitoring Workers (Essential)

```bash
# Show currently active agents (structured: pid, uptimeSecs, memoryBytes,
# status) — poll this instead of scraping the worker TTY for health
agent-relay who --json

# View real-time output from a worker (critical for debugging)
agent-relay agents:logs Worker1

# Read DM replies from a specific worker (use --json to parse safely)
agent-relay replies Worker1 --json

# View channel message history (channel posts only — not DMs).
# Channel evidence (diffs, grep counts, GO/NO-GO) is full-text and
# untruncated; use --json when you need to parse it programmatically.
agent-relay history --to '#general' --json

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
Verify: agent-relay status --wait-for=10 (should show "RUNNING")

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

Read worker DM replies (full text, sender-attributed):
  agent-relay replies Worker1

Release when done:
  agent-relay release Worker1

## Protocol
- Workers will ACK when they receive tasks
- Workers will send DONE when complete
- Use `agent-relay agents:logs <name>` to monitor progress
- Prefer `agent-relay replies <name>` for worker DM replies
- Use `agent-relay history --to '#general'` for channel message flow
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

| Mistake                                                    | Fix                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-relay: command not found` or mise/asdf shim error   | Ensure Node is available first (`node --version`); if a shim is broken, fix the runtime manager, then install/use `agent-relay`                                                  |
| "Nested session" error                                     | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var                                                                                               |
| Broker not starting                                        | Try `agent-relay down` first, then `agent-relay up --no-dashboard --verbose` and `agent-relay status --wait-for=10`                                                              |
| Broker shows STARTING after `status --wait-for`            | The process is alive but the broker API is not ready; inspect logs, retry readiness, or restart with `agent-relay down --force` if it remains stuck                              |
| Broker shows STOPPED immediately after start               | Check `pgrep -fl agent-relay-broker` and `.agent-relay/connection.json`; if the process is alive but status is STOPPED, rerun status from the project root or pass `--state-dir` |
| Worktree verification leaves git status dirty              | Run `agent-relay down --force`, then remove generated `.agent-relay/` and `.mcp.json` from throwaway validation worktrees before committing                                      |
| Spawn fails with `internal reply dropped`                  | Broker likely is not fully ready yet; wait for readiness, then spawn one worker first                                                                                            |
| Workers not connecting                                     | Ensure broker started; check `agent-relay who` and worker logs                                                                                                                   |
| Not monitoring workers                                     | Use `agent-relay agents:logs <name>` frequently to track progress                                                                                                                |
| Workers seem stuck                                         | Check logs with `agent-relay agents:logs <name>` for errors                                                                                                                      |
| Messages not delivered                                     | Check `agent-relay history --to '#general'` for channel messages; use `agent-relay replies <name>` for DMs                                                                       |
| `inbox_check` shows unread but can't see content           | `inbox_check` only returns counts. Use `agent-relay replies <name>` or `mcp__relaycast__message_dm_list(as: "<name>")` to list conversations with content                        |
| `inbox --agent` showed messages once but now shows nothing | `inbox --agent` is legacy unread-only behavior. Use `agent-relay replies <name>` for a persistent view; use `--unread` and `--mark-read` only when you want read-state filtering |
| Sent to wrong destination                                  | `agent-relay send Worker1 "..."` = DM; `agent-relay send '#general' "..."` = channel broadcast. The `#` prefix is required for channels                                          |

## Prerequisites

1. **agent-relay CLI installed** (required)

   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For MCP tools** (optional): Relaycast MCP server configured in Claude's MCP settings
