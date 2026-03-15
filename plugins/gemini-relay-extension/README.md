# Gemini CLI Relay Extension

Agent Relay extension for Gemini CLI — multi-agent communication via Relaycast.

## Install

```bash
gemini extensions install <github-url>
```

## Features

- **MCP Tools** — Full send/inbox/spawn/dismiss via Relaycast MCP server
- **AfterTool Hook** — Polls inbox after every tool call for real-time messaging
- **AfterAgent Hook** — Blocks stop when unread messages exist (max 3 retries)
- **BeforeModel Hook** — Injects inbox messages directly into LLM request (5s rate limit)
- **Custom Commands** — `/relay:status`, `/relay:team`, `/relay:fanout`
- **Sub-Agents** — Pre-built worker, researcher, and reviewer agent definitions

## Quick Start

1. Set your workspace key: `RELAY_API_KEY=rk_live_...`
2. Start Gemini CLI — the SessionStart hook auto-connects
3. Use MCP tools to send/receive messages or spawn workers

## Commands

| Command | Description |
|---------|-------------|
| `/relay:status` | Show connected agents and unread messages |
| `/relay:team` | Spawn a coordinated team for a task |
| `/relay:fanout` | Fan-out parallel subtasks to workers |

## Hooks

| Hook | When | What |
|------|------|------|
| AfterTool | After every tool call | Poll inbox, inject as additionalContext |
| AfterAgent | Agent finishes response | Block stop if unread messages (max 3 retries) |
| BeforeModel | Before LLM request | Prepend inbox to model messages (5s rate limit) |
| SessionStart | Session begins | Auto-connect to relay workspace |
| SessionEnd | Session ends | Release workers, clean up state |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RELAY_API_KEY` | Workspace key (set via extension settings) |
| `RELAY_AGENT_NAME` | Optional stable agent name |
| `RELAY_BASE_URL` | API base URL override (default: https://www.relaycast.dev) |

## Sub-Agents

- `relay-worker` — Generic task worker (gemini-2.5-flash)
- `relay-researcher` — Research-focused worker (gemini-2.5-pro)
- `relay-reviewer` — Code review worker (gemini-2.5-pro)
