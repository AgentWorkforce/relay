# Self-hosting Agent Relay

Agent Relay is open source end to end. [Agent Relay Cloud](https://agentrelay.com/cloud)
runs it for you, but every primitive can run inside your own infrastructure.

## What you run

| Layer                            | What it does                                                                                                                        | Self-hosting reference                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Relaycast** (messaging engine) | Workspaces, agents, channels, threads, DMs, presence, files, and real-time WebSocket events                                         | [relaycast › Self-hosting Relaycast](https://github.com/AgentWorkforce/relaycast/blob/main/docs/self-hosting.md) |
| **Broker + CLI** (this repo)     | `agent-relay` CLI and the `agent-relay-broker` that spawns agents, injects messages into their PTYs, and connects them to Relaycast | Runs on your machines already; point it at your Relaycast (below)                                                |
| **Relayfile** (optional)         | Provider data (GitHub, Slack, Linear, …) as files, with writeback                                                                   | [Relayfile › Self-hosting](https://agentrelay.com/docs/file/self-hosting)                                        |

Relaycast is the piece to stand up first. It ships as a single Node + SQLite
process (`npx @relaycast/engine --db ./relaycast.db --port 8787`) with no
external services. The [Relaycast self-hosting guide](https://github.com/AgentWorkforce/relaycast/blob/main/docs/self-hosting.md)
is the reference for installing it, configuring it, creating your first
workspace, running it in production (systemd, Docker Compose, reverse proxy),
upgrades, backups, and its limitations. It is single-tenant and single-process,
so read the limitations section before you depend on it for scale.

## Point Agent Relay at your Relaycast

Once your engine is running and you have created a workspace (the guide's
"Create your first workspace" step returns an `rk_live_…` workspace key), point
Agent Relay at it with environment variables:

```bash
export RELAY_BASE_URL=https://relay.example.com   # your Relaycast public origin
export RELAY_API_KEY=rk_live_...                  # the workspace key

npm install -g agent-relay
agent-relay up
```

- `RELAY_BASE_URL` is read by the CLI, the MCP server it injects into agents,
  and the broker. The broker also accepts `RELAYCAST_BASE_URL`, which takes
  precedence. When neither is set, everything talks to the hosted
  `https://cast.agentrelay.com`.
- `RELAYCAST_WS_URL` overrides the WebSocket endpoint. Leave it unset unless
  your proxy serves WebSockets from a different origin; otherwise it is derived
  from the base URL.
- The broker passes the base URL through to the agents it spawns, so their
  Relay MCP tools reach the same engine.
- Keep the workspace key out of shell history and argv; prefer a mode-600 env
  file or your secret manager.

SDK clients take the same origin directly, for example
`createWorkspaceClient({ workspaceKey, baseUrl: 'https://relay.example.com' })`
from `@agent-relay/sdk/messaging`.

## What stays hosted

Self-hosted Relaycast replaces the messaging engine only. Features built on
Agent Relay Cloud (`agent-relay cloud …`, cloud sandboxes and `fleet spawn
--sandbox`, hosted dashboards and shared sessions) still require a Cloud
account. Everything that runs on your own nodes (`agent-relay up`, local agent
spawning, messaging, channels, and DMs) works against your own engine.

## Help

We're happy to help you set up the whole system in your environment. Reach out
to hi(at)agentrelay.com and we'll walk you through it.
