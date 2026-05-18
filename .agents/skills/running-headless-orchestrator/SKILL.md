---
name: running-headless-orchestrator
description: Use when an agent needs to self-bootstrap agent-relay and autonomously manage a team of workers - covers infrastructure startup, agent spawning, lifecycle monitoring, and team coordination without human intervention
---

### Overview

A headless orchestrator is an agent that:

1. Starts the relay infrastructure itself (`agent-relay up`)
2. Spawns and manages worker agents
3. Monitors agent lifecycle events
4. Coordinates work without human intervention

### When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

### Quick Reference

| Step                               | Command/Tool                                            |
| ---------------------------------- | ------------------------------------------------------- |
| Verify installation                | `command -v agent-relay` or `npx agent-relay --version` |
| Verify Node runtime if shim fails  | `node --version` or fix mise/asdf first                 |
| Start infrastructure               | `agent-relay up --no-dashboard --verbose`               |
| Check status                       | `agent-relay status --wait-for=10`                      |
| Spawn worker                       | `agent-relay spawn Worker1 claude "task"`               |
| List workers                       | `agent-relay who`                                       |
| View worker logs                   | `agent-relay agents:logs Worker1`                       |
| Send DM to worker                  | `agent-relay send Worker1 "message"`                    |
| Post to channel                    | `agent-relay send '#general' "message"`                 |
| Read worker DM replies (full text) | `agent-relay replies Worker1` (add `--json` to parse)   |
| Read full DM conversation history  | `agent-relay history --to Worker1`                      |
| Release worker                     | `agent-relay release Worker1`                           |
| Stop infrastructure                | `agent-relay down`                                      |

### Bootstrap Flow

#### Step 0: Verify Installation

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

#### Step 1: Start Infrastructure

```bash
# Starts a detached broker in headless mode and returns after API readiness
agent-relay up --no-dashboard --verbose
```

#### Step 2: Spawn Workers via MCP

```
mcp__relaycast__agent_add(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

#### Step 3: Monitor and Coordinate

```bash
# Read Worker1's DM replies (chronological, full text, untruncated)
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

#### Step 4: Release Workers

```
mcp__relaycast__agent_remove(name: "Worker1")
```

#### Step 5: Shutdown (optional)

```bash
agent-relay down
```

### CLI Commands for Orchestration

#### Channel vs DM — When to Use Each

```bash
# WRONG — history (no flags) will not show DM replies from workers
agent-relay history

# RIGHT — read a worker's DM replies (full text, chronological, untruncated)
agent-relay replies Worker1

# Machine-readable: full text + direction, safe to parse in a loop
agent-relay replies Worker1 --json

# Full DM conversation history with a worker (read + unread)
agent-relay history --to Worker1

# Channel evidence (diffs, grep counts, GO/NO-GO) — full text,
# untruncated, chronological; add --json to parse it programmatically
agent-relay history --to '#general' --json
```

> **The spawning orchestrator is not a registered relaycast agent.** The
> `mcp__relaycast__message_*` / `agent_list` MCP tools fail for you with
> `Not registered. Call agent.register first.` Read, send, and list via
> the `agent-relay` CLI; add `--json` for full, untruncated, parseable
> output. `inbox --agent` is legacy unread-only — prefer `replies`.

#### Spawning and Messaging

```bash
# Spawn a worker
agent-relay spawn Worker1 claude "Implement auth module"

# Send a DM to a specific worker (replies readable via `replies`)
agent-relay send Worker1 "Add unit tests too"

# Broadcast to all workers via channel
agent-relay send '#general' "Team: wrap up and report status"

# Read Worker1's DM reply
agent-relay replies Worker1

# Release when done
agent-relay release Worker1
```

#### Monitoring Workers (Essential)

```bash
# Show currently active agents (structured: pid, uptimeSecs, memoryBytes,
# status) — poll this instead of scraping the worker TTY for health
agent-relay who --json

# View real-time output from a worker (critical for debugging)
agent-relay agents:logs Worker1

# Read DM replies from a specific worker (use --json to parse safely)
agent-relay replies Worker1 --json

# View channel message history (channel posts only — not DMs)
agent-relay history --to '#general' --json

# Check overall system status
agent-relay status
```

#### Troubleshooting

```bash
# Kill unresponsive worker
agent-relay agents:kill Worker1

# Re-check broker status
agent-relay status

# If a worker looks stuck, inspect its logs first
agent-relay agents:logs Worker1
```

### Orchestrator Instructions Template

#### Give your lead agent these instructions:

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
- Use `agent-relay replies <name> --unread --mark-read` only when you want read-state filtering
- Use `agent-relay history --to <name>` to re-read the full DM conversation (read + unread)
- Use `agent-relay history --to '#general'` to see channel message flow
```

### Lifecycle Events

The broker emits these events (available via SDK subscriptions):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

### Common Mistakes

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

### Overview

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

### Prerequisites

#### 1. **agent-relay CLI installed** (required)

```bash
npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
```
