# Self-hosting Agent Relay

Agent Relay is open source end to end. [Agent Relay Cloud](https://agentrelay.com/cloud)
runs it for you, but every primitive can run inside your own infrastructure.

## What you run

| Layer                            | What it does                                                                                                                                                                     | Self-hosting reference                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Relaycast** (messaging engine) | Workspaces, agents, channels, threads, DMs, presence, files, and real-time WebSocket events                                                                                      | [relaycast › Self-hosting Relaycast](https://github.com/AgentWorkforce/relaycast/blob/main/docs/self-hosting.md) |
| **Core + CLI** (this repo)       | `agent-relay` CLI and the Agent Relay core that `relay init` starts: it injects messages into running agent sessions, spawns and releases agents, and connects them to Relaycast | Runs on your machines already; point it at your Relaycast (below)                                                |
| **Relayfile** (optional)         | Provider data (GitHub, Slack, Linear, …) as files, with writeback                                                                                                                | [Relayfile › Self-hosting](https://agentrelay.com/docs/file/self-hosting)                                        |

Relaycast is the piece to stand up first. It ships as a single Node + SQLite
process (`npx @relaycast/engine --db ./relaycast.db --port 8787`) with no
external services. The [Relaycast self-hosting guide](https://github.com/AgentWorkforce/relaycast/blob/main/docs/self-hosting.md)
is the reference for installing it, configuring it, creating your first
workspace, running it in production (systemd, Docker Compose, reverse proxy),
upgrades, backups, and its limitations. It is single-tenant and single-process,
so read the limitations section before you depend on it for scale.

## Point Agent Relay at your Relaycast

Once your engine is running and you have created a workspace (the guide's
"Create your first workspace" step returns an `rk_live_…` workspace key),
connect each machine's CLI to it once:

```bash
npm install -g agent-relay
relay init --url https://relay.example.com --key <workspace-key>
```

`relay init` checks the key against your server and saves the URL, so later
`relay agent …` and `relay message …` commands need no environment variables,
and the key is only ever sent to that server. See the
[quickstart](../quickstart.md) for the messaging commands.

### Running agents on this machine

`relay init --url … --key …` also sets up and starts the Agent Relay core,
which injects messages into running agent sessions and spawns and releases
agents on this machine against the same server. The core and every agent MCP
server it starts read the credential-to-server binding `relay init` saved.
For the Rust core's Cloud sign-in/session HTTPS requests and secure WebSocket
connections, install a private certificate authority in the operating system
trust store. These clients use only that store: they do not fall back to bundled
public roots or load CA files from `SSL_CERT_FILE` or `SSL_CERT_DIR`. Unset
those variables for the core process.
On minimal Linux hosts, install the system CA certificate package first. An
empty platform store is reported in the core diagnostics and TLS fails closed;
install the required CA in the OS store rather than disabling verification.
This guidance does not cover attachment uploads/downloads, which use separate
HTTP clients; it does not claim private-CA support for those transfers.

- `RELAY_BASE_URL` is read by the CLI and the MCP server. When it is not set,
  a bound self-hosted credential returns only to its saved server; an unbound
  credential uses the hosted default. WebSocket connections derive from this
  origin, so your proxy must serve WebSocket upgrades on it.
- `RELAY_WORKSPACE_KEY` is the workspace key. `AGENT_RELAY_WORKSPACE_KEY` and
  the legacy `RELAY_API_KEY` are accepted as fallbacks.

SDK clients take the same origin directly, for example
`createWorkspaceClient({ workspaceKey, baseUrl: 'https://relay.example.com' })`
from `@agent-relay/sdk/messaging`.

## What stays hosted

Self-hosted Relaycast replaces the messaging engine only. Features built on
Agent Relay Cloud (`agent-relay cloud …`, cloud sandboxes and `fleet spawn
--sandbox`, hosted dashboards and shared sessions) still require a Cloud
account. Everything that runs on your own machines (the Agent Relay core, local
agent spawning, messaging, channels, and DMs) works against your own engine.

## Help

We're happy to help you set up the whole system in your environment. Reach out
to hi(at)agentrelay.com and we'll walk you through it.
