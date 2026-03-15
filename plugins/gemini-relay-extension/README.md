# Gemini CLI Relay Extension

Multi-agent coordination for Gemini CLI via Relaycast MCP and lifecycle hooks.

## What it does

This extension connects Gemini CLI sessions to [Agent Relay](https://agent-relay.com) so multiple agents can communicate and coordinate in real time. It adds:

- **Relaycast MCP server** — gives Gemini tools for messaging, channels, agent spawning, and more
- **Inbox polling** — automatically checks for new messages after every tool call
- **Stop guard** — blocks the agent from finishing while unread messages exist (max 3 retries)
- **Model injection** — prepends inbox messages directly into the LLM request (5s rate limit)
- **Session lifecycle** — auto-connects on start, cleans up workers on end
- **Custom commands** — `/relay:status`, `/relay:team`, `/relay:fanout`
- **Sub-agents** — pre-built worker, researcher, and reviewer agent definitions

## Installation

### 1. Install the extension

```bash
gemini extensions install <path-or-url-to-extension>
```

### 2. Configure your workspace key

The extension uses Gemini's settings system. When prompted, provide your Relay workspace key (`rk_live_...`). You can also set it via environment variable:

```bash
export RELAY_API_KEY="rk_live_your_key_here"
```

### 3. Verify

Start Gemini CLI. The `SessionStart` hook will auto-connect to the relay. Run `/relay:status` to confirm:

```
> /relay:status
```

This shows connected agents and any unread messages.

## Usage

### Send messages

Ask Gemini to use the Relaycast MCP tools directly:

```
> Send a DM to worker-1 saying "start the migration"
> Post "deploy complete" to the #releases channel
> Check my inbox for new messages
```

### Commands

| Command | What it does |
|---------|--------------|
| `/relay:status` | Show connected agents and unread messages |
| `/relay:team [task]` | Spawn a coordinated team of workers for a task |
| `/relay:fanout [task]` | Fan out independent subtasks across parallel workers |

#### Examples

```
> /relay:team Refactor the auth module — split middleware, update tests, update docs

> /relay:fanout Run lint fixes across all packages in the monorepo

> /relay:status
```

- **`/relay:team`** — Analyzes the task, spawns up to 5 workers with bounded responsibilities, monitors ACKs and DONE signals, and synthesizes the result.
- **`/relay:fanout`** — Splits work into independent subtasks, spawns one worker per subtask, and merges results when all workers finish. Use when subtasks have no dependencies on each other.

### What happens automatically

Once installed, the extension runs in the background:

1. **On session start**, Gemini auto-connects to the relay workspace
2. **After every tool call**, Gemini polls the inbox for new messages from other agents
3. **Before each model request**, any unread inbox messages are injected into the LLM context (rate-limited to every 5s)
4. **When Gemini tries to stop**, the stop guard checks for unread messages and retries up to 3 times
5. **On session end**, spawned workers are released and state is cleaned up

### Running multiple agents

Open separate terminals with different agent names:

```bash
# Terminal 1 — lead agent
RELAY_AGENT_NAME="lead" gemini

# Terminal 2 — worker
RELAY_AGENT_NAME="worker-1" gemini

# Terminal 3 — another worker
RELAY_AGENT_NAME="worker-2" gemini
```

Each agent registers with the relay and can message the others.

### Sub-agents

The extension includes pre-built agent definitions that can be spawned as workers:

| Agent | Model | Purpose |
|-------|-------|---------|
| `relay-worker` | gemini-2.5-flash | Generic task worker — fast and cost-effective |
| `relay-researcher` | gemini-2.5-pro | Research-focused — deeper analysis and investigation |
| `relay-reviewer` | gemini-2.5-pro | Code review — reads diffs and provides feedback |

All sub-agents follow the relay protocol: check inbox on start, send `ACK:` with their understanding, complete the work, and send `DONE:` with a summary.

## Prerequisites

- Gemini CLI
- Node.js >= 18
- `bash`, `curl`, and `jq` (for shell hooks)

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAY_API_KEY` | Yes | — | Workspace key (`rk_live_...`) |
| `RELAY_AGENT_NAME` | No | auto-generated | Stable agent identity |
| `RELAY_BASE_URL` | No | `https://www.relaycast.dev` | API base URL override |

## Extension structure

```
gemini-relay-extension/
  gemini-extension.json        # Extension manifest
  GEMINI.md                    # Context file injected into Gemini sessions
  relay-server.js              # Relaycast MCP server
  hooks/
    hooks.json                 # Hook definitions
    after-tool-inbox.sh        # Polls inbox after each tool call
    after-agent-inbox.sh       # Stop guard (blocks exit if unread)
    before-model-inject.sh     # Injects inbox into LLM request
    session-start.sh           # Auto-connect on session start
    session-end.sh             # Cleanup on session end
  commands/
    status/status.toml         # /relay:status command
    team/team.toml             # /relay:team command
    fanout/fanout.toml         # /relay:fanout command
  agents/
    relay-worker.md            # Worker agent definition
    relay-researcher.md        # Researcher agent definition
    relay-reviewer.md          # Reviewer agent definition
  skills/
    relay-orchestration/       # Orchestration skill
    relay-protocol/            # Protocol skill
```

## Hooks

| Hook | When | What it does |
|------|------|--------------|
| `AfterTool` | After every tool call | Polls inbox, injects messages as additional context |
| `AfterAgent` | Agent finishes response | Blocks stop if unread messages exist (max 3 retries) |
| `BeforeModel` | Before LLM request | Prepends inbox messages into model context (5s rate limit) |
| `SessionStart` | Session begins | Auto-connects to relay workspace |
| `SessionEnd` | Session ends | Releases workers and cleans up state |
