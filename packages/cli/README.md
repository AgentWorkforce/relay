# agent-relay

A thin operator console for a local agent workforce: stand up the broker, staff it with off-the-shelf agent CLIs, and watch/steer them from the terminal. Each command is a shallow wrapper over a backing package (`@agent-relay/sdk`, `@agent-relay/runtime`, `@agent-relay/cloud`).

## Install

```bash
npm install -g agent-relay
```

## Common commands

```bash
agent-relay status                 # workspace + cloud login + local broker
agent-relay mcp                    # MCP stdio server

agent-relay message post --channel general --text "hello"
agent-relay workspace list
```

## Local broker

The `local` command group manages the broker on your machine and the agents it runs:

```bash
agent-relay local up
agent-relay local status
agent-relay local down

agent-relay local agent new claude          # spawn + attach
agent-relay local agent list
agent-relay local agent attach <name> --mode view
agent-relay local agent release <name>
```

Hosted equivalents live under `agent-relay cloud …`.

## Packages

- `@agent-relay/sdk`: messaging, delivery contracts, and actions.
- `@agent-relay/runtime`: optional managed harness runtime.
- `agent-relay`: CLI and MCP entry point.
