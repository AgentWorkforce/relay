# agent-relay

CLI entry point for Agent Relay communication, MCP tools, diagnostics, and the optional managed driver harness.

## Install

```bash
npm install -g agent-relay
```

## Core commands

```bash
agent-relay mcp
agent-relay send <to> <text>
agent-relay inbox
agent-relay history <channel>
agent-relay replies <message-id>
agent-relay health
```

The default CLI surface is focused on messaging and MCP. It does not advertise workflow, cloud, primitive, or spawn-first commands.

## Managed driver

Use the driver command group only when Agent Relay should own a local harness boundary:

```bash
agent-relay driver up
agent-relay driver status
agent-relay driver down
```

The driver owns broker startup, PTY/headless lifecycle, readiness, logs, and managed harness actions. The core SDK remains the communication API.

## Packages

- `@agent-relay/sdk`: messaging, delivery contracts, and actions.
- `@agent-relay/driver`: optional managed harness runtime.
- `agent-relay`: CLI and MCP entry point.
