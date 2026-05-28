# @agent-relay/event-bridge

Connect a **long-lived on-relay agent** to **inbound integration webhook events**
(Slack today; Linear, Notion, … next) and relay its replies back out — without
giving the agent an MCP server, a mount, or any credentials.

## How it works

```
Slack webhook ─▶ relayfile (/slack/** file change)
             ─▶ relay gateway ─▶ event-bridge ─▶ broker /api/send ─▶ agent (just another turn)
agent writes ./outbox/<id>.md ─▶ event-bridge ─▶ gateway writeFile ─▶ relayfile Slack writeback ─▶ Slack
```

- **Inbound:** the bridge subscribes to the relay gateway and watches each
  provider's VFS paths. For an actionable change (e.g. a new Slack message) it
  injects a nudge into the target agent that includes the message and the
  outbox path to reply to.
- **Outbound:** the agent writes its reply as plain text to
  `./outbox/<replyId>.md` using its native file-write tool. The bridge relays
  that file through the gateway as a relayfile write to the provider's
  writeback path, which posts it back to the source. An empty file = stay
  silent.

The agent needs nothing but a file-write tool. All provider knowledge (inbound
paths, writeback paths, content format, loop-prevention) lives in the bridge's
provider adapters.

## Run

The bridge bootstraps from cloud using your stored login — so you reuse the
deployed cloud and run nothing locally. It resolves the deployed gateway URL
(`GET /api/v1/workspaces/<ws>/agent-events`) and provisions a token scoped to
your providers' roots (e.g. `/slack/**`, via `POST /api/v1/agents/provision`):

```bash
agent-relay login                       # once — stores your cloud session
npx agent-relay-event-bridge --workspace <id|name> --agent lead --providers slack
```

It still connects to a **local broker** via `.agent-relay/connection.json` for
injection (set `--broker-url` / `RELAY_BROKER_URL` for a remote broker).

To skip the bootstrap and pass the gateway yourself, provide both
`--gateway-url` + `--api-key` (or `RELAY_GATEWAY_URL` + `RELAY_API_KEY`), or pass
`--no-bootstrap` to require them.

### Local loop test (no cloud, no Slack)

```bash
agent-relay up && agent-relay spawn claude --name lead
node packages/event-bridge/dist/simulate.js --agent lead --text "deploy staging"
```

Injects a synthetic Slack message into the real agent and prints the would-be
Slack post when it replies to the outbox.

### Environment / flags

| Flag / env                                   | Required | Default      | Meaning                               |
| -------------------------------------------- | -------- | ------------ | ------------------------------------- |
| `--workspace` / `RELAY_WORKSPACE`            | yes      | —            | Workspace id or name                  |
| `--agent` / `EVENT_BRIDGE_AGENT`             | yes      | —            | On-relay agent name to inject into    |
| `--providers` / `EVENT_BRIDGE_PROVIDERS`     | no       | `slack`      | Comma-separated providers             |
| `--outbox` / `EVENT_BRIDGE_OUTBOX`           | no       | `./outbox`   | Reply-file directory                  |
| `--api-url` / `CLOUD_API_URL`                | no       | stored login | Cloud base URL for bootstrap          |
| `--gateway-url` / `RELAY_GATEWAY_URL`        | no       | bootstrap    | Gateway WS URL (skips bootstrap)      |
| `--api-key` / `RELAY_API_KEY`                | no       | bootstrap    | Scoped token (skips bootstrap)        |
| `--broker-url` / `RELAY_BROKER_URL`          | no       | local broker | Remote broker base URL                |
| `RELAY_BROKER_CWD`                           | no       | `cwd`        | Where to find `connection.json`       |
| `--inject-mode` / `EVENT_BRIDGE_INJECT_MODE` | no       | `wait`       | `wait` queues; `steer` interrupts     |
| `--no-bootstrap`                             | no       | —            | Require `--gateway-url` + `--api-key` |

## Adding a provider

Implement `ProviderAdapter` (see `src/providers/slack.ts`) — declare the watch
globs, decide which changes are actionable in `resolveInbound`, and return the
reply path + a `serializeReply` for the provider's writeback. Register it in
`src/providers/index.ts`.
