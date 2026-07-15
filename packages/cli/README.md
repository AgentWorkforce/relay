# agent-relay

A thin operator console for a local agent workforce: stand up the broker, staff it with off-the-shelf agent CLIs, and watch/steer them from the terminal. Each command is a shallow wrapper over a backing package (`@agent-relay/sdk`, `@agent-relay/harness-driver`, `@agent-relay/cloud`).

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

## This machine's node

The `node` command group manages the broker on your machine and the agents it runs:

```bash
agent-relay node up                          # serves an auto-discovered agent-relay.{ts,js,…} node file,
                                             # or the implicit local node from teams.json
agent-relay node up --config ./my-node.ts    # serve a specific defineNode(...) file
agent-relay node status
agent-relay node down

agent-relay node workflow run workflows/my-workflow.ts
agent-relay node workflow logs <run-id> --follow
agent-relay node workflow sync <run-id>

agent-relay node agent new claude            # spawn + attach
agent-relay node agent list
agent-relay node agent attach <name> --mode view
agent-relay node agent release <name>
```

To run as a Cloud-managed node, first redeem a one-time enrollment token, then start the node:

```bash
agent-relay cloud enroll --token ocl_node_enr_...
agent-relay node up
```

`local` remains as a deprecated hidden alias of `node` (it prints a one-time warning).

Node workflow runs use Relayflows for YAML, TypeScript, and Python workflow files.

Hosted equivalents live under `agent-relay cloud …`.

## Embedded node lifecycle

Long-lived Node.js hosts can start the same foreground broker lifecycle without
letting the CLI own `process.exit`, global signal handlers, `process.env`, or
console output:

```ts
import { startEmbeddedNode } from 'agent-relay/node-embedded';

const started = await startEmbeddedNode(
  { config: '/absolute/path/to/agent-relay.mjs' },
  { onOutput: ({ level, message }) => hostLogger[level](message) }
);
if (!started.ok) {
  throw new Error(started.message);
}

process.once('SIGTERM', () => void started.handle.stop('SIGTERM'));
await started.handle.completion;
```

The host owns signal forwarding and calls the idempotent `handle.stop()` when
it wants Relay to shut down. Embedded startup is foreground-only;
`background: true` returns a structured code-2 failure because detached mode
belongs to the process-oriented CLI. Use `downEmbeddedNode` and
`statusEmbeddedNode` when controlling a broker through its persisted state.
When `runtime.env` is supplied, that cloned environment is authoritative for
broker binary lookup, state lookup, and the spawned broker process.
`onOutput` streams every entry; returned result snapshots retain the most recent
1,000 entries so a long-lived host does not accumulate an unbounded log array.

## Packages

- `@agent-relay/sdk`: messaging, delivery contracts, and actions.
- `@agent-relay/harness-driver`: optional managed harness runtime.
- `agent-relay`: CLI and MCP entry point.
