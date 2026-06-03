---
name: orchestrating-agent-relay
description: The canonical way to run agent-relay - self-bootstrap the broker and autonomously spawn, monitor, and coordinate a team of worker agents without human intervention. Covers infrastructure startup, agent spawning, lifecycle monitoring, CLI-first reading, and team coordination.
---

# Orchestrating Agent Relay

Self-bootstrap agent-relay infrastructure and manage a team of agents autonomously.

## Overview

A headless orchestrator is an agent that:

1. Starts the relay infrastructure itself (`agent-relay local up`)
2. Spawns and manages worker agents (`agent-relay local agent …`)
3. Monitors agent liveness via the broker (`agent-relay local agent list`) and reads worker replies through relay (`agent-relay message inbox check`)
4. Coordinates work without human intervention

The CLI has two surfaces, and the split is the thing to memorize:

- **`agent-relay local …`** — **lifecycle only**: start/stop the local broker
  and spawn/release/list the agents it runs. No token required; it talks to the
  local broker via `.agentworkforce/relay/connection.json`. **Never use it to
  read or send messages.**
- **`agent-relay message … / channel … / agent …`** — **all messaging goes
  through relay** (the Relaycast service at `gateway.relaycast.dev`). These are
  **token-gated** (`--token` / `RELAY_AGENT_TOKEN`). Register once for an agent
  token (see Step 3), then send and read every coordination message here — or
  use the equivalent relay MCP tools (`mcp__agent-relay__*`).

**Always go through relay for messaging — never contact the broker directly to
read worker output.** Worker ACKs, replies, and DONE signals arrive as relay
messages: read them with `agent-relay message inbox check` /
`message dm list <conversationId>`, not by tailing the broker. (`local tail` is
a low-level broker/TTY debugging aid only.)

The orchestrator drives the team **from outside** but is itself a registered
relay agent — that is what lets it message through relay. The workers it spawns
are registered participants too; their peer-messaging reference is the
**`using-agent-relay`** skill.

## When to Use

- Agent needs full control over its worker team
- No human available to run `agent-relay local up` manually
- Agent should manage agent lifecycle autonomously
- Building self-contained multi-agent systems

## Quick Reference

| Step                                    | Command/Tool                                                     |
| --------------------------------------- | ---------------------------------------------------------------- |
| Verify installation                     | `command -v agent-relay` or `npx agent-relay --version`          |
| Verify Node runtime if shim fails       | `node --version` or fix mise/asdf first                          |
| Start infrastructure                    | `agent-relay local up --no-dashboard --verbose`                  |
| Check broker readiness                  | `agent-relay local status --wait-for=10`                         |
| Spawn worker                            | `agent-relay local agent spawn claude --name Worker1 --task "…"` |
| List workers                            | `agent-relay local agent list`                                   |
| Resource usage                          | `agent-relay local metrics`                                      |
| Register for a messaging token          | `agent-relay agent register Lead` (sets up `RELAY_AGENT_TOKEN`)  |
| DM a worker (via relay)                 | `agent-relay message dm send Worker1 "…"`                        |
| Post to a channel (via relay)           | `agent-relay message post general "…"`                           |
| Read a worker's replies (via relay)     | `agent-relay message dm list <conversationId>`                   |
| Check inbox (via relay)                 | `agent-relay message inbox check`                                |
| Debug raw worker output (not messaging) | `agent-relay local tail --agent Worker1`                         |
| Release worker                          | `agent-relay local agent release Worker1`                        |
| Stop infrastructure                     | `agent-relay local down`                                         |

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
# Start the local broker in headless mode
agent-relay local up --no-dashboard --verbose
```

Verify broker readiness before spawning any workers:

```bash
# Polls until the broker reports RUNNING (or times out after 10s)
agent-relay local status --wait-for=10
```

The broker:

- Provisions a Relaycast workspace when none is configured
- Removes `CLAUDECODE` env var when spawning (fixes nested session error)
- Persists state to `.agentworkforce/relay/` (connection files, etc.)

When verifying from a source checkout or throwaway git worktree, run these
commands from the project/worktree root. The CLI writes runtime state to
`.agentworkforce/relay/` and may create `.mcp.json`; clean those files after
validation if the worktree should remain clean. Pass `--state-dir <dir>` to
relocate broker state.

### Step 2: Spawn Workers

```bash
# provider is positional; --name defaults to the provider; --channels defaults to "general"
agent-relay local agent spawn claude --name Worker1 --task "Implement the authentication module following the existing patterns"
```

MCP equivalent (works once the orchestrator is registered — see Step 3):

```text
mcp__agent-relay__add_agent(
  name: "Worker1",
  cli: "claude",
  task: "Implement the authentication module following the existing patterns"
)
```

### Step 3: Register, then Coordinate Through Relay

Register once for an agent token so every message — sent or read — goes through
relay:

```bash
# Prints a registration JSON that includes the agent token
agent-relay agent register Lead
# Copy the "token" value from the output:
export RELAY_AGENT_TOKEN=<token>
```

Now do **all** coordination through the `message` group (or the equivalent
`mcp__agent-relay__*` tools):

```bash
agent-relay message dm send Worker1 "Also add unit tests"   # targeted DM
agent-relay message post general "All workers: wrap up"      # channel broadcast (bare name, no #)
agent-relay message dm list <conversationId>                 # read a worker's replies
agent-relay message inbox check                              # unread across conversations
```

Track which workers are alive with the lifecycle command (not a messaging
channel):

```bash
agent-relay local agent list   # pid, status, uptime — JSON, ideal for polling
```

> **Read worker replies through relay, never from the broker.** ACKs, replies,
> and DONE signals are relay messages — read them with `message inbox check` /
> `message dm list`. Do not use `local tail` to "read" worker responses; it
> streams the broker's raw TTY output and is only a low-level debugging aid.
>
> **Messaging requires a registered agent identity.** The `message`, `channel`,
> and `dm` groups (and the `mcp__agent-relay__*` tools) reject unregistered
> callers with `Not registered. Call agent.register first.` Run
> `agent-relay agent register <name>` and set `RELAY_AGENT_TOKEN` (or pass
> `--token <token>` per call).

### Step 4: Release Workers

```bash
agent-relay local agent release Worker1
# MCP: mcp__agent-relay__remove_agent(name: "Worker1")
```

### Step 5: Shutdown (optional)

```bash
agent-relay local down
```

## CLI Commands for Orchestration

Two namespaces — keep the split straight.

### Local broker & agents — lifecycle only (no token)

Use these to start/stop the broker and manage the agent processes. **Not for
messaging** — never read or send messages here.

```bash
agent-relay local up [--no-dashboard] [--verbose] [--no-spawn] [--background] [--state-dir <dir>]
agent-relay local down [--force] [--all]
agent-relay local status [--wait-for <secs>]          # broker readiness
agent-relay local metrics [--agent <name>]            # resource usage
agent-relay local agent list                          # running agents (JSON)
agent-relay local agent spawn <provider> --name <name> --task "<task>" [--channels <c...>] [--model <m>]
agent-relay local agent new <provider> …              # spawn + attach to its TUI
agent-relay local agent release <name>                # graceful stop
agent-relay local agent set-model <name> <model>      # switch a running agent's model
agent-relay local agent attach <name> --mode view|drive|passthrough
agent-relay local tail [--agent <name>]               # raw broker/TTY output — DEBUG ONLY, not message reading
```

### Messaging & registry — always through relay (token-gated)

Every coordination message goes through relay here. All accept `--token <token>`
(or `RELAY_AGENT_TOKEN`), `--workspace-key`, and `--base-url`.

```bash
agent-relay agent register <name>                     # print an agent token, then export RELAY_AGENT_TOKEN
agent-relay agent list [--status <s>]                 # workspace agent registry

agent-relay message post <channel> <text>             # channel broadcast (bare channel name)
agent-relay message list <channel> [--limit <n>]      # channel history
agent-relay message dm send <agent> <text>            # DM a worker
agent-relay message dm list <conversationId> [--limit <n>]   # read a DM thread
agent-relay message dm send_group <text>              # group DM
agent-relay message reply <messageId> <text>          # threaded reply
agent-relay message get_thread <messageId>            # full thread
agent-relay message search <query> [--channel <c>] [--from <agent>] [--limit <n>]
agent-relay message inbox check [--limit <n>]         # unread messages
agent-relay message inbox mark_read <messageId>
agent-relay message reaction add|remove <messageId> <emoji>

agent-relay channel create|list|join|leave|invite|set_topic|archive …
```

### Channel vs DM — When to Use Each

**DM** — targeted, private, for responses you need to read back:

- `agent-relay message dm send Worker1 "message"` — sends a DM to Worker1
- `mcp__agent-relay__send_dm(to: "Worker1", text: "...")` — same via MCP
- Read a worker's thread with `agent-relay message dm list <conversationId>`

**Channel post** — broadcast, visible to all agents on that channel:

- `agent-relay message post general "message"` — posts to the `general` channel
  (bare name — no `#` prefix in the new `message post` command)
- `mcp__agent-relay__post_message(channel: "general", text: "...")` — same via MCP
- Use for coordination messages, status updates, announcements

### Monitoring Workers (Essential)

Read worker progress and replies **through relay**; use the broker only for
liveness/health.

```bash
# Worker replies, ACKs, DONE signals — read these through relay
agent-relay message inbox check                  # unread across conversations
agent-relay message dm list <conversationId>     # a specific worker's thread

# Liveness/health only (lifecycle, not messaging)
agent-relay local agent list                     # running agents (pid, status, uptime)
agent-relay local metrics                         # resource usage

# Last resort: raw broker/TTY output for debugging a wedged worker.
# This is NOT how you read a worker's messages.
agent-relay local tail --agent Worker1
```

### Troubleshooting

```bash
# Gracefully stop an unresponsive worker
agent-relay local agent release Worker1

# Reset the broker if it is wedged
agent-relay local down --force

# Re-check broker status
agent-relay local status

# If a worker looks stuck, inspect its output first
agent-relay local tail --agent Worker1
```

**Tip:** Read worker progress through relay (`agent-relay message inbox check`)
and poll `agent-relay local agent list` for liveness. Reach for
`agent-relay local tail` only to debug a wedged worker's raw output.

## Orchestrator Instructions Template

Give your lead agent these instructions:

```text
You are an autonomous orchestrator. Bootstrap the relay infrastructure and manage a team of workers.

## Step 1: Verify Installation
Run: command -v agent-relay || npx agent-relay --version
If you hit a mise/asdf shim error: verify Node first with `node --version`, then fix the runtime manager
If not found: npm install -g agent-relay

## Step 2: Start Infrastructure
Run: agent-relay local up --no-dashboard --verbose
Verify: agent-relay local status --wait-for=10 (should report RUNNING)

## Step 3: Manage Your Team

Spawn workers (provider is positional, --name/--task are flags):
  agent-relay local agent spawn claude --name Worker1 --task "Task description"

Register once so all messaging goes through relay:
  agent-relay agent register Lead         # prints a token
  export RELAY_AGENT_TOKEN=<token>

Coordinate ENTIRELY through relay (send and read every message here):
  agent-relay message dm send Worker1 "Additional instructions"   # targeted DM
  agent-relay message post general "All workers: prioritize auth"  # broadcast
  agent-relay message dm list <conversationId>                     # read a worker's replies
  agent-relay message inbox check                                  # unread across conversations

Check liveness only (lifecycle, not messaging):
  agent-relay local agent list            # running workers + status

Release when done:
  agent-relay local agent release Worker1

## Protocol
- Workers ACK when they receive tasks and send DONE when complete — both arrive as relay messages
- Read replies through relay: `agent-relay message inbox check` / `message dm list <conversationId>` (requires RELAY_AGENT_TOKEN)
- NEVER read worker responses with `agent-relay local tail` — that is broker-direct raw output, not relay messaging (use it only to debug a wedged worker)
- Poll `agent-relay local agent list` for liveness; do all messaging through the `message`/`channel` groups
```

## Lifecycle Events

The broker emits these events (available via SDK subscriptions and
`agent-relay local tail`):

| Event                    | When                        |
| ------------------------ | --------------------------- |
| `agent_spawned`          | Worker process started      |
| `worker_ready`           | Worker connected to relay   |
| `agent_idle`             | Worker waiting for messages |
| `agent_exited`           | Worker process ended        |
| `agent_permanently_dead` | Worker failed after retries |

## Common Mistakes

| Mistake                                                  | Fix                                                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Using old top-level verbs (`up`, `spawn`, `who`, `send`) | They moved under `local`/`message`. Use `agent-relay local up`, `local agent spawn`, `local agent list`, `message dm send` / `message post`                     |
| `agent-relay: command not found` or mise/asdf shim error | Ensure Node is available first (`node --version`); if a shim is broken, fix the runtime manager, then install/use `agent-relay`                                 |
| "Nested session" error                                   | Broker handles this automatically; if running manually, unset `CLAUDECODE` env var                                                                              |
| Broker not starting                                      | Try `agent-relay local down` first, then `agent-relay local up --no-dashboard --verbose` and `agent-relay local status --wait-for=10`                           |
| Broker stuck in STARTING after `status --wait-for`       | The process is alive but the broker API is not ready; inspect output via `local tail`, retry readiness, or `agent-relay local down --force` if wedged           |
| Broker shows STOPPED immediately after start             | Check `ps aux \| grep agent-relay-broker` and `.agentworkforce/relay/connection.json`; rerun status from the project root or pass `--state-dir`                 |
| Worktree verification leaves git status dirty            | Run `agent-relay local down --force`, then remove generated `.agentworkforce/relay/` and `.mcp.json` from throwaway validation worktrees before committing      |
| `Not registered. Call agent.register first.`             | `message`/`channel`/`dm` are token-gated. Run `agent-relay agent register <name>` and set `RELAY_AGENT_TOKEN` (or pass `--token`). The `local` group is exempt  |
| Spawn fails with `internal reply dropped`                | Broker likely is not fully ready yet; wait for readiness, then spawn one worker first                                                                           |
| Workers not connecting                                   | Ensure broker started; check `agent-relay local agent list`, then `agent-relay local tail --agent <name>` to debug raw output                                   |
| Reading worker replies with `local tail` / broker output | Messages go through relay — read them with `agent-relay message inbox check` / `message dm list <conversationId>`. `local tail` is raw broker output, not relay |
| Sending a message via a `local` command                  | The `local` group is lifecycle only and cannot message. Send through relay: `agent-relay message dm send` / `message post`                                      |
| Not monitoring workers                                   | Poll `agent-relay local agent list` for liveness and read replies via `agent-relay message inbox check`                                                         |
| Posting to a channel with a `#` prefix                   | `message post` takes a bare channel name (`general`, not `#general`)                                                                                            |
| Sent to wrong destination                                | `agent-relay message dm send Worker1 "..."` = DM; `agent-relay message post general "..."` = channel broadcast                                                  |

## Prerequisites

1. **agent-relay CLI installed** (required)

   ```bash
   npm install -g agent-relay
   # Or use npx without installing: npx agent-relay <command>
   ```

2. **For spawning Claude agents**: Valid Anthropic credentials
   - Set `ANTHROPIC_API_KEY` or authenticate via `claude auth login`

3. **For coordination messaging**: a registered agent token
   - Run `agent-relay agent register <name>` and export `RELAY_AGENT_TOKEN`
     (or pass `--token` on each `message`/`channel` call)

4. **For MCP tools** (optional): Relaycast MCP server configured in Claude's MCP
   settings (the message tools need the same registered identity as the CLI)
