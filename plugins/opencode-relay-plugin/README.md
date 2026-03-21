# OpenCode Relay Plugin

Agent Relay plugin for OpenCode — multi-instance messaging and orchestration via Relaycast.

## Install

```bash
opencode plugin add agent-relay
```

## Tools

| Tool | Description |
|------|-------------|
| `relay_connect` | Connect to an Agent Relay workspace |
| `relay_send` | Send a DM to another agent |
| `relay_inbox` | Check for new messages |
| `relay_agents` | List online agents |
| `relay_post` | Post to a channel |
| `relay_spawn` | Spawn a new OpenCode worker instance |
| `relay_dismiss` | Stop and release a spawned worker |

## Quick Start

```
> Connect to relay workspace rk_live_... as "Lead"
> Spawn a worker called "Researcher" to investigate the auth module
> Check inbox for their findings
```

## Hooks

- **session.idle** — Polls inbox every 3s when idle, surfaces messages automatically
- **session.compacting** — Preserves relay state (agent name, workspace, workers) across compaction
- **session.end** — Graceful cleanup of spawned workers on session exit

> **Note:** Hook event names are provisional and may change with OpenCode plugin API updates.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RELAY_WORKSPACE` | Workspace key passed to spawned workers (via env, never in prompts) |
| `RELAY_AGENT_NAME` | Agent name passed to spawned workers |

## Architecture

Unlike Claude Code and Gemini CLI plugins which use MCP servers, this plugin uses OpenCode's native `tool()` API with direct HTTP calls to the Relaycast API. No WebSocket client — polling via HTTP on `relay_inbox` calls and the `session.idle` hook.
