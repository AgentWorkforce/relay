---
name: orchestrating-agent-relay
description: The canonical way to run agent-relay - self-bootstrap the broker and autonomously spawn, monitor, and coordinate a team of worker agents without human intervention. Covers infrastructure startup, agent spawning, lifecycle monitoring, CLI-first reading, and team coordination.
---

# Orchestrating Agent Relay

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

## Overview

A headless orchestrator is an agent that:

1. Starts the relay infrastructure itself (`agent-relay up`)
2. Spawns and manages worker agents
3. Monitors agent lifecycle events
4. Coordinates work without human intervention

The orchestrator drives the team **from outside** and is **not** a
registered relay agent, so it reads/sends/lists via the `agent-relay` CLI
(MCP `mcp__relaycast__message_*` tools require a registered identity). The
workers it spawns _are_ registered participants — their peer-messaging
reference is the **`using-agent-relay`** skill.

## When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

## Quick Reference

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

```text
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

> **The spawning orchestrator is not a registered relaycast agent.**
> The `mcp__relaycast__message_*` / `agent_list` MCP tools require a
> registered identity and fail for you with the error
> `Not registered. Call agent.register first.`
> Use the `agent-relay` CLI for all reading, sending, and listing, and add
> `--json` to any read command (`replies`, `history`, `who`) when you need
> full, untruncated, parseable output.

### Step 4: Release Workers

```text
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

**`agent-relay replies <agent>` is the canonical command for reading worker
DM replies** — it returns full text, sender-attributed, in chronological
order, with no truncation. Add `--json` for machine-readable output (full
text plus a `direction` field).

`inbox --agent <name>` is legacy unread-only behavior; once read, entries
disappear. Prefer `replies` for a persistent, complete view.

```bash
# WRONG — history (no flags) will not show DM replies from workers
agent-relay history

# RIGHT — read a worker's DM replies (full text, chronological)
agent-relay replies Worker1

# Machine-readable: full text + direction, safe to parse in a loop
agent-relay replies Worker1 --json

# Full DM conversation history with a worker (read + unread)
agent-relay history --to Worker1

# Channel evidence (diffs, grep counts, GO/NO-GO) — full text,
# untruncated, chronological; add --json to parse it programmatically
agent-relay history --to '#general' --json
```

```bash
# WRONG — MCP message tools require a registered agent identity; as the
# spawning orchestrator you are not registered and these return
# "Not registered. Call agent.register first."
mcp__relaycast__message_inbox_check()
mcp__relaycast__message_dm_list(as: "Worker1")

# RIGHT — read via the CLI; --json is the reliable substrate for
# substantive payloads
agent-relay replies Worker1 --json
```

### Spawning and Messaging

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

### Monitoring Workers (Essential)

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

```text
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

Read worker replies (DMs are not visible in plain `history`):
  agent-relay replies Worker1            # full text, chronological
  agent-relay replies Worker1 --json     # parseable: text + direction

Release when done:
  agent-relay release Worker1

## Protocol
- Workers will ACK when they receive tasks
- Workers will send DONE when complete
- **ACK/DONE target: `orchestrator` (the auto-registered spawning identity) or
  the `#general` channel — NEVER `broker`.** `broker` is the broker's internal
  routing self-name, not a spawnable or DM-able agent: `agent-relay send broker`
  and a worker DM to `broker` both fail with `Agent "broker" not found`. When
  you write a worker's task prompt, tell it to DM `orchestrator` (or post to
  `#general`) for ACK/PROGRESS/DONE — do not say "DM the broker".
- Use `agent-relay agents:logs <name>` to monitor progress
- Use `agent-relay replies <name>` to read a worker's DM replies (full text, chronological, persistent); add `--json` to parse
- Use `agent-relay history --to <name>` for the full DM conversation thread (read + unread)
- Use `agent-relay history --to '#general' --json` to see channel message flow
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

| Mistake                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-relay: command not found` or mise/asdf shim error                                                                                                           | Ensure Node is available first (`node --version`); if a shim is broken, fix the runtime manager, then install/use `agent-relay`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "Nested session" error                                                                                                                                             | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Broker not starting                                                                                                                                                | Try `agent-relay down` first, then `agent-relay up --no-dashboard --verbose` and `agent-relay status --wait-for=10`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Broker shows STARTING after `status --wait-for`                                                                                                                    | The process is alive but the broker API is not ready; inspect logs, retry readiness, or restart with `agent-relay down --force` if it remains stuck                                                                                                                                                                                                                                                                                                                                                                                                    |
| Broker shows STOPPED immediately after start                                                                                                                       | Check `ps aux \| grep agent-relay-broker` and `.agent-relay/connection.json`; if the process is alive but status is STOPPED, rerun status from the project root or pass `--state-dir`                                                                                                                                                                                                                                                                                                                                                                  |
| Worktree verification leaves git status dirty                                                                                                                      | Run `agent-relay down --force`, then remove generated `.agent-relay/` and `.mcp.json` from throwaway validation worktrees before committing                                                                                                                                                                                                                                                                                                                                                                                                            |
| Spawn fails with `internal reply dropped`                                                                                                                          | Broker likely is not fully ready yet; wait for readiness, then spawn one worker first                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Workers not connecting                                                                                                                                             | Ensure broker started; check `agent-relay who` and worker logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Not monitoring workers                                                                                                                                             | Use `agent-relay agents:logs <name>` frequently to track progress                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Workers seem stuck                                                                                                                                                 | Check logs with `agent-relay agents:logs <name>` for errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Messages not delivered                                                                                                                                             | Check `agent-relay history --to '#general' --json` for channel messages; use `agent-relay replies <name> --json` for DMs                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Worker replies not showing in history                                                                                                                              | Expected — plain `history` only shows channel posts. Use `agent-relay replies <name>` (full text, chronological) or `agent-relay history --to <name>` (full thread) to read DM replies                                                                                                                                                                                                                                                                                                                                                                 |
| Need to see unread DM content                                                                                                                                      | `inbox_check` / `inbox --agent` only return counts or clear on read, and the MCP `message_dm_list` tool requires a registered identity you don't have. Use `agent-relay replies <name> --json`                                                                                                                                                                                                                                                                                                                                                         |
| Re-reading already-read replies                                                                                                                                    | `agent-relay replies <name>` is a persistent view (not unread-only); use `--since <time>` to narrow, or `agent-relay history --to <name>` for the full thread                                                                                                                                                                                                                                                                                                                                                                                          |
| Sent to wrong destination                                                                                                                                          | `agent-relay send Worker1 "..."` = DM; `agent-relay send '#general' "..."` = channel broadcast. The `#` prefix is required for channels                                                                                                                                                                                                                                                                                                                                                                                                                |
| Worker DM to `broker` fails with `Agent "broker" not found`                                                                                                        | Expected — `broker` is the broker's internal routing self-name, not a DM-able agent. Workers must ACK/DONE to `orchestrator` or `#general`. Fix the worker task prompt; don't instruct "DM the broker"                                                                                                                                                                                                                                                                                                                                                 |
| `status` shows `RUNNING` / `Agents: N` but `who --json`, `send`, `replies`, `history` return `[]` or `Failed to query broker session` / `typo in the url or port?` | `status` reads the persisted state file; the others do a live RPC. The CLI is dialing a **stale/wrong broker** — usually a leftover `.agent-relay/connection.json` from a prior run pointing at an old port, or a second broker process. Run `ps aux \| grep -c '[a]gent-relay-broker'` (>1 ⇒ kill extras), check `.agent-relay/connection.json` vs the actual listening port, then `agent-relay down --force`, delete `.agent-relay/`, and `agent-relay up` clean. `agent-relay doctor` reports broker auth + connection health for exactly this case |
| `Invalid agent token` / auth failures from the orchestrator CLI while broker + workers keep working                                                                | The orchestrator's env has an **unresolved `${RELAY_API_KEY}`-style template** being used as a literal key (broker/workers hold their real tokens). Ensure `RELAY_API_KEY` is actually resolved in the orchestrator shell; verify with `agent-relay doctor`                                                                                                                                                                                                                                                                                            |

## Prerequisites

1. **agent-relay CLI installed** (required)

   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For MCP tools** (optional): Relaycast MCP server configured in Claude's MCP settings
