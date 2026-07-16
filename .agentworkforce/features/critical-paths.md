# Critical Paths

The features and sequences that must work for the product to function. These are the first things to verify after any change, and the last things to break.

---

## Path 1: Broker + Agent Registration (Foundation)

Everything depends on this. If it breaks, nothing works.

```
relay up
relay agent register <name>   → produces a token
relay agent list              → shows the registered agent
relay status                  → shows broker running with agent count
```

**What breaks if this fails:** All messaging, local agent orchestration, MCP tools, workflow execution.

---

## Path 2: Channel Messaging (Core Coordination Loop)

The primary way agents communicate.

```
relay up
relay agent register alice    → TOKEN_A
relay agent register bob      → TOKEN_B

# As alice:
AGENT_RELAY_TOKEN=<TOKEN_A> relay channel create team
AGENT_RELAY_TOKEN=<TOKEN_A> relay channel join team
AGENT_RELAY_TOKEN=<TOKEN_A> relay message post --channel team "hello from alice"

# Verify bob receives it:
AGENT_RELAY_TOKEN=<TOKEN_B> relay channel join team
AGENT_RELAY_TOKEN=<TOKEN_B> relay message list --channel team --limit 1
# → should show alice's message
```

**What breaks if this fails:** All multi-agent coordination, workflow communication, the entire product premise.

---

## Path 3: Local Agent Spawn + Message Injection

The mechanism for spawning real AI agents and injecting messages into them.

```
relay up
relay local agent spawn worker-1 --harness claude
relay local agent list          → shows worker-1 as active
relay local agent message hold worker-1
relay local agent message flush worker-1
relay local agent release worker-1
```

**What breaks if this fails:** All multi-agent orchestration workflows, the local workflow engine.

---

## Path 4: MCP Server Integration

The path used when an agent operates inside a harness (Claude Code, Cursor, etc.).

```
relay mcp                       → starts MCP server on stdio
# From a harness MCP call:
list_channels                   → returns channel list
post_message(channel, text)     → posts message
list_messages(channel)          → returns messages including the one just posted
```

**What breaks if this fails:** All usage from within harness tools (the primary user workflow for most users).

---

## Path 5: Workflow Execution (Local)

A workflow YAML or JS file drives multiple agents to complete a task.

```
relay up
relay local workflow run examples/basic-workflow.yaml
# → spawns agents, coordinates them, produces output, terminates cleanly
```

**What breaks if this fails:** The primary value proposition for multi-agent task execution.

---

## Path 6: Direct Messaging Between Agents

```
relay up
relay agent register orchestrator  → TOKEN_O
relay agent register worker        → TOKEN_W

AGENT_RELAY_TOKEN=<TOKEN_O> relay message dm send worker "your task"
AGENT_RELAY_TOKEN=<TOKEN_W> relay message dm list  → shows message from orchestrator
```

**What breaks if this fails:** Lead/worker orchestration patterns, any workflow that routes tasks via DM.

---

## Hot Paths (Sensitive, Frequently Touched)

These are not foundational but are exercised constantly and failures are immediately noticeable.

| Path | Risk | Code Area |
|------|------|-----------|
| PTY message injection timing | Race conditions in TMUX wrapper | crates/relay-pty/, packages/harness-driver/ |
| Dead letter queue + redeliver | Messages lost silently | crates/broker/src/queue.rs |
| Agent token auth validation | Auth bypass or silent rejection | crates/broker/src/auth.rs (or equivalent) |
| Message delivery ordering | Out-of-order delivery corrupts workflows | crates/broker/ |
| Hold/flush state machine | Stuck agents that never receive messages | crates/broker/, packages/cli/src/cli/commands/local-agent.ts |
| MCP tool schema validation | Tool calls rejected silently by harness | packages/cli/src/cli/mcp/ |

---

## What an Agent Should Check First

When unsure if the system is healthy, run this sequence in order:

```bash
relay version            # CLI is installed and not corrupt
relay status             # Broker state (running or not)
relay up                 # Start if not running
relay status             # Confirm running
relay agent list         # Workspace is reachable and has agents
relay message list --channel general --limit 1  # Messaging works end to end
```

If any step fails, diagnose before proceeding. The failure at each step points to a specific subsystem.
