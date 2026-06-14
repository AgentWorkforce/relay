# Two-node fleet E2E (RFC #1056, Phase 6)

Boots a **real** stack and drives the fleet control wire end-to-end:

- a relaycast engine (node adapter, `relaycast-engine` serve bin),
- two `agent-relay fleet serve` nodes — each its own **Rust broker + TS sidecar**,
  with distinct + shared capability sets (`node-a`: `spawn:claude`, `spawn:pool`,
  `echo`, `work`; `node-b`: `spawn:codex`, `spawn:pool`, `ping`, `work`).

Unlike the unit suites (in-process adapter / fake broker WS), this exercises the
actual broker `node_control` connection, including the `Authorization: Bearer`
node-token handshake and the `agent.register` token-authority reply — the two
engine⇄broker mismatches this E2E surfaced (fixed in relaycast#194).

## Scenario matrix

| Scenario                | Asserts                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boot/register           | both nodes `online` + `handlers_live` via the real broker Bearer-header auth; correct capability objects                                                                                                                      |
| negative auth           | a node whose broker presents a bogus token never reaches `handlers_live` (auth is enforced)                                                                                                                                   |
| capability query        | `GET /v1/nodes?capability=` returns the right node(s), incl. a shared capability on both                                                                                                                                      |
| cross-node dispatch     | `echo`→node-a, `ping`→node-b each dispatch over the owning node's control connection and ack                                                                                                                                  |
| declarative trigger     | a `#general` `/deploy/` message fires the action exactly once; the action-generated reply does **not** re-trigger — asserted by counting the `echo:` **prefix** (a broken guard cascades to `echo:echo:…`, growing the total) |
| spawn completes E2E     | targeted spawn mints+injects the agent token, binds the agent via-node, and the node heartbeats the count up — the regression guard for the token-authority handshake                                                         |
| capability-routed spawn | with no target, placement picks the only node advertising the capability                                                                                                                                                      |
| scheduled spawn         | a shared-capability spawn routes to the least-loaded node (pre-loaded node is skipped)                                                                                                                                        |
| resume                  | a resumable spawn carries `session_ref`; after release, the resume re-targets the **origin** node                                                                                                                             |
| placement failure       | targeting a node that lacks the capability fails with `capability_mismatch` (409)                                                                                                                                             |
| reschedule + reconcile  | an in-flight invocation on a dying node reruns on the other eligible node; the node's `handlers_live` drops, the restart re-registers (inventory.sync), and dispatch stays idempotent                                         |
| mailbox TTL             | an undelivered message dead-letters after a short TTL (bounded durable mailbox)                                                                                                                                               |

### Coverage notes (intentionally not re-asserted here)

- **overflow reject-new** and **per-agent message seq/dedup**: need a recipient whose
  deliveries QUEUE (a via-node agent on a down node) AND whose delivery ledger is
  externally observable. The spawned agent's token is held by the broker, so it
  isn't; a self-connected recipient auto-delivers (never queues). Covered directly
  by the relaycast engine §8.3 mailbox conformance matrix.
- **self spawn** (`target: self`): needs a via-node agent as the _caller_; the E2E
  driver is self-connected. Covered by the engine placement conformance.
- The node-file `triggers: [...]` surface is **not** exercised — the sidecar's
  trigger auto-sync is not yet wired ("trigger sync skipped"), so the trigger is
  registered via the engine API. The firing + loop-guard behaviour is identical.
- A node that has spawned agents stops posting its **own** messages (a broker quirk),
  so the declarative-trigger scenario runs before the spawn scenarios. Noted for
  follow-up.

## Running locally

```bash
npm run build:core                                   # relay CLI + fleet + harness-driver
cargo build --release --bin agent-relay-broker       # broker
RELAYCAST_ENGINE_DIR=/path/to/relaycast \            # must carry relaycast#194's compat fixes
BROKER_BINARY_PATH="$PWD/target/release/agent-relay-broker" \
  npm run test:e2e
```

The suite **skips cleanly** (never fails) when prerequisites are missing — the
default `npm test` does not run it. The `Fleet E2E` GitHub Actions workflow
provisions the engine (pinned to the relaycast#194 SHA) + broker and runs the
full matrix; the matrix itself is ~30s, the wall-clock is build-dominated.

## Isolation notes

Each `fleet serve` runs in a hermetic env: all ambient `RELAY_*` / `AGENT_RELAY_*`
vars are stripped (so the broker never rejoins the operator's real workspace), with
its own `HOME`, project dir, state dir, and dashboard port. The broker reads its
node id from `<data_local_dir>/agent-relay/machine-id`, which the harness pre-seeds
to match the enrolled node id (otherwise `node.register` is rejected
`node_id_mismatch`). `FleetNode.stop()` kills the broker child too (by its
`connection.json` pid) so a SIGKILLed sidecar doesn't orphan a broker that would
hold the node online + the state-dir flock and break a later restart.
