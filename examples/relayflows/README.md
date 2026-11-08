# Running Relayflows from a relay checkout

You can run a Relayflow from a fresh clone of `AgentWorkforce/relay` without
installing `@relayflows/cli` globally. `npm ci` at the root of this repo
hoists the pinned `@relayflows/cli` binary into `node_modules/.bin/relayflows`,
and the top-level npm scripts dispatch to it.

## Prove it on a fresh checkout

```bash
git clone https://github.com/AgentWorkforce/relay
cd relay
npm ci
npm run relayflow:run examples/relayflows/hello.yaml
```

`hello.yaml` is a pipeline of three deterministic shell steps that chain
`{{steps.X.output}}` and exit non-zero if the expected marker is missing, so
the run finishes with exit code 0 without touching the network, spawning any
agent CLIs, or contacting a relay broker.

Passing arguments through `npm run` still works:

```bash
npm run relayflow -- run --dry-run examples/relayflows/hello.yaml
npm run relayflow:run -- --dry-run examples/relayflows/hello.yaml
```

## What runs under the hood

- `npm run relayflow` invokes `relayflows` from `node_modules/.bin/`.
- `npm run relayflow:run` invokes `relayflows run`, which in turn delegates to
  the `runWorkflow` / `runScriptWorkflow` entry points in `@relayflows/core`.

For workflows that run through the built-in `agent-relay local run` command
(broker-backed local run tracking, log file, sync command) use
`agent-relay local run <file>` after building the CLI. This npm-script
surface is intentionally the smaller, zero-broker path — it is the fastest way
to prove a workflow file locally before wiring it into your automation.
