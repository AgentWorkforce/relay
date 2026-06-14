# Two-node fleet E2E (RFC #1056, Phase 6)

Boots a **real** stack and drives the fleet control wire end-to-end:

- a relaycast engine (node adapter, `relaycast-engine` serve bin),
- two `agent-relay fleet serve` nodes — each its own **Rust broker + TS sidecar**,
  with distinct capability sets (`node-a`: `spawn:claude` + `echo`; `node-b`:
  `spawn:codex` + `ping`).

Unlike the unit suites (which use the in-process adapter / a fake broker WS), this
exercises the actual broker `node_control` connection — including the
`Authorization: Bearer` node-token handshake that shipped mismatched between the
broker and engine and is now guarded here.

## Scenario matrix

| Scenario | Asserts |
|---|---|
| boot/register | both nodes reach `online` + `handlers_live` via the real broker Bearer-header auth; capability objects are correct |
| capability query | `GET /v1/nodes?capability=` returns the right node |
| cross-node dispatch | `echo`→node-a and `ping`→node-b each dispatch over the owning node's control connection and ack the result |
| declarative trigger | a `#general` message matching `/deploy/` fires the action exactly once; the action-generated reply (flagged `action_generated`) does **not** re-trigger (loop guard) |
| sidecar crash | killing a node drops `handlers_live`; restart restores it and dispatch still lands on it |
| spawn placement | targeted spawn routes to the named node; capability-routed spawn routes to the only eligible node; an unsatisfiable capability fails cleanly |

Full agent bring-up (a spawned PTY child connecting back) needs a real connecting
harness and is covered by the relaycast engine conformance suite; here the stub
spawn harness (`sleep`) lets us assert **placement** without a real AI CLI.

## Running locally

```bash
# 1. Build the relay CLI + fleet + harness-driver
npm run build:core
# 2. Build the broker
cargo build --release --bin agent-relay-broker
# 3. Point at a built relaycast engine (feat/fleet-mailbox or a descendant)
RELAYCAST_ENGINE_DIR=/path/to/relaycast \
BROKER_BINARY_PATH="$PWD/target/release/agent-relay-broker" \
  npm run test:e2e
```

The suite **skips cleanly** (never fails) when prerequisites are missing — the
default `npm test` does not run it. The `Fleet E2E` GitHub Actions workflow
provisions the engine + broker and runs the full matrix.

## Isolation notes

Each `fleet serve` runs in a hermetic env: all ambient `RELAY_*` / `AGENT_RELAY_*`
vars are stripped (so the broker never rejoins the operator's real workspace), with
its own `HOME`, project dir, state dir, and dashboard port. The broker reads its
node id from `<data_local_dir>/agent-relay/machine-id`, which the harness pre-seeds
to match the enrolled node id (otherwise `node.register` is rejected
`node_id_mismatch` and capability→action binding never happens).
