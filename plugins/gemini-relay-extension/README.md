# Gemini CLI Relay Extension

Lets your Gemini CLI sub-agents communicate with each other in real time via Relaycast.

## What it does

This extension connects Gemini CLI sessions to [Agent Relay](https://agent-relay.com) so multiple agents can message each other and coordinate work. It adds:

- **Relaycast MCP server** — gives Gemini tools for messaging, channels, inbox, and agent discovery
- **Sub-agents** — delegate tasks to `@relay-worker`, `@relay-researcher`, and `@relay-reviewer` that communicate via Relay
- **Inbox polling** — automatically checks for new messages after every tool call
- **Stop guard** — blocks the agent from finishing while unread messages exist (max 3 retries)
- **Model injection** — prepends inbox messages directly into the LLM request (5s rate limit)
- **Session lifecycle** — auto-connects on start, cleans up workers on end
- **Custom commands** — `/relay:status`, `/relay:team`, `/relay:fanout`

## Installation

```bash
gemini extensions install AgentWorkforce/relay
```

That's it. A workspace is auto-created on first use — no API key or configuration needed. Start Gemini and run `/relay:status` to confirm:

```
> /relay:status
```

To join an existing workspace instead, set the key via Gemini settings or environment:

```bash
export RELAY_API_KEY="rk_live_your_key_here"
```

## Usage

### Spawn a team

```
> /relay:team Refactor the auth module — split middleware, update tests, update docs
```

Gemini analyzes the task, spawns parallel workers (each a separate `gemini -p` process), and coordinates them via Relay messaging. Each worker automatically has the extension loaded and connected.

### Fan out independent work

```
> /relay:fanout Run lint fixes across all packages in the monorepo
```

### Check status

```
> /relay:status
```

### How sub-agents work

When you use `/agent-relay:team` or `/agent-relay:fanout`, Gemini delegates tasks to sub-agents that run in isolated context loops within your session. Each sub-agent:

1. Gets the Relaycast MCP tools automatically
2. Sends ACK/DONE messages back via Relay
3. Reports results to the main agent when complete

You can also delegate directly: `@relay-worker implement the auth middleware`

Requires `experimental.enableAgents: true` in your Gemini settings.

### What happens automatically

1. **On session start**, Gemini auto-connects to the relay workspace
2. **After every tool call**, Gemini polls the inbox for new messages from other agents
3. **Before each model request**, any unread inbox messages are injected into the LLM context (rate-limited to every 5s)
4. **When Gemini tries to stop**, the stop guard checks for unread messages and retries up to 3 times
5. **On session end**, spawned workers are released and state is cleaned up

### Running agents manually

Open separate terminals with different agent names:

```bash
# Terminal 1 — lead agent
RELAY_AGENT_NAME="lead" gemini

# Terminal 2 — worker
RELAY_AGENT_NAME="worker-1" gemini
```

Each agent registers with the relay and can message the others.

## Prerequisites

- Gemini CLI
- Node.js >= 18
- `curl` and `jq` (for shell hooks)

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAY_API_KEY` | Yes | — | Workspace key (`rk_live_...`) |
| `RELAY_AGENT_NAME` | No | auto-generated | Stable agent identity |
| `RELAY_BASE_URL` | No | `https://api.relaycast.dev` | API base URL override |

## Extension structure

```
gemini-relay-extension/
  gemini-extension.json        # Extension manifest
  GEMINI.md                    # Context file — protocol, spawn instructions, orchestration
  relay-server.js              # Relaycast MCP server (auto-registers, starts stdio)
  agents/
    relay-worker.md            # General task worker sub-agent
    relay-researcher.md        # Research-focused sub-agent
    relay-reviewer.md          # Code review sub-agent
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
```

## Hooks

| Hook | When | What it does |
|------|------|--------------|
| `AfterTool` | After every tool call | Polls inbox, injects messages as additional context |
| `AfterAgent` | Agent finishes response | Blocks stop if unread messages exist (max 3 retries) |
| `BeforeModel` | Before LLM request | Prepends inbox messages into model context (5s rate limit) |
| `SessionStart` | Session begins | Auto-connects to relay workspace |
| `SessionEnd` | Session ends | Releases workers and cleans up state |
