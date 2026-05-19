The `agent-relay` CLI is the operational layer for local broker management, agent spawning, messaging, workflow execution, and cloud runs.

## Install

```bash
npm install -g agent-relay
agent-relay --help
agent-relay --version
```

## Main command groups

- Broker lifecycle: `up`, `status`, `down`, `update`, `uninstall`
- Agent management: `spawn`, `who`, `release`, `set-model`, `agents:logs`, `view`
- Messaging: `send`, `history`, `replies`, `inbox`
- Workflows: `run`, `workflows list`
- Cloud: `cloud login`, `cloud connect`, `cloud run`, `cloud status`, `cloud logs`, `cloud sync`
- Sandbox entry: `on`, `off`

## Typical local session

```bash
agent-relay up
agent-relay spawn reviewer claude "Review the latest auth changes"
agent-relay send reviewer "Start with the middleware and summarize risks."
agent-relay who
```

## Other useful commands

- `agent-relay telemetry status` shows whether anonymous telemetry is enabled.
- `agent-relay telemetry disable` turns telemetry off for the local machine.
